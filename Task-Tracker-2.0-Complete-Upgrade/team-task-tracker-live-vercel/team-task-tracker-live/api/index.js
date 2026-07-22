const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabaseSecret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
const jwtSecret = String(process.env.JWT_SECRET || '').trim();
const appsScriptSharedSecret = String(process.env.APPS_SCRIPT_SHARED_SECRET || '').trim();

function getDb() {
  if (!supabaseUrl || !supabaseSecret || !jwtSecret) {
    throw new Error('Server environment variables are incomplete.');
  }
  return createClient(supabaseUrl, supabaseSecret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
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

function dateToUtc(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value, amount) {
  const date = dateToUtc(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function isSunday(value) {
  return validDate(value) && dateToUtc(value).getUTCDay() === 0;
}

function nextWorkingDate(value) {
  let cursor = addDays(value, 1);
  while (isSunday(cursor)) cursor = addDays(cursor, 1);
  return cursor;
}

function dateInTimeZone(timeZone = 'Asia/Karachi', now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function restrictedDailyRole(role) {
  return role === 'sales' || role === 'developer';
}

function validTime(value) {
  return value === null || value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function validEmail(value) {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
}

function roleLabel(role) {
  const labels = {
    owner: 'Owner',
    manager: 'Operational Manager',
    sales: 'Sales Team',
    developer: 'Developer'
  };
  return labels[role] || String(role || 'Team Member');
}

function priorityLimit(priority) {
  return ({ High: 1, Medium: 3, Low: 5 })[priority] || 0;
}

function durationFromBody(body = {}, fallbackHours = null) {
  const hasSplitDuration = body.durationHours !== undefined || body.durationMinutes !== undefined;
  if (!hasSplitDuration) {
    const legacyHours = Number(body.hours ?? fallbackHours);
    if (!Number.isFinite(legacyHours) || legacyHours <= 0 || legacyHours > 24) {
      return { error: 'Choose a task duration between 15 minutes and 24 hours.' };
    }
    const totalMinutes = Math.round(legacyHours * 60);
    return {
      hoursDecimal: totalMinutes / 60,
      durationHours: Math.floor(totalMinutes / 60),
      durationMinutes: totalMinutes % 60
    };
  }

  const durationHours = Number(body.durationHours ?? 0);
  const durationMinutes = Number(body.durationMinutes ?? 0);
  if (!Number.isInteger(durationHours) || durationHours < 0 || durationHours > 24) {
    return { error: 'Choose hours from 0 to 24.' };
  }
  if (![0, 15, 30, 45].includes(durationMinutes)) {
    return { error: 'Choose minutes as 0, 15, 30, or 45.' };
  }
  const totalMinutes = durationHours * 60 + durationMinutes;
  if (totalMinutes < 15 || totalMinutes > 24 * 60) {
    return { error: 'Choose a task duration between 15 minutes and 24 hours.' };
  }
  return {
    hoursDecimal: totalMinutes / 60,
    durationHours,
    durationMinutes
  };
}

function durationLabel(hoursDecimal) {
  const totalMinutes = Math.round(Number(hoursDecimal || 0) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes) parts.push(`${minutes} minutes`);
  return parts.join(' ') || '0 minutes';
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
    .select('id,company_id,employee_id,name,email,role,manager_id,active,work_start_date,created_at')
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
    workStartDate: member.work_start_date,
    createdAt: member.created_at
  };
}


async function allowedMemberIds(db, actor) {
  if (actor.role === 'owner') {
    const { data, error } = await db
      .from('members')
      .select('id')
      .eq('company_id', actor.company_id)
      .eq('active', true);
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
  const prefixes = {
    manager: 'MGR',
    sales: 'SAL',
    developer: 'DEV'
  };
  const prefix = prefixes[role] || 'EMP';
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


async function getWorkGate(db, member, company) {
  const timezone = cleanText(company?.work_timezone, 80) || 'Asia/Karachi';
  const today = dateInTimeZone(timezone);
  const restricted = restrictedDailyRole(member?.role);

  if (!restricted) {
    return {
      restricted: false,
      timezone,
      today,
      canWork: true,
      requiredDate: today,
      openDate: today,
      backlog: false,
      status: 'unrestricted',
      message: 'Owner and Operational Manager accounts are not restricted by the daily lock.'
    };
  }

  let startDate = cleanText(member?.work_start_date, 10) || cleanText(member?.created_at, 10) || today;
  if (!validDate(startDate)) startDate = today;

  if (startDate > today) {
    return {
      restricted: true,
      timezone,
      today,
      startDate,
      canWork: false,
      requiredDate: null,
      openDate: startDate,
      backlog: false,
      status: 'not-started',
      message: `Your work tracking starts on ${startDate}.`
    };
  }

  const { data: rows, error } = await db
    .from('attendance')
    .select('work_date,finished_at,day_status')
    .eq('company_id', member.company_id)
    .eq('member_id', member.id)
    .gte('work_date', startDate)
    .lte('work_date', today)
    .order('work_date');
  if (error) throw error;

  const byDate = new Map((rows || []).map(row => [row.work_date, row]));
  let cursor = startDate;
  let requiredDate = null;
  let safety = 0;

  while (cursor <= today && safety < 5000) {
    safety += 1;
    if (!isSunday(cursor)) {
      const row = byDate.get(cursor);
      const completed = Boolean(row?.finished_at) || row?.day_status === 'leave';
      if (!completed) {
        requiredDate = cursor;
        break;
      }
    }
    cursor = addDays(cursor, 1);
  }

  if (safety >= 5000) throw new Error('Work start date is too old. Ask the Owner to update the member start date.');

  if (requiredDate) {
    const backlog = requiredDate < today;
    return {
      restricted: true,
      timezone,
      today,
      startDate,
      canWork: true,
      requiredDate,
      openDate: requiredDate,
      backlog,
      status: backlog ? 'backlog' : 'open',
      message: backlog
        ? `Complete ${requiredDate} and click Finish Day before adding tasks for ${today}.`
        : `Your work day ${requiredDate} is open.`
    };
  }

  const nextDate = nextWorkingDate(today);
  return {
    restricted: true,
    timezone,
    today,
    startDate,
    canWork: false,
    requiredDate: null,
    openDate: nextDate,
    backlog: false,
    status: isSunday(today) ? 'sunday-off' : 'finished',
    message: isSunday(today)
      ? `Sunday is an off day. Your next work day opens on ${nextDate}.`
      : `Today's work day is finished. Your next work day opens on ${nextDate}.`
  };
}

async function enforceOpenPersonalDate(db, actor, memberId, workDate) {
  if (!restrictedDailyRole(actor.role)) return { ok: true, gate: null };
  if (memberId !== actor.id) return { ok: false, error: 'You can only manage your own daily work.' };

  const company = await getCompany(db, actor.company_id);
  const gate = await getWorkGate(db, actor, company);
  if (!gate.canWork || !gate.requiredDate) return { ok: false, error: gate.message, gate };
  if (workDate !== gate.requiredDate) {
    return {
      ok: false,
      gate,
      error: `Complete ${gate.requiredDate} and click Finish Day first. ${workDate} is locked.`
    };
  }
  return { ok: true, gate };
}

async function closedDayReason(db, memberId, workDate) {
  const { data, error } = await db
    .from('attendance')
    .select('finished_at,day_status')
    .eq('member_id', memberId)
    .eq('work_date', workDate)
    .maybeSingle();
  if (error) throw error;
  if (data?.day_status === 'leave') return 'This date is marked as approved leave/off.';
  if (data?.finished_at) return 'This work day is finished and locked.';
  return '';
}


async function sheetPost(url, payload) {
  if (!url) return { skipped: true, reason: 'Apps Script URL is not configured.' };

  const requestPayload = {
    ...payload,
    connectorSecret: appsScriptSharedSecret || undefined
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(requestPayload),
      redirect: 'follow'
    });
    const text = await response.text();

    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    return {
      ok: response.ok && parsed?.ok !== false,
      status: response.status,
      text: text.slice(0, 500),
      data: parsed
    };
  } catch (error) {
    console.error('Google Apps Script request failed:', error);
    return { ok: false, error: String(error) };
  }
}


async function taskSheetRow(db, taskId) {
  const { data: task, error } = await db
    .from('tasks')
    .select('id,company_id,member_id,assigned_by,title,task_date,hours,priority,status,notes,updated_at')
    .eq('id', taskId)
    .single();
  if (error) throw error;

  const [{ data: member }, { data: assigner }, { data: attendance }, company] = await Promise.all([
    db.from('members').select('employee_id,name,email,role').eq('id', task.member_id).single(),
    db.from('members').select('name,email,role').eq('id', task.assigned_by).single(),
    db.from('attendance').select('login_time,logout_time,finished_at,day_status,status_note').eq('member_id', task.member_id).eq('work_date', task.task_date).maybeSingle(),
    getCompany(db, task.company_id)
  ]);

  return {
    company,
    member,
    assigner,
    task,
    row: {
      taskId: task.id,
      date: task.task_date,
      employeeId: member?.employee_id || '',
      employeeName: member?.name || '',
      department: roleLabel(member?.role),
      priority: task.priority || 'Medium',
      task: task.title,
      duration: durationLabel(task.hours),
      hours: Number(task.hours || 0),
      status: task.status,
      notes: task.notes || '',
      assignedBy: assigner?.name || '',
      loginTime: attendance?.login_time ? String(attendance.login_time).slice(0, 5) : '',
      logoutTime: attendance?.logout_time ? String(attendance.logout_time).slice(0, 5) : '',
      finishedDay: Boolean(attendance?.finished_at),
      dayStatus: attendance?.day_status || 'work',
      dayNote: attendance?.status_note || '',
      updatedAt: task.updated_at
    }
  };
}

async function syncTask(db, taskId) {
  const { company, row } = await taskSheetRow(db, taskId);
  return sheetPost(company.sheet_webhook_url, { action: 'upsertTask', row });
}

async function daySheetRow(db, companyId, memberId, date) {
  const [{ data: member, error: memberError }, { data: attendance, error: attendanceError }, company] = await Promise.all([
    db.from('members').select('employee_id,name,role').eq('id', memberId).single(),
    db.from('attendance').select('login_time,logout_time,finished_at,day_status,status_note,approved_by,approved_at,updated_at').eq('member_id', memberId).eq('work_date', date).maybeSingle(),
    getCompany(db, companyId)
  ]);
  if (memberError) throw memberError;
  if (attendanceError) throw attendanceError;

  let approverName = '';
  if (attendance?.approved_by) {
    const { data: approver } = await db.from('members').select('name').eq('id', attendance.approved_by).maybeSingle();
    approverName = approver?.name || '';
  }

  return {
    company,
    row: {
      dayKey: `${memberId}:${date}`,
      date,
      employeeId: member?.employee_id || '',
      employeeName: member?.name || '',
      department: roleLabel(member?.role),
      dayStatus: attendance?.day_status || 'work',
      loginTime: attendance?.login_time ? String(attendance.login_time).slice(0, 5) : '',
      logoutTime: attendance?.logout_time ? String(attendance.logout_time).slice(0, 5) : '',
      finishedDay: Boolean(attendance?.finished_at),
      note: attendance?.status_note || '',
      approvedBy: approverName,
      approvedAt: attendance?.approved_at || '',
      updatedAt: attendance?.updated_at || new Date().toISOString()
    }
  };
}

async function syncMemberDay(db, companyId, memberId, date) {
  const [{ data: tasks, error }, day] = await Promise.all([
    db.from('tasks')
      .select('id')
      .eq('company_id', companyId)
      .eq('member_id', memberId)
      .eq('task_date', date),
    daySheetRow(db, companyId, memberId, date)
  ]);
  if (error) throw error;

  await Promise.all([
    sheetPost(day.company.sheet_webhook_url, { action: 'upsertDay', row: day.row }),
    ...tasks.map(task => syncTask(db, task.id))
  ]);
}


async function enforcePriorityLimit(db, {
  companyId,
  memberId,
  taskDate,
  priority,
  excludeTaskId = null
}) {
  const limit = priorityLimit(priority);
  if (!limit) throw new Error('Invalid priority.');

  let query = db
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('member_id', memberId)
    .eq('task_date', taskDate)
    .eq('priority', priority);

  if (excludeTaskId) query = query.neq('id', excludeTaskId);

  const { count, error } = await query;
  if (error) throw error;

  if (Number(count || 0) >= limit) {
    const label = priority.toUpperCase();
    return `${label} allows maximum ${limit} task${limit === 1 ? '' : 's'} per employee per day.`;
  }
  return '';
}

async function getOwnerRecipient(db, companyId, company) {
  const { data: owner, error } = await db
    .from('members')
    .select('id,name,email,role')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;

  const email = cleanText(company?.owner_notification_email || owner?.email, 160);
  return {
    id: owner?.id || null,
    name: owner?.name || 'Owner',
    email
  };
}

function appUrlFromRequest(req) {
  const proto = cleanText(req.headers['x-forwarded-proto'] || 'https', 10);
  const host = cleanText(req.headers['x-forwarded-host'] || req.headers.host, 250);
  return host ? `${proto}://${host}` : '';
}

function emailHtml({
  companyName,
  heading,
  intro,
  task,
  assignedTo,
  assignedBy,
  appUrl
}) {
  const safe = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const rows = [
    ['Task', task.title],
    ['Priority', task.priority],
    ['Assigned To', `${assignedTo.name} — ${roleLabel(assignedTo.role)}`],
    ['Assigned By', `${assignedBy.name} — ${roleLabel(assignedBy.role)}`],
    ['Date', task.task_date],
    ['Duration', durationLabel(task.hours)],
    ['Status', task.status],
    ['Notes', task.notes || '—']
  ].map(([label, value]) => `
    <tr>
      <td style="padding:9px 12px;border-bottom:1px solid #e8edf3;font-weight:700;color:#566174;width:140px">${safe(label)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e8edf3;color:#172033">${safe(value)}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family:Arial,sans-serif;background:#f4f7fb;padding:24px;color:#172033">
      <div style="max-width:650px;margin:auto;background:#fff;border:1px solid #e4eaf1;border-radius:16px;overflow:hidden">
        <div style="padding:22px;background:linear-gradient(135deg,#0B1730,#1A3560);color:#fff">
          <div style="font-size:12px;opacity:.7">${safe(companyName || 'Team Task Tracker')}</div>
          <h2 style="margin:6px 0 0;font-size:22px">${safe(heading)}</h2>
        </div>
        <div style="padding:22px">
          <p style="margin-top:0;line-height:1.6">${safe(intro)}</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e4eaf1;border-radius:10px;overflow:hidden">${rows}</table>
          ${appUrl ? `<p style="margin:22px 0 0"><a href="${safe(appUrl)}" style="display:inline-block;background:#C9A84C;color:#0B1730;text-decoration:none;font-weight:700;padding:11px 16px;border-radius:9px">Open Task Tracker</a></p>` : ''}
        </div>
      </div>
    </div>
  `;
}

async function sendTaskEmails(req, db, actor, task) {
  const company = await getCompany(db, actor.company_id);
  if (company.email_notifications_enabled === false) {
    return [{ skipped: true, reason: 'Email notifications are disabled.' }];
  }
  if (!company.sheet_webhook_url) {
    return [{ skipped: true, reason: 'Apps Script URL is not configured.' }];
  }
  if (!appsScriptSharedSecret) {
    return [{ skipped: true, reason: 'APPS_SCRIPT_SHARED_SECRET is missing in Vercel.' }];
  }

  const [{ data: assignedTo, error: assignedError }, owner] = await Promise.all([
    db.from('members').select('id,name,email,role').eq('id', task.member_id).single(),
    getOwnerRecipient(db, actor.company_id, company)
  ]);
  if (assignedError) throw assignedError;

  const appUrl = appUrlFromRequest(req);
  const results = [];
  const recipients = [];

  if (assignedTo?.email && task.member_id !== actor.id) {
    recipients.push({
      to: assignedTo.email,
      subject: `[${task.priority}] New task assigned: ${task.title}`,
      heading: 'New Task Assigned',
      intro: `${actor.name} assigned a new task to you.`
    });
  }

  if (actor.role !== 'owner' && owner.email) {
    recipients.push({
      to: owner.email,
      subject: `[Task Notification] ${actor.name}: ${task.title}`,
      heading: 'Team Task Notification',
      intro: `${actor.name} created or assigned a task.`
    });
  }

  const seen = new Set();
  for (const recipient of recipients) {
    const key = recipient.to.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const payload = {
      action: 'sendTaskEmail',
      email: {
        to: recipient.to,
        subject: recipient.subject,
        body: `${recipient.intro}\n\nTask: ${task.title}\nPriority: ${task.priority}\nAssigned to: ${assignedTo.name}\nAssigned by: ${actor.name}\nDate: ${task.task_date}\nDuration: ${durationLabel(task.hours)}\nStatus: ${task.status}\nNotes: ${task.notes || '—'}\n${appUrl ? `Open: ${appUrl}` : ''}`,
        htmlBody: emailHtml({
          companyName: company.name,
          heading: recipient.heading,
          intro: recipient.intro,
          task,
          assignedTo,
          assignedBy: actor,
          appUrl
        }),
        senderName: company.name || 'Team Task Tracker'
      }
    };
    results.push(await sheetPost(company.sheet_webhook_url, payload));
  }

  return results.length ? results : [{ skipped: true, reason: 'No valid email recipient was configured.' }];
}

async function handleHealth(res, db) {
  const projectRef = (() => {
    try { return new URL(supabaseUrl).hostname.split('.')[0]; } catch { return 'invalid-url'; }
  })();
  const keyType = supabaseSecret.startsWith('sb_secret_')
    ? 'secret'
    : supabaseSecret.startsWith('sb_publishable_')
      ? 'publishable-wrong'
      : supabaseSecret.split('.').length === 3
        ? 'legacy-jwt'
        : 'unknown';

  const { data, error } = await db
    .from('members')
    .select('id,company_id,employee_id,role,active,pin_hash')
    .ilike('employee_id', 'OWNER');

  if (error) {
    return send(res, 500, {
      ok: false,
      stage: 'supabase-query',
      projectRef,
      keyType,
      error: error.message,
      code: error.code || ''
    });
  }

  return send(res, 200, {
    ok: true,
    projectRef,
    keyType,
    ownerCount: data.length,
    owners: data.map(row => ({
      employeeId: row.employee_id,
      role: row.role,
      active: row.active,
      companyId: row.company_id,
      hashPrefix: String(row.pin_hash || '').slice(0, 4)
    }))
  });
}

async function handleLogin(req, res, db) {
  const employeeId = cleanText(req.body?.employeeId, 40).toUpperCase();
  const pin = cleanText(req.body?.pin, 12);
  if (!employeeId || !/^\d{4,8}$/.test(pin)) {
    return send(res, 400, { error: 'Enter a valid Employee ID and a 4–8 digit PIN.' });
  }

  const { data: matches, error } = await db
    .from('members')
    .select('*')
    .ilike('employee_id', employeeId)
    .eq('active', true)
    .limit(3);

  if (error) {
    console.error('Login database lookup failed:', error);
    return send(res, 500, {
      error: `Database lookup failed: ${error.message}`,
      code: error.code || ''
    });
  }

  if (!matches || matches.length === 0) {
    return send(res, 401, {
      error: `${employeeId} does not exist in the Supabase project connected to this Vercel deployment.`
    });
  }

  if (matches.length > 1) {
    return send(res, 409, {
      error: `More than one active ${employeeId} account exists. Remove duplicate accounts in Supabase.`
    });
  }

  const member = matches[0];
  let valid = false;
  try {
    valid = await bcrypt.compare(pin, String(member.pin_hash || ''));
  } catch (compareError) {
    console.error('PIN hash comparison failed:', compareError);
    return send(res, 500, { error: 'The stored PIN hash is invalid. Reset the Owner PIN in Supabase.' });
  }

  if (!valid) {
    return send(res, 401, {
      error: `${employeeId} was found, but the PIN does not match the stored PIN hash.`
    });
  }

  let company;
  try {
    company = await getCompany(db, member.company_id);
  } catch (companyError) {
    console.error('Company lookup failed:', companyError);
    return send(res, 500, { error: 'Owner login is valid, but its company record is missing or inaccessible.' });
  }

  return send(res, 200, { token: signToken(member), user: publicMember(member), company });
}


async function handleBootstrap(res, db, actor) {
  const memberIds = await allowedMemberIds(db, actor);
  const company = await getCompany(db, actor.company_id);

  const [membersResult, tasksResult, attendanceResult, notificationsResult] = await Promise.all([
    db.from('members')
      .select('id,company_id,employee_id,name,email,role,manager_id,active,work_start_date,created_at')
      .eq('company_id', actor.company_id)
      .in('id', memberIds)
      .order('created_at'),
    db.from('tasks')
      .select('id,company_id,member_id,assigned_by,title,task_date,hours,priority,status,notes,created_at,updated_at')
      .eq('company_id', actor.company_id)
      .in('member_id', memberIds)
      .order('task_date', { ascending: false })
      .order('created_at', { ascending: false }),
    db.from('attendance')
      .select('id,company_id,member_id,work_date,login_time,logout_time,finished_at,day_status,status_note,approved_by,approved_at,created_at,updated_at')
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

  const workGate = await getWorkGate(db, actor, company);

  return send(res, 200, {
    user: publicMember(actor),
    workGate,
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
      priority: task.priority || 'Medium',
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
      dayStatus: row.day_status || 'work',
      statusNote: row.status_note || '',
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
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
  const email = cleanText(req.body?.email, 160).toLowerCase();
  const role = cleanText(req.body?.role, 20).toLowerCase();
  const pin = cleanText(req.body?.pin, 12);
  let employeeId = cleanText(req.body?.employeeId, 40).toUpperCase();
  const managerId = cleanText(req.body?.managerId, 60) || null;

  if (!name) return send(res, 400, { error: 'Member name is required.' });
  if (!email || !validEmail(email)) return send(res, 400, { error: 'Enter a valid member email for notifications.' });
  if (!['manager', 'sales', 'developer'].includes(role)) {
    return send(res, 400, { error: 'Department must be Operational Manager, Sales Team, or Developer.' });
  }
  if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'PIN must contain 4–8 digits.' });
  if (!employeeId) employeeId = await nextEmployeeId(db, actor.company_id, role);
  if (!/^[A-Z0-9-]{3,40}$/.test(employeeId)) {
    return send(res, 400, { error: 'Employee ID can use letters, numbers, and hyphens.' });
  }

  if (managerId) {
    const { data: manager } = await db
      .from('members')
      .select('id,role')
      .eq('id', managerId)
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .maybeSingle();
    if (!manager || manager.role !== 'manager') {
      return send(res, 400, { error: 'Select a valid Operational Manager.' });
    }
  }

  const [pinHash, company] = await Promise.all([
    bcrypt.hash(pin, 10),
    getCompany(db, actor.company_id)
  ]);
  const { data, error } = await db.from('members').insert({
    company_id: actor.company_id,
    employee_id: employeeId,
    pin_hash: pinHash,
    name,
    email,
    role,
    manager_id: ['sales', 'developer'].includes(role) ? managerId : null,
    work_start_date: dateInTimeZone(company.work_timezone || 'Asia/Karachi')
  }).select('id,company_id,employee_id,name,email,role,manager_id,active,work_start_date,created_at').single();

  if (error) {
    if (error.code === '23505') return send(res, 409, { error: 'That Employee ID already exists.' });
    throw error;
  }

  await notify(db, {
    companyId: actor.company_id,
    recipientId: data.id,
    senderId: actor.id,
    type: 'system',
    message: `Welcome to the ${roleLabel(data.role)} department, ${data.name}.`
  });

  return send(res, 201, { member: publicMember(data) });
}


async function handleUpdateMember(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can update members.' });

  const id = cleanText(req.body?.id, 60);
  if (!id || id === actor.id) return send(res, 400, { error: 'This member cannot be changed here.' });

  const { data: existing, error: existingError } = await db
    .from('members')
    .select('id,role')
    .eq('id', id)
    .eq('company_id', actor.company_id)
    .single();
  if (existingError || !existing) return send(res, 404, { error: 'Member not found.' });

  const patch = {};
  const nextRole = req.body?.role === undefined
    ? existing.role
    : cleanText(req.body.role, 20).toLowerCase();

  if (!['manager', 'sales', 'developer'].includes(nextRole)) {
    return send(res, 400, { error: 'Department must be Operational Manager, Sales Team, or Developer.' });
  }

  if (req.body?.name !== undefined) {
    patch.name = cleanText(req.body.name, 100);
    if (!patch.name) return send(res, 400, { error: 'Member name is required.' });
  }
  if (req.body?.email !== undefined) {
    patch.email = cleanText(req.body.email, 160).toLowerCase();
    if (!patch.email || !validEmail(patch.email)) {
      return send(res, 400, { error: 'Enter a valid member email for notifications.' });
    }
  }
  patch.role = nextRole;

  const managerId = req.body?.managerId === undefined
    ? undefined
    : cleanText(req.body.managerId, 60) || null;

  if (managerId) {
    const { data: manager } = await db
      .from('members')
      .select('id,role')
      .eq('id', managerId)
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .maybeSingle();
    if (!manager || manager.role !== 'manager' || manager.id === id) {
      return send(res, 400, { error: 'Select a valid Operational Manager.' });
    }
  }

  if (req.body?.managerId !== undefined || nextRole === 'manager') {
    patch.manager_id = ['sales', 'developer'].includes(nextRole) ? managerId : null;
  }
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
    .select('id,company_id,employee_id,name,email,role,manager_id,active,work_start_date,created_at')
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
  const priority = cleanText(req.body?.priority, 20) || 'Medium';
  const duration = durationFromBody(req.body);
  const status = cleanText(req.body?.status, 30) || 'Pending';
  const notes = cleanText(req.body?.notes, 1500);

  if (!(await canAssignTo(db, actor, memberId))) {
    return send(res, 403, { error: 'You cannot assign a task to this member.' });
  }
  if (!title) return send(res, 400, { error: 'Task name is required.' });
  if (!validDate(date)) return send(res, 400, { error: 'Choose a valid task date.' });
  if (isSunday(date)) return send(res, 409, { error: 'Sunday is an automatic off day. Choose a working day.' });
  if (!['High', 'Medium', 'Low'].includes(priority)) return send(res, 400, { error: 'Choose High, Medium, or Low priority.' });
  if (duration.error) return send(res, 400, { error: duration.error });
  if (!['Pending','In Progress','Completed','On Hold','Review'].includes(status)) {
    return send(res, 400, { error: 'Invalid task status.' });
  }

  const gateCheck = await enforceOpenPersonalDate(db, actor, memberId, date);
  if (!gateCheck.ok) return send(res, 409, { error: gateCheck.error, workGate: gateCheck.gate });

  const { data: attendance } = await db
    .from('attendance')
    .select('finished_at,day_status')
    .eq('member_id', memberId)
    .eq('work_date', date)
    .maybeSingle();
  if (attendance?.day_status === 'leave') return send(res, 409, { error: 'That date is marked as approved leave/off. Reopen the day first.' });
  if (attendance?.finished_at) return send(res, 409, { error: 'That work day is finished. Reopen the day first.' });

  const limitError = await enforcePriorityLimit(db, {
    companyId: actor.company_id,
    memberId,
    taskDate: date,
    priority
  });
  if (limitError) return send(res, 409, { error: limitError });

  const { data, error } = await db.from('tasks').insert({
    company_id: actor.company_id,
    member_id: memberId,
    assigned_by: actor.id,
    title,
    task_date: date,
    hours: duration.hoursDecimal,
    priority,
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
      message: `${actor.name} assigned you a ${priority.toLowerCase()} priority task: ${title}`
    });
  }

  const [sheetResult, emailResults] = await Promise.all([
    syncTask(db, data.id),
    sendTaskEmails(req, db, actor, data)
  ]);

  return send(res, 201, {
    task: data,
    integrations: {
      sheet: sheetResult,
      email: emailResults
    }
  });
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

  if (!['owner', 'manager'].includes(actor.role) && existing.member_id !== actor.id) {
    return send(res, 403, { error: 'You cannot edit this task.' });
  }

  const patch = { updated_at: new Date().toISOString() };

  if (req.body?.title !== undefined) {
    patch.title = cleanText(req.body.title, 240);
    if (!patch.title) return send(res, 400, { error: 'Task name is required.' });
  }

  if (
    req.body?.durationHours !== undefined ||
    req.body?.durationMinutes !== undefined ||
    req.body?.hours !== undefined
  ) {
    const duration = durationFromBody(req.body, existing.hours);
    if (duration.error) return send(res, 400, { error: duration.error });
    patch.hours = duration.hoursDecimal;
  }

  if (req.body?.priority !== undefined) {
    patch.priority = cleanText(req.body.priority, 20);
    if (!['High', 'Medium', 'Low'].includes(patch.priority)) {
      return send(res, 400, { error: 'Choose High, Medium, or Low priority.' });
    }
  }

  if (req.body?.status !== undefined) {
    patch.status = cleanText(req.body.status, 30);
    if (!['Pending','In Progress','Completed','On Hold','Review'].includes(patch.status)) {
      return send(res, 400, { error: 'Invalid task status.' });
    }
  }

  if (req.body?.notes !== undefined) patch.notes = cleanText(req.body.notes, 1500);

  if (req.body?.taskDate !== undefined) {
    patch.task_date = cleanText(req.body.taskDate, 10);
    if (!validDate(patch.task_date)) return send(res, 400, { error: 'Choose a valid task date.' });
  }

  const nextDate = patch.task_date || existing.task_date;
  if (isSunday(nextDate)) return send(res, 409, { error: 'Sunday is an automatic off day. Choose a working day.' });
  const nextPriority = patch.priority || existing.priority || 'Medium';

  const gateCheck = await enforceOpenPersonalDate(db, actor, existing.member_id, nextDate);
  if (!gateCheck.ok) return send(res, 409, { error: gateCheck.error, workGate: gateCheck.gate });
  const closedReason = await closedDayReason(db, existing.member_id, existing.task_date);
  if (closedReason) return send(res, 409, { error: `${closedReason} Reopen the day first.` });

  if (nextDate !== existing.task_date || nextPriority !== (existing.priority || 'Medium')) {
    const limitError = await enforcePriorityLimit(db, {
      companyId: actor.company_id,
      memberId: existing.member_id,
      taskDate: nextDate,
      priority: nextPriority,
      excludeTaskId: id
    });
    if (limitError) return send(res, 409, { error: limitError });
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
  if (!['owner', 'manager'].includes(actor.role) && existing.assigned_by !== actor.id) return send(res, 403, { error: 'You cannot delete a task assigned by someone else.' });

  const gateCheck = await enforceOpenPersonalDate(db, actor, existing.member_id, existing.task_date);
  if (!gateCheck.ok) return send(res, 409, { error: gateCheck.error, workGate: gateCheck.gate });
  const closedReason = await closedDayReason(db, existing.member_id, existing.task_date);
  if (closedReason) return send(res, 409, { error: `${closedReason} Reopen the day first.` });

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
  if (!['owner', 'manager'].includes(actor.role) && memberId !== actor.id) return send(res, 403, { error: 'You can only update your own attendance.' });
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid work date.' });
  if (isSunday(workDate)) return send(res, 409, { error: 'Sunday is an automatic off day.' });

  const gateCheck = await enforceOpenPersonalDate(db, actor, memberId, workDate);
  if (!gateCheck.ok) return send(res, 409, { error: gateCheck.error, workGate: gateCheck.gate });
  const closedReason = await closedDayReason(db, memberId, workDate);
  if (closedReason) return send(res, 409, { error: `${closedReason} Reopen the day first.` });

  if (loginTime !== undefined && !validTime(loginTime)) return send(res, 400, { error: 'Invalid login time.' });
  if (logoutTime !== undefined && !validTime(logoutTime)) return send(res, 400, { error: 'Invalid logout time.' });

  const values = {
    company_id: actor.company_id,
    member_id: memberId,
    work_date: workDate,
    day_status: 'work',
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
  if (!['owner', 'manager'].includes(actor.role) && memberId !== actor.id) return send(res, 403, { error: 'You can only finish your own day.' });
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid work date.' });
  if (isSunday(workDate)) return send(res, 409, { error: 'Sunday is an automatic off day.' });

  const gateCheck = await enforceOpenPersonalDate(db, actor, memberId, workDate);
  if (!gateCheck.ok) return send(res, 409, { error: gateCheck.error, workGate: gateCheck.gate });
  const closedReason = await closedDayReason(db, memberId, workDate);
  if (closedReason) return send(res, 409, { error: `${closedReason} Reopen the day first.` });

  const restrictedTarget = await getRestrictedMember(db, actor, memberId);
  if (restrictedTarget) {
    const { count, error: taskCountError } = await db
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', actor.company_id)
      .eq('member_id', memberId)
      .eq('task_date', workDate);
    if (taskCountError) throw taskCountError;
    if (!Number(count || 0)) return send(res, 400, { error: 'Add at least one task before clicking Finish Day.' });
  }

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
      day_status: 'work',
      status_note: '',
      approved_by: null,
      approved_at: null,
      finished_at: finishedAt,
      updated_at: finishedAt
    }, { onConflict: 'member_id,work_date' })
    .select('*')
    .single();
  if (error) throw error;

  await syncMemberDay(db, actor.company_id, memberId, workDate);
  return send(res, 200, { attendance: data });
}


async function getRestrictedMember(db, actor, memberId) {
  const { data, error } = await db
    .from('members')
    .select('id,company_id,employee_id,name,email,role,work_start_date,created_at,active')
    .eq('id', memberId)
    .eq('company_id', actor.company_id)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data || !restrictedDailyRole(data.role)) return null;
  return data;
}

async function handleMarkLeave(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can approve leave/off days.' });

  const memberId = cleanText(req.body?.memberId, 60);
  const workDate = cleanText(req.body?.workDate, 10);
  const note = cleanText(req.body?.note, 500);
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid date.' });
  if (isSunday(workDate)) return send(res, 400, { error: 'Sunday is already an automatic off day.' });

  const [member, company] = await Promise.all([
    getRestrictedMember(db, actor, memberId),
    getCompany(db, actor.company_id)
  ]);
  if (!member) return send(res, 404, { error: 'Choose a Sales Team or Developer member.' });

  const today = dateInTimeZone(company.work_timezone || 'Asia/Karachi');
  if (workDate > today) return send(res, 400, { error: 'Future leave days cannot be used to unlock the daily workflow.' });
  if (member.work_start_date && workDate < member.work_start_date) {
    return send(res, 400, { error: `This member's tracking starts on ${member.work_start_date}.` });
  }

  const { count, error: countError } = await db
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', actor.company_id)
    .eq('member_id', memberId)
    .eq('task_date', workDate);
  if (countError) throw countError;
  if (Number(count || 0) > 0) {
    return send(res, 409, { error: 'This date already has tasks. Delete or move those tasks before approving leave.' });
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('attendance')
    .upsert({
      company_id: actor.company_id,
      member_id: memberId,
      work_date: workDate,
      login_time: null,
      logout_time: null,
      finished_at: null,
      day_status: 'leave',
      status_note: note || 'Approved leave/off day',
      approved_by: actor.id,
      approved_at: now,
      updated_at: now
    }, { onConflict: 'member_id,work_date' })
    .select('*')
    .single();
  if (error) throw error;

  await notify(db, {
    companyId: actor.company_id,
    recipientId: memberId,
    senderId: actor.id,
    type: 'system',
    message: `${workDate} was marked as approved leave/off by the Owner.`
  });
  await syncMemberDay(db, actor.company_id, memberId, workDate);
  return send(res, 200, { attendance: data });
}

async function handleReopenDay(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can reopen a day.' });

  const memberId = cleanText(req.body?.memberId, 60);
  const workDate = cleanText(req.body?.workDate, 10);
  if (!validDate(workDate)) return send(res, 400, { error: 'Choose a valid date.' });
  if (isSunday(workDate)) return send(res, 400, { error: 'Sunday is already an automatic off day.' });

  const member = await getRestrictedMember(db, actor, memberId);
  if (!member) return send(res, 404, { error: 'Choose a Sales Team or Developer member.' });

  const { data: current, error: readError } = await db
    .from('attendance')
    .select('*')
    .eq('member_id', memberId)
    .eq('work_date', workDate)
    .maybeSingle();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('attendance')
    .upsert({
      company_id: actor.company_id,
      member_id: memberId,
      work_date: workDate,
      login_time: current?.login_time || null,
      logout_time: current?.logout_time || null,
      finished_at: null,
      day_status: 'work',
      status_note: '',
      approved_by: null,
      approved_at: null,
      updated_at: now
    }, { onConflict: 'member_id,work_date' })
    .select('*')
    .single();
  if (error) throw error;

  await notify(db, {
    companyId: actor.company_id,
    recipientId: memberId,
    senderId: actor.id,
    type: 'system',
    message: `${workDate} was reopened by the Owner.`
  });
  await syncMemberDay(db, actor.company_id, memberId, workDate);
  return send(res, 200, { attendance: data });
}

async function handleRing(req, res, db, actor) {
  let recipientId = cleanText(req.body?.recipientId, 60);
  const message = cleanText(req.body?.message, 400) || `${actor.name} is ringing you.`;

  if (['sales', 'developer'].includes(actor.role)) {
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

  if (req.body?.workTimezone !== undefined) {
    const timezone = cleanText(req.body.workTimezone, 80);
    if (!['Asia/Karachi', 'Asia/Dubai', 'UTC'].includes(timezone)) {
      return send(res, 400, { error: 'Choose Pakistan, UAE, or UTC work timezone.' });
    }
    patch.work_timezone = timezone;
  }

  if (req.body?.ownerNotificationEmail !== undefined) {
    const email = cleanText(req.body.ownerNotificationEmail, 160).toLowerCase();
    if (email && !validEmail(email)) return send(res, 400, { error: 'Enter a valid Owner notification email.' });
    patch.owner_notification_email = email;
  }

  if (req.body?.emailNotificationsEnabled !== undefined) {
    patch.email_notifications_enabled = Boolean(req.body.emailNotificationsEnabled);
  }

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

  const { data, error } = await db
    .from('companies')
    .update(patch)
    .eq('id', actor.company_id)
    .select('*')
    .single();
  if (error) throw error;

  return send(res, 200, { company: data });
}


async function handleTestSheet(res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can test the Sheet connection.' });

  const company = await getCompany(db, actor.company_id);
  if (!company.sheet_webhook_url) return send(res, 400, { error: 'Save the Google Apps Script URL first.' });

  const result = await sheetPost(company.sheet_webhook_url, { action: 'test' });
  if (!result.ok) {
    return send(res, 502, {
      error: 'The Google Apps Script connector did not respond successfully.',
      detail: result
    });
  }

  return send(res, 200, { ok: true });
}

async function handleTestEmail(req, res, db, actor) {
  if (actor.role !== 'owner') return send(res, 403, { error: 'Only the Owner can test email notifications.' });

  const company = await getCompany(db, actor.company_id);
  if (!company.sheet_webhook_url) return send(res, 400, { error: 'Save the Google Apps Script URL first.' });
  if (!appsScriptSharedSecret) return send(res, 400, { error: 'Add APPS_SCRIPT_SHARED_SECRET in Vercel first.' });

  const owner = await getOwnerRecipient(db, actor.company_id, company);
  if (!owner.email) return send(res, 400, { error: 'Save the Owner notification email first.' });

  const appUrl = appUrlFromRequest(req);
  const result = await sheetPost(company.sheet_webhook_url, {
    action: 'sendTaskEmail',
    email: {
      to: owner.email,
      subject: 'Task Tracker email notifications are working',
      body: `Email notifications are connected successfully.${appUrl ? `\nOpen: ${appUrl}` : ''}`,
      htmlBody: `
        <div style="font-family:Arial,sans-serif;padding:24px">
          <h2>Task Tracker email notifications are working</h2>
          <p>Your Google Apps Script email connector is configured successfully.</p>
          ${appUrl ? `<p><a href="${appUrl}">Open Task Tracker</a></p>` : ''}
        </div>
      `,
      senderName: company.name || 'Team Task Tracker'
    }
  });

  if (!result.ok) return send(res, 502, { error: 'Test email could not be sent.', detail: result });
  return send(res, 200, { ok: true, email: owner.email });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

  const action = cleanText(req.query?.action || req.body?.action, 60);
  let db;
  try {
    db = getDb();
    if (action === 'health' && req.method === 'GET') return await handleHealth(res, db);
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
    if (action === 'day.leave' && req.method === 'POST') return await handleMarkLeave(req, res, db, actor);
    if (action === 'day.reopen' && req.method === 'POST') return await handleReopenDay(req, res, db, actor);
    if (action === 'ring' && req.method === 'POST') return await handleRing(req, res, db, actor);
    if (action === 'notifications.read' && req.method === 'POST') return await handleReadNotifications(req, res, db, actor);
    if (action === 'company.update' && req.method === 'PATCH') return await handleCompanySettings(req, res, db, actor);
    if (action === 'sheet.test' && req.method === 'POST') return await handleTestSheet(res, db, actor);
    if (action === 'email.test' && req.method === 'POST') return await handleTestEmail(req, res, db, actor);

    return send(res, 404, { error: 'Unknown API action.' });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: 'Server error. Check Vercel Function Logs.', detail: process.env.NODE_ENV === 'development' ? String(error) : undefined });
  }
};
