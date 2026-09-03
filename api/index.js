const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');

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
const TRACKER_START_DATE = '2026-08-15';

function previousRequiredWorkDate(date) {
  if (!date || date <= TRACKER_START_DATE) return null;

  const [year, month, day] = String(date).split('-').map(Number);
  const current = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = current.getUTCDay();

  // Sunday is an OFF day.
  if (dayOfWeek === 0) return null;

  // Monday checks the previous Saturday.
  if (dayOfWeek === 1) {
    current.setUTCDate(current.getUTCDate() - 2);
  } else {
    current.setUTCDate(current.getUTCDate() - 1);
  }

  const previousDate = current.toISOString().slice(0, 10);

  // Never require a workday before the tracker start date.
  if (previousDate < TRACKER_START_DATE) return null;

  return previousDate;
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
  const { data, error } = await db
    .from('members')
    .select('id')
    .eq('company_id', actor.company_id)
    .eq('active', true);

  if (error) throw error;

  return data.map(row => row.id);
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
    .select('id,company_id,member_id,assigned_by,title,task_date,hours,priority,status,notes,updated_at')
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
      priority: task.priority || 'Medium',
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

async function getChatConversation(db, actor, conversationId) {
  const id = cleanText(conversationId, 60);
  if (!id) return null;

  const { data: conversation, error: conversationError } = await db
    .from('chat_conversations')
    .select('id, company_id, conversation_type, name, created_at, updated_at')
    .eq('id', id)
    .eq('company_id', actor.company_id)
    .maybeSingle();

  if (conversationError) throw conversationError;
  if (!conversation) return null;

  const { data: participant, error: participantError } = await db
    .from('chat_participants')
    .select('conversation_id, member_id, last_read_at')
    .eq('conversation_id', id)
    .eq('member_id', actor.id)
    .maybeSingle();

  if (participantError) throw participantError;

  if (!participant) {
    if (conversation.conversation_type !== 'private') {
      return null;
    }

    const { data: member, error: memberError } = await db
      .from('members')
      .select('id')
      .eq('id', actor.id)
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .maybeSingle();

    if (memberError) throw memberError;
    if (!member) return null;

    const { data: repairedParticipant, error: repairError } = await db
      .from('chat_participants')
      .upsert(
        {
          conversation_id: id,
          member_id: actor.id
        },
        {
          onConflict: 'conversation_id,member_id',
          ignoreDuplicates: true
        }
      )
      .select('conversation_id, member_id, last_read_at')
      .maybeSingle();

    if (repairError) throw repairError;

    return {
      ...conversation,
      participant: repairedParticipant || {
        conversation_id: id,
        member_id: actor.id,
        last_read_at: null
      }
    };
  }

  return {
    ...conversation,
    participant
  };
}
async function handleChatRead(req, res, db, actor) {
  const conversationId = cleanText(
    req.body?.conversationId,
    60
  );

  const conversation = await getChatConversation(
    db,
    actor,
    conversationId
  );

  if (!conversation) {
    return send(res, 403, {
      error: 'You cannot access this conversation.'
    });
  }

  const readAt = new Date().toISOString();

  const { error } = await db
    .from('chat_participants')
    .update({
      last_read_at: readAt
    })
    .eq('conversation_id', conversation.id)
    .eq('member_id', actor.id);

  if (error) throw error;

  return send(res, 200, {
    ok: true,
    lastReadAt: readAt
  });
}
async function handleChatSend(req, res, db, actor) {
  const conversationId = cleanText(req.body?.conversationId, 60);
  const message = cleanText(req.body?.message, 4000);

  if (!conversationId) {
    return send(res, 400, {
      error: 'Conversation is required.'
    });
  }

  if (!message) {
    return send(res, 400, {
      error: 'Message cannot be empty.'
    });
  }

  const conversation = await getChatConversation(
    db,
    actor,
    conversationId
  );

  if (!conversation) {
    return send(res, 403, {
      error: 'You cannot send messages to this conversation.'
    });
  }

  const { data, error } = await db
    .from('chat_messages')
    .insert({
      conversation_id: conversation.id,
      sender_id: actor.id,
      message
    })
    .select(`
      id,
      conversation_id,
      sender_id,
      message,
      created_at,
      sender:members!chat_messages_sender_id_fkey(
        id,
        employee_id,
        name,
        role
      )
    `)
    .single();

  if (error) throw error;

  const { error: updateError } = await db
    .from('chat_conversations')
    .update({
      updated_at: new Date().toISOString()
    })
    .eq('id', conversation.id)
    .eq('company_id', actor.company_id);

  if (updateError) throw updateError;

  return send(res, 200, {
    message: data
  });
}
async function handleChatMessages(req, res, db, actor) {
  const conversationId = cleanText(
    req.query?.conversationId || req.body?.conversationId,
    60
  );

  const conversation = await getChatConversation(
    db,
    actor,
    conversationId
  );

  if (!conversation) {
    return send(res, 403, {
      error: 'You cannot access this conversation.'
    });
  }

  const limit = Math.min(
    Math.max(Number(req.query?.limit || 100), 1),
    200
  );

  const { data, error } = await db
    .from('chat_messages')
    .select(`
      id,
      conversation_id,
      sender_id,
      message,
      created_at,
      sender:members!chat_messages_sender_id_fkey(
        id,
        employee_id,
        name,
        role
      )
    `)
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;

  return send(res, 200, {
    messages: data || []
  });
}
async function handleChatOpen(req, res, db, actor) {
  const type = cleanText(req.body?.type, 20).toLowerCase();

  if (!['private', 'group'].includes(type)) {
    return send(res, 400, {
      error: 'Invalid conversation type.'
    });
  }

  if (type === 'group') {
    const groupName = cleanText(req.body?.name, 80);
    const requestedMemberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds
          .map(id => cleanText(id, 60))
          .filter(Boolean)
      : [];

    if (!groupName) {
      return send(res, 400, {
        error: 'Enter a group name.'
      });
    }

    const uniqueMemberIds = [
      ...new Set([
        actor.id,
        ...requestedMemberIds
      ])
    ];

    const { data: selectedMembers, error: memberError } = await db
      .from('members')
      .select('id, company_id, active')
      .eq('company_id', actor.company_id)
      .eq('active', true)
      .in('id', uniqueMemberIds);

    if (memberError) throw memberError;

    const selectedIds = new Set(
      (selectedMembers || []).map(member => member.id)
    );

    if (!selectedIds.has(actor.id)) {
      return send(res, 403, {
        error: 'You cannot create a group.'
      });
    }

    const invalidMemberIds = uniqueMemberIds.filter(
      id => !selectedIds.has(id)
    );

    if (invalidMemberIds.length) {
      return send(res, 400, {
        error: 'One or more selected members are invalid or inactive.'
      });
    }

    if (uniqueMemberIds.length < 2) {
      return send(res, 400, {
        error: 'Select at least one other team member.'
      });
    }

    const { data: conversation, error: conversationError } = await db
      .from('chat_conversations')
      .insert({
        company_id: actor.company_id,
        conversation_type: 'group',
        name: groupName
      })
      .select('id, company_id, conversation_type, name, created_at, updated_at')
      .single();

    if (conversationError) throw conversationError;

    const rows = uniqueMemberIds.map(memberId => ({
      conversation_id: conversation.id,
      member_id: memberId
    }));

    const { error: participantError } = await db
      .from('chat_participants')
      .insert(rows);

    if (participantError) throw participantError;

    return send(res, 200, {
      conversation
    });
  }
  const memberId = cleanText(req.body?.memberId, 60);

  if (!memberId || memberId === actor.id) {
    return send(res, 400, {
      error: 'Choose another team member.'
    });
  }


  const { data: target, error: targetError } = await db
    .from('members')
    .select('id, company_id, employee_id, name, role, active')
    .eq('id', memberId)
    .eq('company_id', actor.company_id)
    .eq('active', true)
    .maybeSingle();

  if (targetError) throw targetError;

  if (!target) {
    return send(res, 404, {
      error: 'Team member not found.'
    });
  }

  const { data: actorMembership, error: actorMembershipError } = await db
    .from('chat_participants')
    .select('conversation_id')
    .eq('member_id', actor.id);

  if (actorMembershipError) throw actorMembershipError;

  const candidateIds = (actorMembership || []).map(
    row => row.conversation_id
  );

  let conversation = null;

  if (candidateIds.length) {
    const { data: candidates, error: candidateError } = await db
      .from('chat_conversations')
      .select('id, company_id, conversation_type, name, created_at, updated_at')
      .eq('company_id', actor.company_id)
      .eq('conversation_type', 'private')
      .in('id', candidateIds);

    if (candidateError) throw candidateError;

    for (const candidate of candidates || []) {
      const { data: participants, error: participantsError } = await db
        .from('chat_participants')
        .select('member_id')
        .eq('conversation_id', candidate.id);

      if (participantsError) throw participantsError;

      const ids = (participants || [])
        .map(row => row.member_id)
        .sort();

      const wanted = [actor.id, memberId].sort();

      if (
        ids.length === 2 &&
        ids[0] === wanted[0] &&
        ids[1] === wanted[1]
      ) {
        conversation = candidate;
        break;
      }
    }
  }

  if (!conversation) {
    const { data, error } = await db
      .from('chat_conversations')
      .insert({
        company_id: actor.company_id,
        conversation_type: 'private',
        name: null
      })
      .select('id, company_id, conversation_type, name, created_at, updated_at')
      .single();

    if (error) throw error;
    conversation = data;
  }

  // Always make sure both people belong to the private conversation.
  const { error: participantError } = await db
    .from('chat_participants')
    .upsert(
      [
        {
          conversation_id: conversation.id,
          member_id: actor.id
        },
        {
          conversation_id: conversation.id,
          member_id: memberId
        }
      ],
      {
        onConflict: 'conversation_id,member_id',
        ignoreDuplicates: true
      }
    );

  if (participantError) throw participantError;

  return send(res, 200, {
    conversation,
    member: target
  });
}
async function handleChatConversations(req, res, db, actor) {
  const { data: memberships, error: membershipError } = await db
    .from('chat_participants')
    .select('conversation_id, last_read_at')
    .eq('member_id', actor.id);

  if (membershipError) throw membershipError;

  const conversationIds = (memberships || []).map(
    row => row.conversation_id
  );

  let conversations = [];

  if (conversationIds.length) {
    const { data, error } = await db
      .from('chat_conversations')
      .select('id, company_id, conversation_type, name, created_at, updated_at')
      .eq('company_id', actor.company_id)
      .in('id', conversationIds)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    conversations = data || [];
  }

  const { data: allowedMembers, error: memberError } = await db
    .from('members')
    .select('id, employee_id, name, email, role, active')
    .eq('company_id', actor.company_id)
    .eq('active', true);

  if (memberError) throw memberError;

  const memberMap = new Map(
    (allowedMembers || []).map(member => [member.id, member])
  );

  const enrichedConversations = [];

  for (const conversation of conversations) {
    let displayName = conversation.name || '';

    if (conversation.conversation_type === 'private') {
      const { data: participants, error: participantError } = await db
        .from('chat_participants')
        .select('member_id')
        .eq('conversation_id', conversation.id);

      if (participantError) throw participantError;

      const otherMemberId = (participants || [])
        .map(row => row.member_id)
        .find(id => id !== actor.id);

      const otherMember = otherMemberId
        ? memberMap.get(otherMemberId)
        : null;

      displayName =
        otherMember?.name ||
        otherMember?.employee_id ||
        'Private Chat';
    }

    enrichedConversations.push({
      ...conversation,
      displayName
    });
  }

  const unreadByConversation = {};

  for (const conversation of enrichedConversations) {
    const membership = memberships.find(
      row => row.conversation_id === conversation.id
    );

    let query = db
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .neq('sender_id', actor.id);

    if (membership?.last_read_at) {
      query = query.gt(
        'created_at',
        membership.last_read_at
      );
    }

    const { count, error } = await query;

    if (error) throw error;

    unreadByConversation[conversation.id] = Number(count || 0);
  }
  return send(res, 200, {
    conversations: enrichedConversations,
    members: allowedMembers || [],
    unreadByConversation
  });
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
      .select('id,company_id,member_id,assigned_by,title,task_date,hours,priority,status,notes,huddle_save_id,created_at,updated_at')
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
      priority: task.priority || 'Medium',
      status: task.status,
      notes: task.notes,
      huddleSaveId: task.huddle_save_id,
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
  try {
    await notify(db, {
      companyId: actor.company_id,
      recipientId: data.id,
      senderId: actor.id,
      type: 'system',
      message: `Welcome to the team, ${data.name}.`
    });
  } catch (notificationError) {
    console.error('Member created, but welcome notification failed:', notificationError);
  }

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
  const priority = cleanText(req.body?.priority, 20) || 'Medium';
  const huddleSaveId = cleanText(req.body?.huddleSaveId, 160);

  if (!(await canAssignTo(db, actor, memberId))) return send(res, 403, { error: 'You cannot assign a task to this member.' });
  if (!title) return send(res, 400, { error: 'Task name is required.' });
  if (!validDate(date)) return send(res, 400, { error: 'Choose a valid task date.' });
const [taskYear, taskMonth, taskDay] = date.split('-').map(Number);
const taskDateObject = new Date(Date.UTC(taskYear, taskMonth - 1, taskDay));

  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
  return send(res, 400, {
    error: 'Hours must be between 0 and 24.'
  });
}

if (!['High', 'Medium', 'Low'].includes(priority)) {
  return send(res, 400, {
    error: 'Invalid task priority.'
  });
}

const allowedDurations = {
  High: [4, 4.5, 5, 5.5, 6],
  Medium: [0.5, 2 / 3, 0.75],
  Low: [0.25, 1 / 3, 5 / 12]
};

if (!allowedDurations[priority].some(value => Math.abs(hours - value) < 0.000001)) {
  return send(res, 400, {
    error: `Invalid ${priority} priority task duration.`
  });
}

if (!['Pending', 'In Progress', 'Completed', 'On Hold', 'Review'].includes(status)) {
  return send(res, 400, {
    error: 'Invalid task status.'
  });
}

  const { data: attendance } = await db
    .from('attendance')
    .select('finished_at')
    .eq('member_id', memberId)
    .eq('work_date', date)
    .maybeSingle();
  if (attendance?.finished_at && actor.role === 'sales') return send(res, 409, { error: 'That work day has already been finished.' });

  if (huddleSaveId) {
    const { data: existingHuddleTask, error: existingHuddleError } = await db
      .from('tasks')
      .select('*')
      .eq('huddle_save_id', huddleSaveId)
      .eq('company_id', actor.company_id)
      .maybeSingle();

    if (existingHuddleError) throw existingHuddleError;

    if (existingHuddleTask) {
      return send(res, 200, { task: existingHuddleTask, alreadyExists: true });
    }
  }

  const { data, error } = await db.from('tasks').insert({
    company_id: actor.company_id,
    member_id: memberId,
    assigned_by: actor.id,
    title,
    task_date: date,
    hours,
    status,
    notes,
    priority,
    huddle_save_id: huddleSaveId || null
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
  if (req.body?.memberId !== undefined) {
    const newMemberId = cleanText(req.body.memberId, 60);

    if (!newMemberId) {
      return send(res, 400, { error: 'A valid team member is required.' });
    }

    if (!(await canAssignTo(db, actor, newMemberId))) {
      return send(res, 403, { error: 'You cannot assign a task to this member.' });
    }

    patch.member_id = newMemberId;
  }

  if (req.body?.title !== undefined) {
    patch.title = cleanText(req.body.title, 240);
    if (!patch.title) return send(res, 400, { error: 'Task name is required.' });
  }
  if (req.body?.hours !== undefined) {
    patch.hours = Number(req.body.hours);

    if (!Number.isFinite(patch.hours) || patch.hours < 0 || patch.hours > 24) {
      return send(res, 400, {
        error: 'Hours must be between 0 and 24.'
      });
    }

    const taskPriority = cleanText(
      req.body?.priority,
      20
    ) || existing.priority || 'Medium';

    const allowedDurations = {
      High: [4, 4.5, 5, 5.5, 6],
      Medium: [0.5, 2 / 3, 0.75],
      Low: [0.25, 1 / 3, 5 / 12]
    };

    if (!allowedDurations[taskPriority]) {
      return send(res, 400, {
        error: 'Invalid task priority.'
      });
    }

    if (!allowedDurations[taskPriority].some(
      value => Math.abs(patch.hours - value) < 0.000001
    )) {
      return send(res, 400, {
        error: `Invalid ${taskPriority} priority task duration.`
      });
    }
  }

  if (req.body?.priority !== undefined) {
    patch.priority = cleanText(req.body.priority, 20);

    if (!['High', 'Medium', 'Low'].includes(patch.priority)) {
      return send(res, 400, {
        error: 'Invalid task priority.'
      });
    }

    const effectiveHours =
      req.body?.hours !== undefined
        ? Number(req.body.hours)
        : Number(existing.hours);

    const allowedDurations = {
      High: [4, 4.5, 5, 5.5, 6],
      Medium: [0.5, 2 / 3, 0.75],
      Low: [0.25, 1 / 3, 5 / 12]
    };

    if (!allowedDurations[patch.priority].some(
      value => Math.abs(effectiveHours - value) < 0.000001
    )) {
      return send(res, 400, {
        error: `Invalid ${patch.priority} priority task duration.`
      });
    }
  }
  if (req.body?.status !== undefined) {
    patch.status = cleanText(req.body.status, 30);
    if (!['Pending','In Progress','Completed','On Hold','Review'].includes(patch.status)) return send(res, 400, { error: 'Invalid task status.' });
  }
  if (req.body?.notes !== undefined) patch.notes = cleanText(req.body.notes, 1500);
  if (req.body?.taskDate !== undefined) {
  patch.task_date = cleanText(req.body.taskDate, 10);

  if (!validDate(patch.task_date)) {
    return send(res, 400, {
      error: 'Choose a valid task date.'
    });
  }

  const [taskYear, taskMonth, taskDay] = patch.task_date.split('-').map(Number);
  const taskDateObject = new Date(
    Date.UTC(taskYear, taskMonth - 1, taskDay)
  );

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

  if (!(await canAccessMember(db, actor, memberId))) {
    return send(res, 403, { error: 'You cannot finish this member’s day.' });
  }

  if (actor.role === 'sales' && memberId !== actor.id) {
    return send(res, 403, { error: 'You can only finish your own day.' });
  }

  if (!validDate(workDate)) {
    return send(res, 400, { error: 'Choose a valid work date.' });
  }

  const { data: current } = await db
    .from('attendance')
    .select('*')
    .eq('member_id', memberId)
    .eq('work_date', workDate)
    .maybeSingle();

  if (!current?.login_time || !current?.logout_time) {
    return send(res, 400, {
      error: 'Select and save both login and logout times first.'
    });
  }

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

  return send(res, 200, {
    attendance: data
  });
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

  if (req.body?.googleMeetUrl !== undefined) {
    const url = cleanText(req.body.googleMeetUrl, 1000);

    if (url && !/^https:\/\/meet\.google\.com\/.+/i.test(url)) {
      return send(res, 400, { error: 'Enter a valid Google Meet URL.' });
    }

    patch.google_meet_url = url;
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

async function handleDailyPDF(req, res, db, actor) {
  const memberId = cleanText(req.query?.memberId || req.body?.memberId, 100);
  const date = cleanText(req.query?.date || req.body?.date, 20);

  if (!memberId || !validDate(date)) {
    return send(res, 400, {
      error: 'A valid team member and date are required.'
    });
  }

  let memberIds;

  if (memberId === 'all') {
    /*
     * "all" is a report filter, not a real member ID.
     * Owners and managers can generate the combined team report.
     */
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      return send(res, 403, {
        error: 'Only the Owner or Manager can generate the all-members report.'
      });
    }

    memberIds = await allowedMemberIds(db, actor);
  } else {
    if (!(await canAccessMember(db, actor, memberId))) {
      return send(res, 403, {
        error: 'You cannot access this team member report.'
      });
    }

    memberIds = [memberId];
  }

  const memberResults = await Promise.all(
    memberIds.map(async currentMemberId => {
      const [
        { data: member, error: memberError },
        { data: tasks, error: tasksError },
        { data: attendance, error: attendanceError }
      ] = await Promise.all([
        db
          .from('members')
          .select('id,employee_id,name,role')
          .eq('id', currentMemberId)
          .eq('company_id', actor.company_id)
          .single(),

        db
          .from('tasks')
          .select('id,title,task_date,hours,priority,status,notes')
          .eq('company_id', actor.company_id)
          .eq('member_id', currentMemberId)
          .eq('task_date', date)
          .order('created_at', { ascending: true }),

        db
          .from('attendance')
          .select('login_time,logout_time,finished_at')
          .eq('company_id', actor.company_id)
          .eq('member_id', currentMemberId)
          .eq('work_date', date)
          .maybeSingle()
      ]);

      if (memberError) throw memberError;
      if (tasksError) throw tasksError;
      if (attendanceError) throw attendanceError;

      return {
        member,
        tasks: Array.isArray(tasks) ? tasks : [],
        attendance
      };
    })
  );

  /*
   * Keep the existing single-member variables working.
   * For "all", the PDF renderer below will use memberResults.
   */
  const member = memberResults[0]?.member || null;
  const tasks = memberResults[0]?.tasks || [];
  const attendance = memberResults[0]?.attendance || null;

  const safeTasks = Array.isArray(tasks) ? tasks : [];

  const totalHours = safeTasks.reduce(
    (sum, task) => sum + Number(task.hours || 0),
    0
  );

  const completed = safeTasks.filter(
    task => task.status === 'Completed'
  ).length;

  const formatDuration = hours => {
    const totalMinutes = Math.round(Number(hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  };

  const cleanPDFText = value => {
    return String(value ?? '')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&amp;/gi, '&')
      .replace(/<[^>]*>/g, '')
      .trim();
  };

  const priorityLabel = value => {
    const priority = cleanPDFText(value);

    if (priority === 'High') return 'High';
    if (priority === 'Medium') return 'Medium';
    if (priority === 'Low') return 'Low';

    return '';
  };

  const filenameMember =
    memberId === 'all'
      ? 'All-Members'
      : cleanPDFText(member.name || 'Employee')
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-+|-+$/g, '');

  const filename =
    `Daily-Task-Report-${filenameMember || 'Employee'}-${date}.pdf`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  res.setHeader('Cache-Control', 'no-store');

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title:
        memberId === 'all'
          ? `Daily Task Report - All Members - ${date}`
          : `Daily Task Report - ${cleanPDFText(member.name)}`,
      Author: 'Vogue Interiors Team Productivity Portal'
    }
  });

  doc.pipe(res);

  const pageWidth = doc.page.width - 80;

  const renderMemberReport = (report, isFirst) => {
    if (!isFirst) {
      doc.addPage();
    }

    const reportMember = report.member;
    const reportTasks = Array.isArray(report.tasks)
      ? report.tasks
      : [];
    const reportAttendance = report.attendance || null;

    const reportTotalHours = reportTasks.reduce(
      (sum, task) => sum + Number(task.hours || 0),
      0
    );

    const reportCompleted = reportTasks.filter(
      task => task.status === 'Completed'
    ).length;

    doc
      .fontSize(20)
      .font('Helvetica-Bold')
      .fillColor('#000000')
      .text('Daily Task Report');

    doc.moveDown(0.5);

    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Employee: ${cleanPDFText(reportMember?.name || 'Employee')} (${cleanPDFText(reportMember?.employee_id || '')})`
      )
      .text(`Role: ${cleanPDFText(reportMember?.role || '')}`)
      .text(`Date: ${date}`)
      .text(
        `Login: ${
          reportAttendance?.login_time
            ? String(reportAttendance.login_time).slice(0, 5)
            : '-'
        }`
      )
      .text(
        `Logout: ${
          reportAttendance?.logout_time
            ? String(reportAttendance.logout_time).slice(0, 5)
            : '-'
        }`
      )
      .text(
        `Day: ${
          reportAttendance?.finished_at
            ? 'Finished'
            : 'Active'
        }`
      );

    doc.moveDown(1);

    const summaryY = doc.y;
    const boxWidth = (pageWidth - 20) / 3;

    [
      ['Tasks', String(reportTasks.length)],
      ['Completed', String(reportCompleted)],
      ['Task Time', formatDuration(reportTotalHours)]
    ].forEach((item, index) => {
      const x = 40 + index * (boxWidth + 10);

      doc
        .rect(x, summaryY, boxWidth, 48)
        .stroke();

      doc
        .fontSize(9)
        .font('Helvetica')
        .text(
          item[0],
          x + 10,
          summaryY + 9
        );

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(
          item[1],
          x + 10,
          summaryY + 24
        );
    });

    doc.y = summaryY + 65;

    const columns = [
      { label: '#', width: 25 },
      { label: 'Task', width: 185 },
      { label: 'Priority', width: 65 },
      { label: 'Duration', width: 60 },
      { label: 'Status', width: 75 },
      {
        label: 'Notes',
        width:
          pageWidth -
          25 -
          185 -
          65 -
          60 -
          75
      }
    ];

    const rowHeight = 32;
    let tableY = doc.y;

    const drawHeader = () => {
      let x = 40;

      doc
        .fontSize(8)
        .font('Helvetica-Bold');

      columns.forEach(column => {
        doc
          .rect(
            x,
            tableY,
            column.width,
            rowHeight
          )
          .stroke();

        doc.text(
          column.label,
          x + 4,
          tableY + 10,
          {
            width: column.width - 8,
            align: 'left'
          }
        );

        x += column.width;
      });

      tableY += rowHeight;
    };

    const drawRow = (task, taskIndex) => {
      if (
        tableY + rowHeight >
        doc.page.height - 55
      ) {
        doc.addPage();
        tableY = 40;
        drawHeader();
      }

      const values = [
        String(taskIndex + 1),
        cleanPDFText(task.title),
        priorityLabel(task.priority),
        formatDuration(task.hours),
        cleanPDFText(task.status),
        cleanPDFText(task.notes) || '-'
      ];

      let x = 40;

      doc
        .fontSize(7.5)
        .font('Helvetica');

      columns.forEach((column, index) => {
        doc
          .rect(
            x,
            tableY,
            column.width,
            rowHeight
          )
          .stroke();

        doc.text(
          values[index],
          x + 4,
          tableY + 6,
          {
            width: column.width - 8,
            height: rowHeight - 8,
            ellipsis: true
          }
        );

        x += column.width;
      });

      tableY += rowHeight;
    };

    drawHeader();

    if (!reportTasks.length) {
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(
          'No tasks recorded.',
          44,
          tableY + 10
        );

      tableY += rowHeight;
    } else {
      reportTasks.forEach(
        (task, index) =>
          drawRow(task, index)
      );
    }

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#666666')
      .text(
        'Generated from Vogue Interiors Team Productivity Portal.',
        40,
        doc.page.height - 35,
        {
          width: pageWidth
        }
      );
  };

  memberResults.forEach(
    (report, index) =>
      renderMemberReport(report, index === 0)
  );

  doc.end();
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

    if (action === 'chat.conversations' && req.method === 'GET') return await handleChatConversations(req, res, db, actor);
    if (action === 'chat.open' && req.method === 'POST') return await handleChatOpen(req, res, db, actor);
    if (action === 'chat.messages' && req.method === 'GET') return await handleChatMessages(req, res, db, actor);
    if (action === 'chat.send' && req.method === 'POST') return await handleChatSend(req, res, db, actor);
    if (action === 'chat.read' && req.method === 'POST') return await handleChatRead(req, res, db, actor);
    if (action === 'daily.pdf' && req.method === 'GET') return await handleDailyPDF(req, res, db, actor);
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
    return send(res, 500, { error: String(error?.message || error), detail: error?.code || error?.details || error?.hint || undefined });
  }
};
