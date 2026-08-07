const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret = process.env.JWT_SECRET;

function getDb() {
  if (!supabaseUrl || !supabaseSecret || !jwtSecret) {
    throw new Error('Server environment variables are incomplete.');
  }
  return createClient(supabaseUrl, supabaseSecret, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function send(res, status, body) {
  res.status(status).json(body);
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validTime(value) {
  return value === null || value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function authHeader(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function signToken(member) {
  return jwt.sign(
    { sub: member.id, companyId: member.company_id, role: member.role, employeeId: member.employee_id },
    jwtSecret,
    { expiresIn: '7d', issuer: 'team-task-tracker' }
  );
}

async function getActor(req, db) {
  const token = authHeader(req);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret, { issuer: 'team-task-tracker' });
  } catch {
    return null;
  }
  const { data, error } = await db
    .from('members')
    .select('id,company_id,employee_id,name,email,role,manager_id,active')
    .eq('id', payload.sub)
    .eq('active', true)
    .single();
  return error ? null : data;
}

function publicMember(member) {
  if (!member) return null;
  return {
    id: member.id,
    companyId: member.company_id,
    employeeId: member.employee_id,
    name: member.name,
    email: member.email,
    role: member.role,
    managerId: member.manager_id,
    active: member.active,
    createdAt: member.created_at
  };
}

async function allowedMemberIds(db, actor) {
  if (actor.role === 'owner') {
    const { data, error } = await db.from('members').select('id').eq('company_id', actor.company_id).eq('active', true);
    if (error) throw error;
    return data.map(row => row.id);
  }
  if (actor.role === 'manager') {
    const { data, error } = await db
      .from('members')
      .select('id')
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .or(`id.eq.${actor.id},manager_id.eq.${actor.id}`);
    if (error) throw error;
    return data.map(row => row.id);
  }
  return [actor.id];
}

async function canAccessMember(db, actor, memberId) {
  const ids = await allowedMemberIds(db, actor);
  return ids.includes(memberId);
}

async function canAssignTo(db, actor, memberId) {
  if (actor.role === 'owner') return canAccessMember(db, actor, memberId);
  if (actor.role === 'manager') return canAccessMember(db, actor, memberId);
  return actor.id === memberId;
}

async function nextEmployeeId(db, companyId, role) {
  const prefix = role === 'manager' ? 'MGR' : 'EMP';
  const { data, error } = await db
    .from('members')
    .select('employee_id')
    .eq('company_id', companyId)
    .ilike('employee_id', `${prefix}-%`);
  if (error) throw error;
  let max = 0;
  for (const row of data) {
    const number = Number(String(row.employee_id).split('-')[1]);
    if (Number.isFinite(number)) max = Math.max(max, number);
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

async function notify(db, { companyId, recipientId, senderId, type = 'system', message, taskId = null }) {
  const { error } = await db.from('notifications').insert({
    company_id: companyId,
    recipient_id: recipientId,
    sender_id: senderId,
    type,
    message,
    task_id: taskId
  });
  if (error) throw error;
}

async function getCompany(db, companyId) {
  const { data, error } = await db.from('companies').select('*').eq('id', companyId).single();
  if (error) throw error;
  return data;
}

async function sheetPost(url, payload) {
  if (!url) return { skipped: true };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    const text = await response.text();
    return { ok: response.ok, text: text.slice(0, 300) };
  } catch (error) {
    console.error('Google Sheet sync failed:', error);
    return { ok: false, error: String(error) };
  }
}

async function taskSheetRow(db, taskId) {
  const { data: task, error } = await db
    .from('tasks')
    .select('id,company_id,member_id,assigned_by,title,task_date,hours,status,notes,updated_at')
    .eq('id', taskId)
    .single();
  if (error) throw error;

  const [{ data: member }, { data: assigner }, { data: attendance }, company] = await Promise.all([
    db.from('members').select('employee_id,name,role').eq('id', task.member_id).single(),
    db.from('members').select('name').eq('id', task.assigned_by).single(),
    db.from('attendance').select('login_time,logout_time,finished_at').eq('member_id', task.member_id).eq('work_date', task.task_date).maybeSingle(),
    getCompany(db, task.company_id)
  ]);

  return {
    company,
    row: {
      taskId: task.id,
      date: task.task_date,
      employeeId: member?.employee_id || '',
      employeeName: member?.name || '',
      role: member?.role || '',
      task: task.title,
      hours: Number(task.hours || 0),
      status: task.status,
      notes: task.notes || '',
      assignedBy: assigner?.name || '',
      loginTime: attendance?.login_time ? String(attendance.login_time).slice(0, 5) : '',
      logoutTime: attendance?.logout_time ? String(attendance.logout_time).slice(0, 5) : '',
      finishedDay: Boolean(attendance?.finished_at),
      updatedAt: task.updated_at
    }
  };
}

async function syncTask(db, taskId) {
  const { company, row } = await taskSheetRow(db, taskId);
  return sheetPost(company.sheet_webhook_url, { action: 'upsertTask', row });
}

async function syncMemberDay(db, companyId, memberId, date) {
  const { data: tasks, error } = await db
    .from('tasks')
    .select('id')
    .eq('company_id', companyId)
    .eq('member_id', memberId)
    .eq('task_date', date);
  if (error) throw error;
  await Promise.all(tasks.map(task => syncTask(db, task.id)));
}

async function handleLogin(req, res, db) {
  const employeeId = cleanText(req.body?.employeeId, 40).toUpperCase();
  const pin = cleanText(req.body?.pin, 12);
  if (!employeeId || !/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'Enter a valid Employee ID and PIN.' });

  const { data: member, error } = await db
    .from('members')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('active', true)
    .maybeSingle();
  if (error || !member) return send(res, 401, { error: 'Invalid Employee ID or PIN.' });

  const valid = await bcrypt.compare(pin, member.pin_hash);
  if (!valid) return send(res, 401, { error: 'Invalid Employee ID or PIN.' });

  const company = await getCompany(db, member.company_id);
  return send(res, 200, { token: signToken(member), user: publicMember(member), company });
}

async function handleBootstrap(res, db, actor) {
  const memberIds = await allowedMemberIds(db, actor);
  const company = await getCompany(db, actor.company_id);

  const [membersResult, tasksResult, attendanceResult, notificationsResult] = await Promise.all([
    db.from('members')
      .select('id,company_id,employee_id,name,email,role,manager_id,active,created_at')
      .eq('company_id', actor.company_id)
      .in('id', memberIds)
      .order('created_at'),
    db.from('tasks')
      .select('id,company_id,member_id,assigned_by,title,task_date,hours,status,notes,created_at,updated_at')
      .eq('company_id', actor.company_id)
      .in('member_id', memberIds)
      .order('task_date', { ascending: false })
      .order('created_at', { ascending: false }),
    db.from('attendance')
      .select('id,company_id,member_id,work_date,login_time,logout_time,finished_at,created_at,updated_at')
      .eq('company_id', actor.company_id)
      .in('member_id', memberIds)
      .order('work_date', { ascending: false }),
    db.from('notifications')
      .select('id,recipient_id,sender_id,type,message,task_id,read_at,created_at')
      .eq('recipient_id', actor.id)
      .order('created_at', { ascending: false })
      .limit(50)
  ]);

  for (const result of [membersResult, tasksResult, attendanceResult, notificationsResult]) {
    if (result.error) throw result.error;
  }

  return send(res, 200, {
    user: publicMember(actor),
    company,
    members: membersResult.data.map(publicMember),
    tasks: tasksResult.data.map(task => ({
      id: task.id,
      companyId: task.company_id,
      memberId: task.member_id,
      assignedBy: task.assigned_by,
      title: task.title,
      taskDate: task.task_date,
      hours: Number(task.hours || 0),
      status: task.status,
      notes: task.notes,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    })),
    attendance: attendanceResult.data.map(row => ({
      id: row.id,
      companyId: row.company_id,
      memberId: row.member_id,
      workDate: row.work_date,
      loginTime: row.login_time ? String(row.login_time).slice(0, 5) : '',
      logoutTime: row.logout_time ? String(row.logout_time).slice(0, 5) : '',
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    notifications: notificationsResult.data.map(row => ({
      id: row.id,
      recipientId: row.recipient_id,
      senderId: row.sender_id,
      type: row.type,
      message: row.message,
      taskId: row.task_id,
      readAt: row.read_at,
      createdAt: row.created_at
    }))
  });
}

async function handleCreateMember(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can add members.' });
  const name = cleanText(req.body?.name, 100);
  const email = cleanText(req.body?.email, 160);
  const role = cleanText(req.body?.role, 20).toLowerCase();
  const pin = cleanText(req.body?.pin, 12);
  let employeeId = cleanText(req.body?.employeeId, 40).toUpperCase();
  const managerId = cleanText(req.body?.managerId, 60) || null;

  if (!name) return send(res, 400, { error: 'Member name is required.' });
  if (!['manager', 'sales'].includes(role)) return send(res, 400, { error: 'Role must be Manager or Sales.' });
  if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'PIN must contain 4–8 digits.' });
  if (!employeeId) employeeId = await nextEmployeeId(db, actor.company_id, role);
  if (!/^[A-Z0-9-]{3,40}$/.test(employeeId)) return send(res, 400, { error: 'Employee ID can use letters, numbers, and hyphens.' });

  if (managerId) {
    const { data: manager } = await db
      .from('members')
      .select('id,role')
      .eq('id', managerId)
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .maybeSingle();
    if (!manager || manager.role !== 'manager') return send(res, 400, { error: 'Select a valid Manager.' });
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const { data, error } = await db.from('members').insert({
    company_id: actor.company_id,
    employee_id: employeeId,
    pin_hash: pinHash,
    name,
    email,
    role,
    manager_id: role === 'sales' ? managerId : null
  }).select('id,company_id,employee_id,name,email,role,manager_id,active,created_at').single();

  if (error) {
    if (error.code === '23505') return send(res, 409, { error: 'That Employee ID already exists.' });
    throw error;
  }
  await notify(db, {
    companyId: actor.company_id,
    recipientId: data.id,
    senderId: actor.id,
    type: 'system',
    message: `Welcome to the team, ${data.name}.`
  });
  return send(res, 201, { member: publicMember(data) });
}

async function handleUpdateMember(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can update members.' });
  const id = cleanText(req.body?.id, 60);
  if (!id || id === actor.id) return send(res, 400, { error: 'This member cannot be changed here.' });

  const patch = {};
  if (req.body?.name !== undefined) patch.name = cleanText(req.body.name, 100);
  if (req.body?.email !== undefined) patch.email = cleanText(req.body.email, 160);
  if (req.body?.managerId !== undefined) patch.manager_id = cleanText(req.body.managerId, 60) || null;
  if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body?.pin) {
    const pin = cleanText(req.body.pin, 12);
    if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'PIN must contain 4–8 digits.' });
    patch.pin_hash = await bcrypt.hash(pin, 10);
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('members')
    .update(patch)
    .eq('id', id)
    .eq('company_id', actor.company_id)
    .select('id,company_id,employee_id,name,email,role,manager_id,active,created_at')
    .single();
  if (error) throw error;
  return send(res, 200, { member: publicMember(data) });
}


async function handleSelfPin(req, res, db, actor) {
  const currentPin = cleanText(req.body?.currentPin, 12);
  const newPin = cleanText(req.body?.newPin, 12);
  if (!/^\d{4,8}$/.test(currentPin) || !/^\d{4,8}$/.test(newPin)) {
    return send(res, 400, { error: 'Both PINs must contain 4–8 digits.' });
  }
  const { data: member, error: readError } = await db.from('members').select('pin_hash').eq('id', actor.id).single();
  if (readError || !member || !(await bcrypt.compare(currentPin, member.pin_hash))) {
    return send(res, 401, { error: 'Current PIN is incorrect.' });
  }
  const pinHash = await bcrypt.hash(newPin, 10);
  const { error } = await db.from('members').update({ pin_hash: pinHash, updated_at: new Date().toISOString() }).eq('id', actor.id);
  if (error) throw error;
  return send(res, 200, { ok: true });
}

async function handleCreateTask(req, res, db, actor) {
  const memberId = cleanText(req.body?.memberId, 60) || actor.id;
  const title = cleanText(req.body?.title, 240);
  const date = cleanText(req.body?.taskDate, 10);
  const hours = Number(req.body?.hours);
  const status = cleanText(req.body?.status, 30) || 'Pending';
  const notes = cleanText(req.body?.notes, 1500);

  if (!(await canAssignTo(db, actor, memberId))) return send(res, 403, { error: 'You cannot assign a task to this member.' });
  if (!title) return send(res, 400, { error: 'Task name is required.' });
  if (!validDate(date)) return send(res, 400, { error: 'Choose a valid task date.' });
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return send(res, 400, { error: 'Hours must be between 0 and 24.' });
  if (!['Pending','In Progress','Completed','On Hold','Review'].includes(status)) return send(res, 400, { error: 'Invalid task status.' });

  const { data: attendance } = await db
    .from('attendance')
    .select('finished_at')
    .eq('member_id', memberId)
    .eq('work_date', date)
    .maybeSingle();
  if (attendance?.finished_at && actor.role === 'sales') return send(res, 409, { error: 'That work day has already been finished.' });

  const { data, error } = await db.from('tasks').insert({
    company_id: actor.company_id,
    member_id: memberId,
    assigned_by: actor.id,
    title,
    task_date: date,
    hours,
    status,
    notes
  }).select('*').single();
  if (error) throw error;

  if (memberId !== actor.id) {
    await notify(db, {
      companyId: actor.company_id,
      recipientId: memberId,
      senderId: actor.id,
      type: 'task',
      taskId: data.id,
      message: `${actor.name} assigned you: ${title}`
    });
  }
  await syncTask(db, data.id);
  return send(res, 201, { task: data });
}

async function getTask(db, actor, taskId) {
  const { data, error } = await db.from('tasks').select('*').eq('id', taskId).eq('company_id', actor.company_id).maybeSingle();
  if (error || !data) return null;
  if (!(await canAccessMember(db, actor, data.member_id))) return null;
  return data;
}

async function handleUpdateTask(req, res, db, actor) {
  const id = cleanText(req.body?.id, 60);
  const existing = await getTask(db, actor, id);
  if (!existing) return send(res, 404, { error: 'Task not found.' });

  if (actor.role === 'sales' && existing.member_id !== actor.id) return send(res, 403, { error: 'You cannot edit this task.' });

  const patch = { updated_at: new Date().toISOString() };
  if (req.body?.title !== undefined) {
    patch.title = cleanText(req.body.title, 240);
    if (!patch.title) return send(res, 400, { error: 'Task name is required.' });
  }
  if (req.body?.hours !== undefined) {
    patch.hours = Number(req.body.hours);
    if (!Number.isFinite(patch.hours) || patch.hours < 0 || patch.hours > 24) return send(res, 400, { error: 'Hours must be between 0 and 24.' });
  }
  if (req.body?.status !== undefined) {
    patch.status = cleanText(req.body.status, 30);
    if (!['Pending','In Progress','Completed','On Hold','Review'].includes(patch.status)) return send(res, 400, { error: 'Invalid task status.' });
  }
  if (req.body?.notes !== undefined) patch.notes = cleanText(req.body.notes, 1500);
  if (req.body?.taskDate !== undefined) {
    patch.task_date = cleanText(req.body.taskDate, 10);
    if (!validDate(patch.task_date)) return send(res, 400, { error: 'Choose a valid task date.' });
  }

  const { data, error } = await db.from('tasks').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  await syncTask(db, id);
  return send(res, 200, { task: data });
}

async function handleDeleteTask(req, res, db, actor) {
  const id = cleanText(req.body?.id, 60);
  const existing = await getTask(db, actor, id);
  if (!existing) return send(res, 404, { error: 'Task not found.' });
  if (actor.role === 'sales' && existing.assigned_by !== actor.id) return send(res, 403, { error: 'You cannot delete a task assigned by someone else.' });

  const company = await getCompany(db, actor.company_id);
  const { error } = await db.from('tasks').delete().eq('id', id);
  if (error) throw error;
  await sheetPost(company.sheet_webhook_url, { action: 'deleteTask', taskId: id });
  return send(res, 200, { ok: true });
}

async function handleAttendance(req, res, db, actor) {
  const memberId = cleanText(req.body?.memberId, 60) || actor.id;
  const workDate = cleanText(req.body?.workDate, 10);
  const loginTime = req.body?.loginTime === undefined ? undefined : cleanText(req.body.loginTime, 5);
  const logoutTime = req.body?.logoutTime === undefined ? undefined : cleanText(req.body.logoutTime, 5);

  if (!(await canAccessMember(db, actor, memberId))) return send(res, 403, { error: 'You cannot change this attendance.' });
  if (actor.role === 'sales' && memberId !== actor.id) return send(res, 403, { error: 'You can only update your own attendance.' });
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid work date.' });
  if (loginTime !== undefined && !validTime(loginTime)) return send(res, 400, { error: 'Invalid login time.' });
  if (logoutTime !== undefined && !validTime(logoutTime)) return send(res, 400, { error: 'Invalid logout time.' });

  const values = {
    company_id: actor.company_id,
    member_id: memberId,
    work_date: workDate,
    updated_at: new Date().toISOString()
  };
  if (loginTime !== undefined) values.login_time = loginTime || null;
  if (logoutTime !== undefined) values.logout_time = logoutTime || null;

  const { data, error } = await db
    .from('attendance')
    .upsert(values, { onConflict: 'member_id,work_date' })
    .select('*')
    .single();
  if (error) throw error;

  await syncMemberDay(db, actor.company_id, memberId, workDate);
  return send(res, 200, { attendance: data });
}

async function handleFinishDay(req, res, db, actor) {
  const memberId = cleanText(req.body?.memberId, 60) || actor.id;
  const workDate = cleanText(req.body?.workDate, 10);
  if (!(await canAccessMember(db, actor, memberId))) return send(res, 403, { error: 'You cannot finish this member’s day.' });
  if (actor.role === 'sales' && memberId !== actor.id) return send(res, 403, { error: 'You can only finish your own day.' });
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid work date.' });

  const { data: current } = await db
    .from('attendance')
    .select('*')
    .eq('member_id', memberId)
    .eq('work_date', workDate)
    .maybeSingle();
  if (!current?.login_time || !current?.logout_time) return send(res, 400, { error: 'Select and save both login and logout times first.' });

  const finishedAt = new Date().toISOString();
  const { data, error } = await db
    .from('attendance')
    .upsert({
      company_id: actor.company_id,
      member_id: memberId,
      work_date: workDate,
      login_time: current.login_time,
      logout_time: current.logout_time,
      finished_at: finishedAt,
      updated_at: finishedAt
    }, { onConflict: 'member_id,work_date' })
    .select('*')
    .single();
  if (error) throw error;

  await syncMemberDay(db, actor.company_id, memberId, workDate);
  return send(res, 200, { attendance: data });
}

async function handleRing(req, res, db, actor) {
  let recipientId = cleanText(req.body?.recipientId, 60);
  const message = cleanText(req.body?.message, 400) || `${actor.name} is ringing you.`;

  if (actor.role === 'sales') {
    const { data: owner } = await db
      .from('members')
      .select('id')
      .eq('company_id', actor.company_id)
      .eq('role', 'owner')
      .eq('active', true)
      .single();
    recipientId = owner.id;
  } else if (!(await canAccessMember(db, actor, recipientId)) || recipientId === actor.id) {
    return send(res, 403, { error: 'You cannot ring this person.' });
  }

  await notify(db, {
    companyId: actor.company_id,
    recipientId,
    senderId: actor.id,
    type: 'ring',
    message
  });
  return send(res, 201, { ok: true });
}

async function handleReadNotifications(req, res, db, actor) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => cleanText(id, 60)).filter(Boolean) : [];
  let query = db.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', actor.id);
  if (ids.length) query = query.in('id', ids);
  else query = query.is('read_at', null);
  const { error } = await query;
  if (error) throw error;
  return send(res, 200, { ok: true });
}

async function handleCompanySettings(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can change company settings.' });
  const patch = { updated_at: new Date().toISOString() };
  if (req.body?.name !== undefined) patch.name = cleanText(req.body.name, 120) || 'My Company';
  if (req.body?.tagline !== undefined) patch.tagline = cleanText(req.body.tagline, 180);
  if (req.body?.primaryColor !== undefined) patch.primary_color = cleanText(req.body.primaryColor, 20);
  if (req.body?.headerColor !== undefined) patch.header_color = cleanText(req.body.headerColor, 20);
  if (req.body?.headerColor2 !== undefined) patch.header_color_2 = cleanText(req.body.headerColor2, 20);
  if (req.body?.sheetWebhookUrl !== undefined) {
    const url = cleanText(req.body.sheetWebhookUrl, 1000);
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      return send(res, 400, { error: 'Paste the deployed Google Apps Script /exec URL.' });
    }
    patch.sheet_webhook_url = url;
  }
  if (req.body?.logoDataUrl !== undefined) {
    const logo = String(req.body.logoDataUrl || '');
    if (logo && (!logo.startsWith('data:image/') || logo.length > 900000)) {
      return send(res, 400, { error: 'Use a PNG/JPG/SVG logo smaller than about 650 KB.' });
    }
    patch.logo_data_url = logo;
  }

  const { data, error } = await db.from('companies').update(patch).eq('id', actor.company_id).select('*').single();
  if (error) throw error;
  return send(res, 200, { company: data });
}

async function handleTestSheet(res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can test the Sheet connection.' });
  const company = await getCompany(db, actor.company_id);
  if (!company.sheet_webhook_url) return send(res, 400, { error: 'Save the Google Apps Script URL first.' });
  const result = await sheetPost(company.sheet_webhook_url, { action: 'test' });
  if (!result.ok) return send(res, 502, { error: 'The Google Sheet connector did not respond successfully.', detail: result });
  return send(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

  const action = cleanText(req.query?.action || req.body?.action, 60);
  let db;
  try {
    db = getDb();
    if (action === 'login' && req.method === 'POST') return await handleLogin(req, res, db);

    const actor = await getActor(req, db);
    if (!actor) return send(res, 401, { error: 'Your login has expired. Please sign in again.' });

    if (action === 'bootstrap' && req.method === 'GET') return await handleBootstrap(res, db, actor);
    if (action === 'member.create' && req.method === 'POST') return await handleCreateMember(req, res, db, actor);
    if (action === 'member.update' && req.method === 'PATCH') return await handleUpdateMember(req, res, db, actor);
    if (action === 'member.selfPin' && req.method === 'PATCH') return await handleSelfPin(req, res, db, actor);
    if (action === 'task.create' && req.method === 'POST') return await handleCreateTask(req, res, db, actor);
    if (action === 'task.update' && req.method === 'PATCH') return await handleUpdateTask(req, res, db, actor);
    if (action === 'task.delete' && req.method === 'DELETE') return await handleDeleteTask(req, res, db, actor);
    if (action === 'attendance.save' && req.method === 'POST') return await handleAttendance(req, res, db, actor);
    if (action === 'day.finish' && req.method === 'POST') return await handleFinishDay(req, res, db, actor);
    if (action === 'ring' && req.method === 'POST') return await handleRing(req, res, db, actor);
    if (action === 'notifications.read' && req.method === 'POST') return await handleReadNotifications(req, res, db, actor);
    if (action === 'company.update' && req.method === 'PATCH') return await handleCompanySettings(req, res, db, actor);
    if (action === 'sheet.test' && req.method === 'POST') return await handleTestSheet(res, db, actor);

    return send(res, 404, { error: 'Unknown API action.' });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: 'Server error. Check Vercel Function Logs.', detail: process.env.NODE_ENV === 'development' ? String(error) : undefined });
  }
};
