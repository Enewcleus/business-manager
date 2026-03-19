// ── CRM ROUTES ────────────────────────────────────────────────
const crmRouter = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

crmRouter.get('/today', authMiddleware, async (req, res) => {
  const today = new Date(); today.setHours(0,0,0,0);
  const { role, name } = req.user;
  let query = supabase.from('crm_calls').select('*')
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    query = query.eq('crm_executive', name);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    callId: c.call_id, clientCode: c.client_code, clientName: c.client_name,
    callOutcome: c.call_outcome, sellerComment: c.seller_comment,
    severity: c.severity, nextFollowUp: c.next_follow_up,
    callDate: new Date(c.created_at).toLocaleString('en-IN'),
  })));
});

crmRouter.get('/my-calls', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('crm_calls').select('*')
    .eq('crm_executive', req.user.name)
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    callId: c.call_id, clientCode: c.client_code, clientName: c.client_name,
    callOutcome: c.call_outcome, sellerComment: c.seller_comment,
    subject: c.seller_comment, outcome: c.call_outcome,
    severity: c.severity, nextFollowUp: c.next_follow_up,
    created_at: c.created_at,
    callDate: new Date(c.created_at).toLocaleString('en-IN'),
  })));
});

crmRouter.get('/client/:code', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('crm_calls').select('*')
    .eq('client_code', req.params.code).order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    callId: c.call_id, callOutcome: c.call_outcome, sellerComment: c.seller_comment,
    severity: c.severity, nextFollowUp: c.next_follow_up, crmExecutive: c.crm_executive,
    callDate: new Date(c.created_at).toLocaleString('en-IN'),
  })));
});

crmRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  const { client } = req.query;
  let query = supabase.from('crm_calls').select('*').order('created_at', { ascending: false }).limit(500);
  if (client) query = query.eq('client_code', client);
  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) query = query.eq('crm_executive', name);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    call_id: c.call_id, client_code: c.client_code, client_name: c.client_name,
    crm_executive: c.crm_executive, call_outcome: c.call_outcome,
    seller_comment: c.seller_comment, severity: c.severity,
    next_follow_up: c.next_follow_up, created_at: c.created_at,
  })));
});

crmRouter.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const callId = 'CRM' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('crm_calls').insert({
    call_id: callId, client_code: d.clientCode, client_name: d.clientName,
    crm_executive: req.user.name, call_outcome: d.callOutcome || d.outcome || 'Connected',
    seller_comment: d.sellerComment || d.notes || d.subject || '',
    severity: d.severity || 'Low',
    next_follow_up: d.nextFollowUp || d.followupDate || null,
    ticket_raised: d.ticketRaised || false,
  });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('activity_log').insert({
    client_code: d.clientCode, client_name: d.clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: 'CRM Call',
    action_detail: (d.callOutcome || d.outcome || 'Connected') + (d.sellerComment || d.notes ? ' — ' + (d.sellerComment || d.notes) : ''),
  });
  res.json({ success: true, callId });
});

crmRouter.post('/log', authMiddleware, async (req, res) => {
  const d = req.body;
  const callId = 'CRM' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('crm_calls').insert({
    call_id: callId,
    client_code: d.clientCode,
    client_name: d.clientName,
    crm_executive: req.user.name,
    call_outcome: d.outcome || 'Connected',
    seller_comment: (d.subject ? d.subject + (d.description ? ' | ' + d.description : '') : d.description || ''),
    severity: 'Low',
    next_follow_up: d.followupDate || null,
    ticket_raised: false,
  });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('activity_log').insert({
    client_code: d.clientCode, client_name: d.clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: 'Call Log', action_detail: d.subject || d.outcome || 'Call logged',
  }).catch(() => {});
  res.json({ success: true, callId });
});

// ── CSI ROUTES ────────────────────────────────────────────────
const csiRouter = require('express').Router();

csiRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('csi_data').select('*').order('review_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const map = {};
  data.forEach(r => { if (!map[r.client_code]) map[r.client_code] = r; });
  res.json(Object.values(map).map(r => ({
    csiId: r.csi_id, clientCode: r.client_code, clientName: r.client_name,
    reviewedBy: r.reviewed_by, q1: r.q1, q2: r.q2, q3: r.q3, q4: r.q4, q5: r.q5,
    csiScore: r.csi_score, csiPercent: r.csi_percent, healthStatus: r.health_status,
    remarks: r.remarks, nextReviewDate: r.next_review_date,
    reviewDate: r.review_date ? new Date(r.review_date).toLocaleDateString('en-IN') : '',
  })));
});

csiRouter.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const csiId = 'CSI' + Date.now().toString().slice(-7);
  const { data: existing } = await supabase.from('csi_data').select('id').eq('client_code', d.clientCode).single();
  if (existing) {
    await supabase.from('csi_data').update({
      reviewed_by: req.user.name, q1: d.q1, q2: d.q2, q3: d.q3, q4: d.q4, q5: d.q5,
      csi_score: d.csiScore, csi_percent: d.csiPercent, health_status: d.healthStatus,
      remarks: d.remarks, review_date: new Date(), next_review_date: d.nextReviewDate || null,
    }).eq('client_code', d.clientCode);
  } else {
    await supabase.from('csi_data').insert({
      csi_id: csiId, client_code: d.clientCode, client_name: d.clientName,
      reviewed_by: req.user.name, q1: d.q1, q2: d.q2, q3: d.q3, q4: d.q4, q5: d.q5,
      csi_score: d.csiScore, csi_percent: d.csiPercent, health_status: d.healthStatus,
      remarks: d.remarks, next_review_date: d.nextReviewDate || null,
    });
  }
  await supabase.from('clients').update({ health_status: d.healthStatus, health_index: d.csiPercent, last_updated: new Date() }).eq('client_code', d.clientCode);
  await supabase.from('activity_log').insert({
    client_code: d.clientCode, client_name: d.clientName, user_name: req.user.name, user_role: req.user.role,
    action_type: 'CSI Review', action_detail: `CSI Score: ${d.csiPercent}% — ${d.healthStatus}`,
  });
  res.json({ success: true, csiId });
});

// ── TASKS ROUTES ──────────────────────────────────────────────
const tasksRouter = require('express').Router();

// GET /api/tasks/ads — Ads department tasks only
tasksRouter.get('/ads', authMiddleware, async (req, res) => {
  try {
    const { role, name } = req.user;
    const ADS_CATEGORIES = [
      'Campaign Optimization','New Campaign Live','Campaign Paused',
      'Keyword Research','A/B Testing','Report Review','Client Approval Pending'
    ];
    let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (!['Admin','Ops Lead','CSI Lead','SME','Team Lead','Senior Executive'].includes(role)) {
      query = query.or(`assigned_to.eq.${name},assigned_by.eq.${name}`);
    }
    const { data, error } = await query.limit(500);
    if (error) return res.status(500).json({ error: error.message });
    const now = new Date();
    const filtered = (data||[]).filter(t => ADS_CATEGORIES.includes(t.category));
    res.json(filtered.map(t => ({
      taskId: t.task_id, title: t.title, description: t.description,
      clientCode: t.client_code, clientName: t.client_name,
      assignedTo: t.assigned_to, assignedBy: t.assigned_by,
      priority: t.priority, category: t.category, status: t.status,
      deadline: t.deadline,
      isOverdue: t.deadline && t.status !== 'Done' && t.status !== 'Completed' ? new Date(t.deadline) < now : false,
      createdAt: new Date(t.created_at).toLocaleString('en-IN'),
    })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ GET /api/tasks — now includes parentTaskId for sub-task support
tasksRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    query = query.or(`assigned_to.eq.${name},assigned_by.eq.${name}`);
  }
  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  const now = new Date();
  res.json(data.map(t => ({
    taskId: t.task_id,
    title: t.title,
    description: t.description,
    clientCode: t.client_code,
    clientName: t.client_name,
    assignedTo: t.assigned_to,
    assignedToRole: t.assigned_to_role,
    assignedBy: t.assigned_by,
    assignedByRole: t.assigned_by_role,
    priority: t.priority,
    category: t.category,
    status: t.status,
    deadline: t.deadline,
    workLog: t.work_log,
    // ✅ NEW: sub-task support
    parentTaskId: t.parent_task_id || null,
    isOverdue: t.deadline && t.status !== 'Completed' ? new Date(t.deadline) < now : false,
    createdAt: new Date(t.created_at).toLocaleString('en-IN'),
    completedAt: t.completed_at ? new Date(t.completed_at).toLocaleString('en-IN') : '',
  })));
});

// ✅ POST /api/tasks — now saves parentTaskId for sub-tasks
tasksRouter.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const taskId = 'TSK' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('tasks').insert({
    task_id: taskId,
    title: d.title,
    description: d.description,
    client_code: d.clientCode || null,
    client_name: d.clientName || null,
    assigned_to: d.assignedTo || req.user.name,
    assigned_to_role: d.assignedToRole || req.user.role,
    assigned_by: req.user.name,
    assigned_by_role: req.user.role,
    priority: d.priority || 'Medium',
    category: d.category || 'General',
    deadline: d.deadline || d.dueDate || null,
    // ✅ NEW: save parent_task_id for sub-tasks
    parent_task_id: d.parentTaskId || null,
  });
  if (error) return res.status(500).json({ error: error.message });
  // Send notification if assigning to someone else
  if (d.assignedTo && d.assignedTo !== req.user.name) {
    await supabase.from('notifications').insert({
      notif_id: 'NTF' + Date.now(),
      assigned_to: d.assignedTo,
      assigned_role: d.assignedToRole,
      type: 'NEW_TASK',
      message: `New task from ${req.user.name}: "${d.title}"`,
      related_id: taskId,
    }).catch(() => {});
  }
  res.json({ success: true, taskId });
});

// ✅ PATCH /api/tasks/:id — now supports full edit (title, assignedTo, priority, deadline, status)
tasksRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { status, workLog, title, assignedTo, priority, deadline } = req.body;
  const updates = {};

  // Status update
  if (status !== undefined) updates.status = status;
  if (workLog) updates.work_log = workLog;
  if (status === 'Completed') updates.completed_at = new Date();

  // ✅ NEW: Full edit fields (Admin/Lead use)
  if (title !== undefined) updates.title = title;
  if (assignedTo !== undefined) updates.assigned_to = assignedTo;
  if (priority !== undefined) updates.priority = priority;
  if (deadline !== undefined) updates.deadline = deadline || null;

  const { error } = await supabase.from('tasks').update(updates).eq('task_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/tasks/worklog
tasksRouter.get('/worklog', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('work_log').select('*').order('created_at', { ascending: false }).limit(100);
  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) query = query.eq('executive_name', name);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(l => ({
    logId: l.log_id, executiveName: l.executive_name, executiveRole: l.executive_role,
    clientCode: l.client_code, clientName: l.client_name, workType: l.work_type,
    description: l.description, outcome: l.outcome, timeSpent: l.time_spent,
    loggedAt: new Date(l.created_at).toLocaleString('en-IN'),
  })));
});

// POST /api/tasks/worklog
tasksRouter.post('/worklog', authMiddleware, async (req, res) => {
  const d = req.body;
  const logId = 'WRK' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('work_log').insert({
    log_id: logId, executive_name: req.user.name, executive_role: req.user.role,
    client_code: d.clientCode || null, client_name: d.clientName || null,
    work_type: d.workType, description: d.description,
    outcome: d.outcome || null, time_spent: d.timeSpent ? parseInt(d.timeSpent) : null,
  });
  if (error) return res.status(500).json({ error: error.message });
  if (d.clientCode) {
    await supabase.from('activity_log').insert({
      client_code: d.clientCode, client_name: d.clientName,
      user_name: req.user.name, user_role: req.user.role,
      action_type: d.workType, action_detail: d.description,
    });
  }
  res.json({ success: true, logId });
});

// ── DASHBOARD ROUTES ──────────────────────────────────────────
const dashRouter = require('express').Router();

dashRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  try {
    let clientQuery = supabase.from('clients').select('health_status, status');
    if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
      if (role === 'Account Manager') clientQuery = clientQuery.eq('am_name', name);
      else if (role === 'CRM Executive') clientQuery = clientQuery.eq('crm_executive', name);
      else if (role === 'Ads Executive') clientQuery = clientQuery.eq('ads_manager', name);
      else clientQuery = clientQuery.or(`am_name.eq.${name},ads_manager.eq.${name},crm_executive.eq.${name}`);
    }
    const [{ data: clients }, { data: tickets }, { data: renewals }] = await Promise.all([
      clientQuery,
      supabase.from('tickets').select('status, priority').neq('status', 'Done'),
      supabase.from('renewals').select('renewal_date, status').eq('status', 'Pending'),
    ]);
    const total = clients?.length || 0;
    const active = clients?.filter(c => c.status === 'Active').length || 0;
    const healthy = clients?.filter(c => c.health_status === 'Healthy').length || 0;
    const warning = clients?.filter(c => c.health_status === 'Warning').length || 0;
    const atRisk = clients?.filter(c => c.health_status === 'At Risk').length || 0;
    const openTickets = tickets?.length || 0;
    const now = new Date();
    const renewalsDue = renewals?.filter(r => {
      if (!r.renewal_date) return false;
      const days = Math.ceil((new Date(r.renewal_date) - now) / 86400000);
      return days <= 15 && days >= 0;
    }).length || 0;
    res.json({
      totalClients: total, active, healthy, warning, atRisk,
      openTickets, overdueTickets: 0, renewalsDue, activeToday: 0,
      healthDistribution: [
        { label: 'Healthy', value: healthy, color: '#27ae60' },
        { label: 'Warning', value: warning, color: '#f39c12' },
        { label: 'At Risk', value: atRisk, color: '#e74c3c' },
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

dashRouter.get('/team', authMiddleware, async (req, res) => {
  const { data: users } = await supabase.from('users').select('name, role').eq('is_active', true)
    .in('role', ['Account Manager', 'Ads Executive', 'CRM Executive', 'SME', 'Team Lead', 'Senior Executive', 'Ops Lead', 'CSI Lead', 'Executive']);
  if (!users) return res.json([]);
  const today = new Date(); today.setHours(0,0,0,0);
  const result = await Promise.all(users.map(async u => {
    const [{ count: activity }, { data: tickets }] = await Promise.all([
      supabase.from('activity_log').select('*', { count: 'exact', head: true })
        .eq('user_name', u.name).gte('created_at', today.toISOString()),
      supabase.from('tickets').select('status, created_at').eq('assigned_to', u.name),
    ]);
    const closed = tickets?.filter(t => t.status === 'Done').length || 0;
    const overdue = tickets?.filter(t => t.status !== 'Done').length || 0;
    return { name: u.name, role: u.role, todayActivity: activity || 0, ticketsClosed: closed, ticketsOverdue: overdue, performanceScore: activity > 0 ? 'Active' : 'No Activity' };
  }));
  res.json(result);
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
const notifRouter = require('express').Router();

notifRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('notifications').select('*')
    .or(`assigned_to.eq.${req.user.name},assigned_role.eq.${req.user.role}`)
    .eq('is_read', false).order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(n => ({
    notifId: n.notif_id, type: n.type, message: n.message,
    relatedId: n.related_id, createdAt: new Date(n.created_at).toLocaleString('en-IN'),
  })));
});

notifRouter.patch('/:id/read', authMiddleware, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true }).eq('notif_id', req.params.id);
  res.json({ success: true });
});

// ── USERS ─────────────────────────────────────────────────────
const usersRouter = require('express').Router();

usersRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('user_code, name, email, role, designation, department, reporting_to_name, is_active, last_login').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(u => ({
    userId: u.user_code, name: u.name, email: u.email, role: u.role,
    designation: u.designation, department: u.department,
    reportingToName: u.reporting_to_name, isActive: u.is_active,
  })));
});

usersRouter.get('/hierarchy', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('user_code, name, role, designation, department, reporting_to_name, is_active').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(u => ({
    userId: u.user_code, name: u.name, role: u.role,
    designation: u.designation, department: u.department,
    reportingToName: u.reporting_to_name, isActive: u.is_active,
  })));
});

usersRouter.post('/', authMiddleware, async (req, res) => {
  const { name, email, password, role, designation, department, reportingToName } = req.body;
  const userCode = 'USR' + Date.now().toString().slice(-5);
  const { error } = await supabase.from('users').insert({
    user_code: userCode, name, email: email.toLowerCase(),
    password_hash: password, role,
    designation: designation || null,
    department: department || null,
    reporting_to_name: reportingToName || null,
    is_active: true,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, userId: userCode });
});

usersRouter.patch('/:code', authMiddleware, async (req, res) => {
  const { name, role, designation, department, reportingToName, isActive } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (role !== undefined) updates.role = role;
  if (designation !== undefined) updates.designation = designation;
  if (department !== undefined) updates.department = department;
  if (reportingToName !== undefined) updates.reporting_to_name = reportingToName;
  if (isActive !== undefined) updates.is_active = isActive;
  const { error } = await supabase.from('users').update(updates).eq('user_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

usersRouter.patch('/:code/password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  const { error } = await supabase.from('users').update({ password_hash: password }).eq('user_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RENEWALS ─────────────────────────────────────────────────
const renewalsRouter = require('express').Router();

renewalsRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('renewals').select('*').order('renewal_date');
  if (error) return res.status(500).json({ error: error.message });
  const now = new Date();
  res.json(data.map(r => {
    const daysLeft = r.renewal_date ? Math.ceil((new Date(r.renewal_date) - now) / 86400000) : null;
    const isOverdue = daysLeft !== null && daysLeft < 0;
    const isDueSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 15;
    return {
      renewalId: r.renewal_id, clientCode: r.client_code, clientName: r.client_name,
      servicePlan: r.service_plan, amount: r.amount, renewalDate: r.renewal_date,
      status: r.status, owner: r.owner, daysLeft, isOverdue, isDueSoon,
    };
  }));
});

renewalsRouter.get('/stats', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('renewals').select('amount, status').eq('status', 'Confirmed');
  if (error) return res.status(500).json({ error: error.message });
  const totalValue = (data||[]).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  res.json({ totalValue, count: data?.length || 0 });
});

renewalsRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { status, notes, amount, renewalDate } = req.body;
  const updates = { updated_at: new Date() };
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (amount !== undefined) updates.amount = amount;
  if (renewalDate !== undefined) updates.renewal_date = renewalDate || null;
  const { error } = await supabase.from('renewals').update(updates).eq('renewal_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

renewalsRouter.post('/trigger-reminders', authMiddleware, async (req, res) => {
  const { data: renewals } = await supabase.from('renewals').select('*').eq('status', 'Pending');
  const now = new Date();
  let sent = 0;
  for (const r of (renewals||[])) {
    if (!r.renewal_date) continue;
    const days = Math.ceil((new Date(r.renewal_date) - now) / 86400000);
    if (days <= 15) {
      await supabase.from('notifications').insert({
        notif_id: 'NTF' + Date.now() + sent,
        assigned_role: 'Admin',
        type: 'RENEWAL_ALERT',
        message: `Renewal due in ${days} days: ${r.client_name}`,
        related_id: r.renewal_id,
      }).catch(() => {});
      sent++;
    }
  }
  res.json({ success: true, reminders_sent: sent });
});

// ── ADS ───────────────────────────────────────────────────────
const adsRouter = require('express').Router();

adsRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('ads_data').select('*').order('client_name');
  if (role === 'Ads Executive') query = query.eq('ads_manager', name);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(a => ({
    clientCode: a.client_code, clientName: a.client_name, marketplace: a.marketplace,
    adsManager: a.ads_manager, budgetAllocated: a.budget_allocated, budgetSpent: a.budget_spent,
    budgetPercent: a.budget_percent, acos: a.acos, campaignStatus: a.campaign_status,
  })));
});
adsRouter.patch('/:clientCode', authMiddleware, async (req, res) => {
  const { clientCode } = req.params;
  const { status } = req.body;
  const { error } = await supabase.from('ads_data').update({ status }).eq('client_code', clientCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
module.exports = { crmRouter, csiRouter, tasksRouter, dashRouter, notifRouter, usersRouter, renewalsRouter, adsRouter };
clientsRouter.patch('/:clientCode', authMiddleware, async (req, res) => {
  const { clientCode } = req.params;
  const { amName, crmExecutive, adsManager } = req.body;
  const updates = {};
  if (amName !== undefined) updates.am_name = amName;
  if (crmExecutive !== undefined) updates.crm_executive = crmExecutive;
  if (adsManager !== undefined) updates.ads_manager = adsManager;
  const { error } = await supabase.from('clients').update(updates).eq('client_code', clientCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
