// ── CRM ROUTES ────────────────────────────────────────────────
const crmRouter = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

const clientsRouter = require('express').Router();
crmRouter.get('/today', authMiddleware, async (req, res) => {
  const today = new Date(); today.setHours(0,0,0,0);
  const { role, name } = req.user;
  let query = supabase.from('crm_calls').select('*')
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'CRM Executive', 'Sub Admin', 'Team Lead', 'SME', 'Viewer'].includes(role)) {
    query = query.eq('crm_executive', name);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    callId: c.call_id, clientCode: c.client_code, clientName: c.client_name,
    callOutcome: c.call_outcome, sellerComment: c.seller_comment,
    severity: c.severity, nextFollowUp: c.next_follow_up,
    crmExecutive: c.crm_executive,
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
  if (!['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'CRM Executive', 'Sub Admin', 'Team Lead', 'SME', 'Viewer'].includes(role)) query = query.eq('crm_executive', name);
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
  try {
    await supabase.from('activity_log').insert({
      client_code: d.clientCode, client_name: d.clientName,
      user_name: req.user.name, user_role: req.user.role,
      action_type: 'CRM Call',
      action_detail: (d.callOutcome || d.outcome || 'Connected') + (d.sellerComment || d.notes ? ' — ' + (d.sellerComment || d.notes) : ''),
    });
  } catch(e) {}
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
  try {
    await supabase.from('activity_log').insert({
      client_code: d.clientCode, client_name: d.clientName,
      user_name: req.user.name, user_role: req.user.role,
      action_type: 'Call Log', action_detail: d.subject || d.outcome || 'Call logged',
    });
  } catch(e) {}
  res.json({ success: true, callId });
});

// ── CSI ROUTES ────────────────────────────────────────────────
const csiRouter = require('express').Router();

csiRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('csi_data').select('*').order('review_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // For main list — latest NON-note record per client
  const map = {};
  data.forEach(r => {
    if (!r.is_note && !map[r.client_code]) map[r.client_code] = r;
  });
  // Also include latest note if no non-note exists
  data.forEach(r => {
    if (!map[r.client_code]) map[r.client_code] = r;
  });

  const format = r => ({
    csiId: r.csi_id, clientCode: r.client_code, clientName: r.client_name,
    reviewedBy: r.reviewed_by, q1: r.q1, q2: r.q2, q3: r.q3, q4: r.q4, q5: r.q5,
    csiScore: r.csi_score, csiPercent: r.csi_percent, healthStatus: r.health_status,
    remarks: r.remarks, nextReviewDate: r.next_review_date,
    actionTaken: r.action_taken || null,
    actionStatus: r.action_status || null,
    isNote: r.is_note || false,
    reviewDate: r.review_date ? new Date(r.review_date).toLocaleDateString('en-IN') : '',
  });

  // Return array (backward compatible) with _all embedded
  const list = Object.values(map).map(format);
  list._all = data.map(format); // attach full history
  res.json(list);
});

// GET /api/csi/history/:clientCode — full history including notes
csiRouter.get('/history/:clientCode', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('csi_data')
      .select('*').eq('client_code', req.params.clientCode)
      .order('review_date', { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data||[]).map(r => ({
      csiId: r.csi_id, clientCode: r.client_code, clientName: r.client_name,
      reviewedBy: r.reviewed_by, q1: r.q1, q2: r.q2, q3: r.q3, q4: r.q4, q5: r.q5,
      csiScore: r.csi_score, csiPercent: r.csi_percent, healthStatus: r.health_status,
      remarks: r.remarks, actionTaken: r.action_taken || null,
      actionStatus: r.action_status || null, isNote: r.is_note || false,
      reviewDate: r.review_date ? new Date(r.review_date).toLocaleDateString('en-IN') : '',
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  try {
    await supabase.from('activity_log').insert({
      client_code: d.clientCode, client_name: d.clientName, user_name: req.user.name, user_role: req.user.role,
      action_type: 'CSI Review', action_detail: `CSI Score: ${d.csiPercent}% — ${d.healthStatus}`,
    });
  } catch(e) {}
  res.json({ success: true, csiId });
});

// ── TASKS ROUTES ──────────────────────────────────────────────
const tasksRouter = require('express').Router();

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

tasksRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'Sub Admin', 'Team Lead', 'SME'].includes(role)) {
    query = query.or(`assigned_to.ilike.%${name}%,assigned_by.ilike.%${name}%`);
  }
  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  const now = new Date();
  res.json(data.map(t => ({
    taskId: t.task_id, title: t.title, description: t.description,
    clientCode: t.client_code, clientName: t.client_name,
    assignedTo: t.assigned_to, assignedToRole: t.assigned_to_role,
    assignedBy: t.assigned_by, assignedByRole: t.assigned_by_role,
    priority: t.priority, category: t.category, status: t.status,
    deadline: t.deadline, workLog: t.work_log,
    parentTaskId: t.parent_task_id || null,
    isOverdue: t.deadline && t.status !== 'Completed' ? new Date(t.deadline) < now : false,
    createdAt: new Date(t.created_at).toLocaleString('en-IN'),
    completedAt: t.completed_at ? new Date(t.completed_at).toLocaleString('en-IN') : '',
  })));
});

tasksRouter.post('/', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const taskId = 'TSK' + Date.now().toString().slice(-7);
    const { error } = await supabase.from('tasks').insert({
      task_id: taskId, title: d.title, description: d.description,
      client_code: d.clientCode || null, client_name: d.clientName || null,
      assigned_to: d.assignedTo || req.user.name,
      assigned_to_role: d.assignedToRole || req.user.role,
      assigned_by: req.user.name, assigned_by_role: req.user.role,
      priority: d.priority || 'Medium', category: d.category || 'General',
      deadline: d.deadline || d.dueDate || null,
      parent_task_id: d.parentTaskId || null,
    });
    if (error) return res.status(500).json({ error: error.message });
    if (d.assignedTo && d.assignedTo !== req.user.name) {
      supabase.from('notifications').insert({
        notif_id: 'NTF' + Date.now(),
        assigned_to: d.assignedTo,
        assigned_role: d.assignedToRole,
        type: 'NEW_TASK',
        message: `New task from ${req.user.name}: "${d.title}"`,
        related_id: taskId,
      }).then(() => {}).catch(() => {});
    }
    res.json({ success: true, taskId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

tasksRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { status, workLog, title, assignedTo, priority, deadline } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (workLog) updates.work_log = workLog;
  if (status === 'Completed') updates.completed_at = new Date();
  if (title !== undefined) updates.title = title;
  if (assignedTo !== undefined) updates.assigned_to = assignedTo;
  if (priority !== undefined) updates.priority = priority;
  if (deadline !== undefined) updates.deadline = deadline || null;
  const { error } = await supabase.from('tasks').update(updates).eq('task_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

tasksRouter.get('/worklog', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  const { from, to, exec } = req.query;

  const leadRoles = ['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'Sub Admin', 'Team Lead', 'Viewer'];
  const isLead = leadRoles.includes(role);

  let query = supabase.from('work_log').select('*').order('created_at', { ascending: false }).limit(500);

  // Date filter
  if (from) query = query.gte('created_at', from + 'T00:00:00');
  if (to)   query = query.lte('created_at', to + 'T23:59:59');

  // Role filter
  if (!isLead) {
    query = query.eq('executive_name', name);
  } else if (exec) {
    query = query.eq('executive_name', exec);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(l => ({
    logId: l.log_id, executiveName: l.executive_name, executiveRole: l.executive_role,
    clientCode: l.client_code, clientName: l.client_name, workType: l.work_type,
    description: l.description, outcome: l.outcome, timeSpent: l.time_spent,
    loggedAt: new Date(l.created_at).toLocaleString('en-IN'),
    logDate: new Date(l.created_at).toISOString().split('T')[0],
  })));
});

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
    try {
      await supabase.from('activity_log').insert({
        client_code: d.clientCode, client_name: d.clientName,
        user_name: req.user.name, user_role: req.user.role,
        action_type: d.workType, action_detail: d.description,
      });
    } catch(e) {}
  }
  res.json({ success: true, logId });
});

// ── DASHBOARD ROUTES ──────────────────────────────────────────
const dashRouter = require('express').Router();

dashRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  try {
    let clientQuery = supabase.from('clients').select('health_status, status');
    if (!['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'CRM Executive'].includes(role)) {
      if (role === 'Account Manager') clientQuery = clientQuery.eq('am_name', name);
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
  const { data, error } = await supabase.from('users').select('user_code, name, email, role, designation, department, reporting_to_name, is_active, last_login, joining_date').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(u => {
    const today = new Date();
    const joining = u.joining_date ? new Date(u.joining_date) : null;
    const staffAgingDays = joining ? Math.floor((today - joining) / 86400000) : null;
    const staffAgingYears = staffAgingDays ? Math.floor(staffAgingDays / 365) : null;
    const staffAgingMonths = staffAgingDays ? Math.floor((staffAgingDays % 365) / 30) : null;
    return {
      userId: u.user_code, name: u.name, email: u.email, role: u.role,
      designation: u.designation, department: u.department,
      reportingToName: u.reporting_to_name, isActive: u.is_active,
      joiningDate: u.joining_date || null,
      staffAgingDays,
      staffAgingLabel: staffAgingDays
        ? (staffAgingYears > 0
            ? staffAgingYears + 'y ' + staffAgingMonths + 'm'
            : staffAgingMonths + ' months')
        : '—',
    };
  }));
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
      crmComment: r.crm_comment || null,
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
  const { status, notes, amount, renewalDate, crmComment, paymentDate, paymentMode, utrNumber, paymentBank, paymentRemarks } = req.body;
  const updates = { updated_at: new Date() };
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (amount !== undefined) updates.amount = amount;
  if (renewalDate !== undefined) updates.renewal_date = renewalDate || null;
  if (crmComment !== undefined) updates.crm_comment = crmComment;
  if (utrNumber !== undefined) updates.utr_number = utrNumber;
  if (paymentDate !== undefined) updates.payment_date = paymentDate;
  if (paymentMode !== undefined) updates.payment_mode = paymentMode;
  if (paymentBank !== undefined) updates.payment_bank = paymentBank;
  if (paymentRemarks !== undefined) updates.payment_remarks = paymentRemarks;
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
      try {
        await supabase.from('notifications').insert({
          notif_id: 'NTF' + Date.now() + sent,
          assigned_role: 'Admin',
          type: 'RENEWAL_ALERT',
          message: `Renewal due in ${days} days: ${r.client_name}`,
          related_id: r.renewal_id,
        });
      } catch(e) {}
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

clientsRouter.patch('/:clientCode', authMiddleware, async (req, res) => {
  const { clientCode } = req.params;
  const { amName, crmExecutive, adsManager, busyName, marketplace, servicePlan, renewalDate, status } = req.body;
  const updates = {};
  if (amName !== undefined) updates.am_name = amName;
  if (crmExecutive !== undefined) updates.crm_executive = crmExecutive;
  if (adsManager !== undefined) updates.ads_manager = adsManager;
  if (busyName !== undefined) updates.busy_name = busyName;
  if (marketplace !== undefined) updates.marketplace = marketplace;
  if (servicePlan !== undefined) updates.service_plan = servicePlan;
  if (renewalDate !== undefined) updates.renewal_date = renewalDate || null;
  if (status !== undefined) updates.status = status;
  const { error } = await supabase.from('clients').update(updates).eq('client_code', clientCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── HURDLE TRACKER ────────────────────────────────────────────
const hurdleRouter = require('express').Router();

hurdleRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('hurdles').select('*').order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'SME', 'Team Lead'].includes(role)) {
    query = query.eq('added_by', name);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

hurdleRouter.post('/', authMiddleware, async (req, res) => {
  const { clientCode, clientName, description, emailSent, emailDate, emailSubject } = req.body;
  if (!clientCode || !description) return res.status(400).json({ error: 'clientCode and description required' });
  if (!emailSent) return res.status(400).json({ error: 'Email confirmation required before adding hurdle' });
  const { data, error } = await supabase.from('hurdles').insert({
    client_code: clientCode, client_name: clientName, description,
    email_sent: emailSent, email_date: emailDate || null, email_subject: emailSubject || '',
    added_by: req.user.name, status: 'Open', attempts: []
  }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, hurdle: data?.[0] });
});

hurdleRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, attempt } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (attempt) {
    const { data: existing } = await supabase.from('hurdles').select('attempts').eq('id', id).single();
    const attempts = existing?.attempts || [];
    attempts.push({ ...attempt, addedBy: req.user.name, date: new Date().toISOString() });
    updates.attempts = attempts;
  }
  const { error } = await supabase.from('hurdles').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

hurdleRouter.delete('/:id', authMiddleware, async (req, res) => {
  if (!['Admin', 'Ops Lead'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
  const { error } = await supabase.from('hurdles').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RENEWAL HISTORY REPORTS ───────────────────────────────────
const renewalHistoryRouter = require('express').Router();

renewalHistoryRouter.get('/', authMiddleware, async (req, res) => {
  try {
    const { from, to, executive, marketplace, mis } = req.query;
    let q = supabase.from('renewal_history').select('*').order('service_start_date', { ascending: false });
    if (from) q = q.gte('service_start_date', from);
    if (to)   q = q.lte('service_start_date', to);
    if (executive) q = q.ilike('am_name', `%${executive}%`);
    if (marketplace) q = q.ilike('marketplace', `%${marketplace}%`);
    if (mis) q = q.eq('mis_status', mis);
    const { data, error } = await q.limit(3000);
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SELLER EXPECTATIONS ──────────────────────────────────────
const expectationsRouter = require('express').Router();

// GET /api/expectations/:clientCode
expectationsRouter.get('/:clientCode', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('seller_expectations')
      .select('*').eq('client_code', req.params.clientCode)
      .order('created_at', { ascending: false }).limit(1).single();
    if (error && error.code !== 'PGRST116') throw error;
    res.json(data || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expectations/:clientCode/history
expectationsRouter.get('/:clientCode/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('seller_expectations_history')
      .select('*').eq('client_code', req.params.clientCode)
      .order('changed_at', { ascending: false }).limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expectations — create or update
expectationsRouter.post('/', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    if (!d.clientCode) return res.status(400).json({ error: 'clientCode required' });

    // Check existing
    const { data: existing } = await supabase.from('seller_expectations')
      .select('id').eq('client_code', d.clientCode).single();

    const payload = {
      client_code: d.clientCode,
      client_name: d.clientName || d.clientCode,
      sales_growth_target: d.salesGrowthTarget || null,
      ads_acos_target: d.adsAcosTarget || null,
      listing_improvement: d.listingImprovement || null,
      inventory_management: d.inventoryManagement || null,
      brand_building: d.brandBuilding || null,
      customer_rating_target: d.customerRatingTarget || null,
      revenue_target: d.revenueTarget || null,
      additional_notes: d.additionalNotes || null,
      special_requests: d.specialRequests || null,
      fill_type: d.fillType || 'onboarding',
      updated_at: new Date().toISOString(),
      updated_by: req.user.name,
      updated_by_role: req.user.role,
    };

    let error;
    if (existing) {
      ({ error } = await supabase.from('seller_expectations').update(payload).eq('client_code', d.clientCode));
    } else {
      payload.filled_by = req.user.name;
      payload.filled_by_role = req.user.role;
      ({ error } = await supabase.from('seller_expectations').insert(payload));
    }
    if (error) throw error;

    // Save history
    await supabase.from('seller_expectations_history').insert({
      client_code: d.clientCode,
      changed_by: req.user.name,
      changed_by_role: req.user.role,
      change_type: existing ? 'updated' : 'created',
      changes_summary: d.fillType === 'renewal' ? 'Renewal pe update kiya' : existing ? 'Expectation update ki' : 'Naya onboarding expectation add kiya',
    });

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPORT ANALYZER LOGS ─────────────────────────────────────
const reportAnalyzerRouter = require('express').Router();

// POST /api/report-analyzer/log — save analysis log
reportAnalyzerRouter.post('/log', authMiddleware, async (req, res) => {
  try {
    const { clientCode, clientName, reportsUploaded, tasksGenerated } = req.body;
    if (!clientCode) return res.status(400).json({ error: 'clientCode required' });

    const logId = 'RAL' + Date.now().toString();
    const { error } = await supabase.from('report_analyzer_logs').insert({
      log_id: logId,
      client_code: clientCode,
      client_name: clientName || clientCode,
      analyzed_by: req.user.name,
      analyzed_by_role: req.user.role,
      reports_uploaded: reportsUploaded || [],
      tasks_generated: tasksGenerated || [],
    });
    if (error) throw error;
    res.json({ success: true, logId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/report-analyzer/logs — last 5 analyses (for header display)
reportAnalyzerRouter.get('/logs', authMiddleware, async (req, res) => {
  try {
    const { role, name } = req.query;
    const isLead = ['Admin','Ops Lead','Sub Admin','SME','Team Lead','Senior Executive'].includes(req.user.role);
    let q = supabase.from('report_analyzer_logs')
      .select('log_id, client_code, client_name, analyzed_by, analyzed_by_role, reports_uploaded, analyzed_at')
      .order('analyzed_at', { ascending: false })
      .limit(10);
    if (!isLead) q = q.eq('analyzed_by', req.user.name);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/report-analyzer/log/:logId — full log with tasks
reportAnalyzerRouter.get('/log/:logId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('report_analyzer_logs')
      .select('*').eq('log_id', req.params.logId).single();
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/report-analyzer/log/:logId/task — update task status (done/pending)
reportAnalyzerRouter.patch('/log/:logId/task', authMiddleware, async (req, res) => {
  try {
    const { taskIndex, status } = req.body;
    const { data, error } = await supabase.from('report_analyzer_logs')
      .select('tasks_generated').eq('log_id', req.params.logId).single();
    if (error) throw error;

    const tasks = data.tasks_generated || [];
    if (tasks[taskIndex] !== undefined) {
      tasks[taskIndex].status = status; // 'pending' or 'done'
      tasks[taskIndex].updatedBy = req.user.name;
      tasks[taskIndex].updatedAt = new Date().toISOString();
    }

    const { error: upErr } = await supabase.from('report_analyzer_logs')
      .update({ tasks_generated: tasks }).eq('log_id', req.params.logId);
    if (upErr) throw upErr;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MONTHLY REPORTS ──────────────────────────────────────────
const monthlyReportsRouter = require('express').Router();

// GET /api/monthly-reports/dsr — client-wise DSR totals
monthlyReportsRouter.get('/dsr', authMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

    const { data, error } = await supabase.from('dsr_data')
      .select('client_code, client_name, sales_amount, orders_count, ad_spend, return_rate, report_date')
      .gte('report_date', from)
      .lte('report_date', to)
      .order('report_date', { ascending: true });
    if (error) throw error;

    // Group by client
    const clientMap = {};
    (data || []).forEach(r => {
      const key = r.client_code;
      if (!clientMap[key]) {
        clientMap[key] = {
          clientCode: r.client_code,
          clientName: r.client_name || r.client_code,
          totalSales: 0, totalOrders: 0, totalAdSpend: 0,
          avgReturnRate: 0, daysReported: 0, returnRates: [],
        };
      }
      clientMap[key].totalSales += parseFloat(r.sales_amount || 0);
      clientMap[key].totalOrders += parseInt(r.orders_count || 0);
      clientMap[key].totalAdSpend += parseFloat(r.ad_spend || 0);
      clientMap[key].returnRates.push(parseFloat(r.return_rate || 0));
      clientMap[key].daysReported++;
    });

    const result = Object.values(clientMap).map(c => ({
      ...c,
      avgReturnRate: c.returnRates.length
        ? Math.round(c.returnRates.reduce((s, r) => s + r, 0) / c.returnRates.length * 10) / 10
        : 0,
      acos: c.totalSales > 0 ? Math.round(c.totalAdSpend / c.totalSales * 100 * 10) / 10 : 0,
      returnRates: undefined,
    })).sort((a, b) => b.totalSales - a.totalSales);

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/monthly-reports/executive — executive performance
monthlyReportsRouter.get('/executive', authMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

    const [usersRes, tasksRes, ticketsRes, crmRes, dsrRes] = await Promise.all([
      supabase.from('users').select('name, role, designation').eq('is_active', true)
        .not('role', 'in', '("Admin","CSI Executive","Viewer")'),
      supabase.from('tasks').select('assigned_to, status, completed_at, created_at')
        .gte('created_at', from).lte('created_at', to+'T23:59:59'),
      supabase.from('tickets').select('resolved_by, approved_at, status, close_requested_by')
        .gte('approved_at', from).lte('approved_at', to+'T23:59:59').eq('status', 'Done'),
      supabase.from('crm_calls').select('crm_executive, created_at, call_outcome')
        .gte('created_at', from).lte('created_at', to+'T23:59:59'),
      supabase.from('dsr_data').select('entered_by, report_date')
        .gte('report_date', from).lte('report_date', to),
    ]);

    const users = usersRes.data || [];
    const tasks = tasksRes.data || [];
    const tickets = ticketsRes.data || [];
    const crmCalls = crmRes.data || [];
    const dsrEntries = dsrRes.data || [];

    const result = users.map(u => {
      const myTasks = tasks.filter(t => (t.assigned_to || '').toLowerCase().includes(u.name.toLowerCase()));
      const myTickets = tickets.filter(t => (t.resolved_by || '').toLowerCase().includes(u.name.toLowerCase()));
      const myCRM = crmCalls.filter(c => (c.crm_executive || '').toLowerCase().includes(u.name.toLowerCase()));
      const myDSR = dsrEntries.filter(d => (d.entered_by || '').toLowerCase().includes(u.name.toLowerCase()));

      const tasksDone = myTasks.filter(t => t.status === 'Completed' || t.status === 'Done').length;
      const tasksPending = myTasks.filter(t => t.status !== 'Completed' && t.status !== 'Done').length;
      const connectedCalls = myCRM.filter(c => (c.call_outcome || '').includes('Connected')).length;

      // Score: tasks(40%) + tickets(20%) + crm(25%) + dsr(15%)
      const maxScore = 100;
      const taskScore = Math.min(tasksDone * 5, 40);
      const ticketScore = Math.min(myTickets.length * 4, 20);
      const crmScore = Math.min(connectedCalls * 2, 25);
      const dsrScore = Math.min(myDSR.length * 1, 15);
      const totalScore = taskScore + ticketScore + crmScore + dsrScore;

      return {
        name: u.name,
        role: u.role,
        designation: u.designation || u.role,
        tasksDone, tasksPending,
        totalTasks: myTasks.length,
        ticketsClosed: myTickets.length,
        crmCalls: myCRM.length,
        connectedCalls,
        dsrEntries: myDSR.length,
        performanceScore: Math.min(totalScore, 100),
        grade: totalScore >= 80 ? 'A' : totalScore >= 60 ? 'B' : totalScore >= 40 ? 'C' : 'D',
      };
    }).filter(u => u.totalTasks > 0 || u.ticketsClosed > 0 || u.crmCalls > 0 || u.dsrEntries > 0)
      .sort((a, b) => b.performanceScore - a.performanceScore);

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/monthly-reports/ai-analysis — Claude AI summary
monthlyReportsRouter.post('/ai-analysis', authMiddleware, async (req, res) => {
  try {
    const { reportType, data, period } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    let prompt = '';
    if (reportType === 'dsr') {
      const top5 = data.slice(0, 5).map(c => `${c.clientName}: ₹${Math.round(c.totalSales).toLocaleString('en-IN')} sales, ${c.totalOrders} orders, ${c.acos}% ACOS`).join('\n');
      const bottom5 = data.slice(-5).map(c => `${c.clientName}: ₹${Math.round(c.totalSales).toLocaleString('en-IN')} sales, ${c.totalOrders} orders`).join('\n');
      const totalSales = data.reduce((s, c) => s + c.totalSales, 0);
      prompt = `You are an Amazon seller management expert. Analyze this DSR (Daily Sales Report) data for ${period} and provide insights in Hindi/English mix (Hinglish).

Total clients: ${data.length}
Total revenue: ₹${Math.round(totalSales).toLocaleString('en-IN')}

Top 5 performers:
${top5}

Bottom 5 performers:
${bottom5}

Please provide:
1. Overall performance summary (2-3 lines)
2. Top performers ka highlight
3. Underperforming clients ke liye concerns
4. Next month ke liye 3 actionable recommendations

Keep response concise, under 250 words. Use Hinglish naturally.`;
    } else {
      const gradeA = data.filter(e => e.grade === 'A').map(e => e.name).join(', ') || 'None';
      const gradeD = data.filter(e => e.grade === 'D').map(e => e.name).join(', ') || 'None';
      prompt = `You are an HR performance analyst. Analyze this team performance data for ${period} and provide insights in Hinglish.

Total executives analyzed: ${data.length}
Grade A (top performers): ${gradeA}
Grade D (needs improvement): ${gradeD}

Top 3 performers:
${data.slice(0, 3).map(e => `${e.name} (${e.role}): Score ${e.performanceScore}/100, Tasks: ${e.tasksDone} done, Tickets: ${e.ticketsClosed} closed, CRM calls: ${e.connectedCalls} connected`).join('\n')}

Bottom 3:
${data.slice(-3).map(e => `${e.name} (${e.role}): Score ${e.performanceScore}/100, Tasks: ${e.tasksDone} done`).join('\n')}

Please provide:
1. Team ka overall performance summary
2. Top performers ki tarif (name mention karo)
3. Jo kaam nahi kar rahe unke baare mein concern
4. HR ke liye 3 actionable steps

Keep response under 250 words. Use Hinglish naturally.`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await response.json();
    const analysis = aiData.content?.[0]?.text || 'Analysis generate nahi ho paya.';
    res.json({ success: true, analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DOCUMENT VAULT ────────────────────────────────────────────
const docsRouter = require('express').Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50*1024*1024 } });

docsRouter.get('/:clientCode', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('seller_documents')
      .select('*').eq('client_code', req.params.clientCode)
      .order('uploaded_at', { ascending: false });
    if(error) throw error;
    res.json((data||[]).map(d=>({
      docId: d.doc_id, clientCode: d.client_code, clientName: d.client_name,
      fileName: d.file_name, fileUrl: d.file_url, category: d.category||'Other',
      description: d.description||'', fileSize: d.file_size, fileType: d.file_type,
      uploadedBy: d.uploaded_by,
      uploadedAt: d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString('en-IN') : '',
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

docsRouter.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { docId, clientCode, clientName, category, description, path } = req.body;
    const file = req.file;
    if(!file) return res.status(400).json({ error: 'No file' });

    // Upload to Supabase Storage
    const { data: storageData, error: storageErr } = await supabase.storage
      .from('seller-documents')
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if(storageErr) throw storageErr;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('seller-documents')
      .getPublicUrl(path);

    const fileUrl = urlData.publicUrl;

    // Save to DB
    const { error: dbErr } = await supabase.from('seller_documents').insert({
      doc_id: docId,
      client_code: clientCode,
      client_name: clientName,
      file_name: file.originalname,
      file_url: fileUrl,
      category: category || 'Other',
      description: description || null,
      file_size: file.size,
      file_type: file.mimetype,
      uploaded_by: req.user.name,
      task_id: req.body.taskId || null,
    });
    if(dbErr) throw dbErr;

    res.json({ success: true, fileUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

docsRouter.delete('/:docId', authMiddleware, async (req, res) => {
  try {
    // Get file path
    const { data: doc } = await supabase.from('seller_documents')
      .select('file_url, client_code').eq('doc_id', req.params.docId).single();

    if(doc?.file_url) {
      // Extract path from URL
      const url = new URL(doc.file_url);
      const pathParts = url.pathname.split('/seller-documents/');
      if(pathParts[1]) {
        await supabase.storage.from('seller-documents').remove([decodeURIComponent(pathParts[1])]);
      }
    }

    await supabase.from('seller_documents').delete().eq('doc_id', req.params.docId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── APPROVAL REQUESTS ─────────────────────────────────────────
const approvalRouter = require('express').Router();

// Named admins — always see/approve all regardless of role (business rule)
// Match is case-insensitive substring (e.g., "Gaurav Mourya" matches "gaurav")
const APPROVAL_ALL_ACCESS_NAMES = ['manpreet','gaurav','devendra','piyush','shivendra'];
function hasApprovalAllAccess(user) {
  if(!user) return false;
  const role = user.role || '';
  const name = (user.name || '').toLowerCase();
  // 1. Existing leads (unchanged)
  if(['Admin','Ops Lead','CRM Lead','CSI Lead','Sub Admin','Team Lead'].includes(role)) return true;
  // 2. Any CRM role (CRM Lead + CRM Executive)
  if(role.toLowerCase().includes('crm')) return true;
  // 3. Named admins (hardcoded by business)
  if(APPROVAL_ALL_ACCESS_NAMES.some(n => name.includes(n))) return true;
  return false;
}

// GET all — All-access users see everything, others see only what they raised
approvalRouter.get('/', authMiddleware, async (req, res) => {
  try {
    const seesAll = hasApprovalAllAccess(req.user);
    let query = supabase.from('approval_requests').select('*').order('requested_at', { ascending: false });
    if(!seesAll) query = query.eq('requested_by', req.user.name);
    const { data, error } = await query;
    if(error) throw error;
    res.json((data||[]).map(r=>({
      requestId: r.request_id, clientCode: r.client_code, clientName: r.client_name,
      requestType: r.request_type, description: r.description,
      requestedBy: r.requested_by, requestedByRole: r.requested_by_role,
      requestedAt: r.requested_at, status: r.status,
      reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
      reviewRemarks: r.review_remarks,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET by client
approvalRouter.get('/client/:code', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('approval_requests')
      .select('*').eq('client_code', req.params.code)
      .order('requested_at', { ascending: false });
    if(error) throw error;
    res.json((data||[]).map(r=>({
      requestId: r.request_id, clientCode: r.client_code, clientName: r.client_name,
      requestType: r.request_type, description: r.description,
      requestedBy: r.requested_by, requestedByRole: r.requested_by_role,
      requestedAt: new Date(r.requested_at).toLocaleString('en-IN'),
      status: r.status, reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toLocaleString('en-IN') : null,
      reviewRemarks: r.review_remarks,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — raise new request
approvalRouter.post('/', authMiddleware, async (req, res) => {
  try {
    const { clientCode, clientName, requestType, description } = req.body;
    if(!clientCode || !requestType) return res.status(400).json({ error: 'clientCode and requestType required' });
    const requestId = 'APR' + Date.now().toString().slice(-7);
    const { error } = await supabase.from('approval_requests').insert({
      request_id: requestId, client_code: clientCode, client_name: clientName,
      request_type: requestType, description: description || null,
      requested_by: req.user.name, requested_by_role: req.user.role,
      status: 'Pending',
    });
    if(error) throw error;
    res.json({ success: true, requestId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH — approve or reject (existing approver roles + named admins)
approvalRouter.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const allowedRoles = ['Admin','Ops Lead','CRM Lead','CSI Lead','Sub Admin'];
    const lowerName = (req.user.name || '').toLowerCase();
    const isNamedAdmin = APPROVAL_ALL_ACCESS_NAMES.some(n => lowerName.includes(n));
    if(!allowedRoles.includes(req.user.role) && !isNamedAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { action, reviewRemarks } = req.body;
    const status = action === 'approve' ? 'Approved' : 'Rejected';
    const { error } = await supabase.from('approval_requests').update({
      status, reviewed_by: req.user.name,
      reviewed_at: new Date().toISOString(),
      review_remarks: reviewRemarks || null,
    }).eq('request_id', req.params.id);
    if(error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MIS REPORT ────────────────────────────────────────────────
const misRouter = require('express').Router();

misRouter.get('/data', authMiddleware, async (req, res) => {
  try {
    const allowedRoles = ['Admin', 'CSI Lead', 'CRM Lead'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get clients with full data
    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('client_code, busy_name, marketplace, service_plan, am_name, seller_aging, status, renewal_date, health_status')
      .eq('status', 'Active')
      .order('busy_name');
    if (cErr) throw cErr;

    // Get users for AM staff aging
    const { data: users } = await supabase
      .from('users')
      .select('name, role, joining_date, designation')
      .eq('is_active', true);

    const today = new Date();

    // Build AM staff aging map
    const amAgingMap = {};
    (users || []).forEach(u => {
      if (u.joining_date) {
        const days = Math.floor((today - new Date(u.joining_date)) / 86400000);
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        amAgingMap[u.name] = {
          staffAgingDays: days,
          staffAgingLabel: years > 0 ? years + 'y ' + months + 'm' : months + ' months',
        };
      }
    });

    // Get renewals (last 2 months)
    const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 1).toISOString().split('T')[0];
    const { data: renewalHistory } = await supabase
      .from('renewal_history')
      .select('client_code, busy_name, marketplace, service_plan, am_name, mis_status, amount')
      .gte('created_at', twoMonthsAgo)
      .order('created_at', { ascending: false });

    // AM-wise summary
    const amMap = {};
    (clients || []).forEach(c => {
      const am = (c.am_name || '').trim();
      if (!am) return;
      if (!amMap[am]) {
        amMap[am] = {
          am_name: am,
          staffAging: amAgingMap[am]?.staffAgingLabel || '—',
          staffAgingDays: amAgingMap[am]?.staffAgingDays || 0,
          total_accounts: 0,
          marketplaces: {},
          health: { Healthy: 0, Warning: 0, 'At Risk': 0, 'Not Reviewed': 0 },
        };
      }
      amMap[am].total_accounts++;
      const mp = c.marketplace || 'Other';
      amMap[am].marketplaces[mp] = (amMap[am].marketplaces[mp] || 0) + 1;
      const h = c.health_status || 'Not Reviewed';
      amMap[am].health[h] = (amMap[am].health[h] || 0) + 1;
    });

    // Add renewal stats to AM map
    const renewalMap = {};
    (renewalHistory || []).forEach(r => {
      const am = (r.am_name || '').trim();
      const status = (r.mis_status || '').trim();
      const key = am;
      if (!renewalMap[key]) renewalMap[key] = { received: 0, churn: 0, pending: 0, total: 0 };
      renewalMap[key].total++;
      if (status === 'Received' || status === 'received') renewalMap[key].received++;
      else if (status === 'Churn' || status === 'churn') renewalMap[key].churn++;
      else if (status === 'Pending' || status === 'pending') renewalMap[key].pending++;
    });

    const amSummary = Object.values(amMap).map(am => ({
      ...am,
      marketplaceList: Object.entries(am.marketplaces)
        .sort((a,b) => b[1]-a[1])
        .map(([mp, cnt]) => mp.replace('Amazon.in','AMZ.in').replace('Flipkart.com','FK').replace('Amazon.com','AMZ.com') + '(' + cnt + ')')
        .join(', '),
      renewals: renewalMap[am.am_name] || { received: 0, churn: 0, pending: 0, total: 0 },
      receivedPct: renewalMap[am.am_name]?.total
        ? Math.round(renewalMap[am.am_name].received / renewalMap[am.am_name].total * 100)
        : null,
      churnPct: renewalMap[am.am_name]?.total
        ? Math.round(renewalMap[am.am_name].churn / renewalMap[am.am_name].total * 100)
        : null,
    })).sort((a, b) => b.total_accounts - a.total_accounts);

    res.json({
      sellers: clients || [],
      amSummary,
      renewals: renewalHistory || [],
      totalSellers: (clients || []).length,
      totalAMs: amSummary.length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ── AI PRODUCTIVITY REPORT ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ── AI PROVIDER ABSTRACTION ──────────────────────────────────
// Swappable: set AI_PROVIDER env var to 'gemini' (default) or 'anthropic'
async function callAI(prompt, options = {}) {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const maxTokens = options.maxTokens || 800;
  try {
    if (provider === 'anthropic' || provider === 'claude') return await callClaude(prompt, maxTokens);
    return await callGemini(prompt, maxTokens);
  } catch(e) {
    console.error('AI call failed:', e.message);
    return null;
  }
}

async function callGemini(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!response.ok) throw new Error('Gemini API error: ' + response.status);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) throw new Error('Claude API error: ' + response.status);
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ── AI CACHE (in-memory, 30 min TTL) ─────────────────────────
const _aiInsightsCache = new Map();
const AI_CACHE_TTL_MS = 30 * 60 * 1000;
function _cacheKey(from, to, userNamesSignature) {
  return from + '|' + to + '|' + userNamesSignature;
}
function _getCachedInsights(key) {
  const entry = _aiInsightsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > AI_CACHE_TTL_MS) { _aiInsightsCache.delete(key); return null; }
  return entry.data;
}
function _setCachedInsights(key, data) {
  _aiInsightsCache.set(key, { data, timestamp: Date.now() });
}

// ── PRODUCTIVITY SCORE CALCULATION (role-aware multi-metric) ──
// Domain Excellence calculator per role
function _domainExcellencePct(user, ctx) {
  const { tasks, tickets, crm, csi } = ctx;
  const name = user.name;
  const role = user.role || '';
  const myTasks = tasks.filter(t => t.assigned_to === name);
  const myTickets = tickets.filter(t => t.assigned_to === name || t.resolved_by === name);
  const myCRM = crm.filter(c => c.crm_executive === name);

  if (role === 'Account Manager') {
    if (!myTickets.length) return 0;
    const closed = myTickets.filter(t => t.status === 'Done').length;
    return Math.round((closed / myTickets.length) * 100);
  }
  if (role === 'Ads Executive') {
    const ADS_CATS = ['Campaign Optimization','New Campaign Live','Campaign Paused','Keyword Research','A/B Testing','Report Review','Client Approval Pending'];
    const myAds = myTasks.filter(t => ADS_CATS.includes(t.category));
    if (!myAds.length) return 0;
    const done = myAds.filter(t => t.status === 'Completed' || t.status === 'Done').length;
    return Math.round((done / myAds.length) * 100);
  }
  if (role === 'CRM Executive') {
    if (!myCRM.length) return 0;
    const connected = myCRM.filter(c => (c.call_outcome || '').toLowerCase().includes('connected')).length;
    return Math.round((connected / myCRM.length) * 100);
  }
  if (role === 'CSI Executive') {
    // No strict CSI count available; use task completion as proxy
    if (!myTasks.length) return 0;
    const done = myTasks.filter(t => t.status === 'Completed' || t.status === 'Done').length;
    return Math.round((done / myTasks.length) * 100);
  }
  // For leads/admins: team avg task completion
  if (['Team Lead','SME','Senior Executive','CRM Lead','CSI Lead','Ops Lead','Admin','Sub Admin'].includes(role)) {
    if (!tasks.length) return 0;
    const done = tasks.filter(t => t.status === 'Completed' || t.status === 'Done').length;
    return Math.round((done / tasks.length) * 100);
  }
  return 0;
}

// Count working days in [from, to] (inclusive). India: Mon-Sat.
function _workingDaysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    if (day !== 0) count++; // Skip Sunday
    d.setDate(d.getDate() + 1);
  }
  return Math.max(1, count);
}

function _daysActiveInPeriod(name, ctx) {
  const { tasks, tickets, crm, worklog, dsr } = ctx;
  const days = new Set();
  const addDay = (dateStr) => { if (dateStr) days.add(new Date(dateStr).toISOString().split('T')[0]); };
  tasks.filter(t => t.assigned_to === name).forEach(t => addDay(t.created_at));
  tasks.filter(t => t.assigned_to === name && t.completed_at).forEach(t => addDay(t.completed_at));
  tickets.filter(t => t.resolved_by === name || t.assigned_to === name).forEach(t => addDay(t.created_at));
  crm.filter(c => c.crm_executive === name).forEach(c => addDay(c.created_at));
  worklog.filter(w => w.executive_name === name).forEach(w => addDay(w.created_at));
  dsr.filter(d => d.entered_by === name).forEach(d => addDay(d.report_date));
  return days.size;
}

function _lastActivityDate(name, ctx) {
  const { tasks, tickets, crm, worklog, dsr } = ctx;
  const allDates = [];
  tasks.filter(t => t.assigned_to === name).forEach(t => { if (t.created_at) allDates.push(new Date(t.created_at)); });
  tickets.filter(t => t.resolved_by === name || t.assigned_to === name).forEach(t => { if (t.created_at) allDates.push(new Date(t.created_at)); });
  crm.filter(c => c.crm_executive === name).forEach(c => { if (c.created_at) allDates.push(new Date(c.created_at)); });
  worklog.filter(w => w.executive_name === name).forEach(w => { if (w.created_at) allDates.push(new Date(w.created_at)); });
  dsr.filter(d => d.entered_by === name).forEach(d => { if (d.report_date) allDates.push(new Date(d.report_date)); });
  if (!allDates.length) return null;
  return new Date(Math.max(...allDates.map(d => d.getTime())));
}

function computeUserScore(user, ctx) {
  const name = user.name;
  const role = user.role || '';
  const today = new Date();

  // Filter data for this user
  const myTasks = ctx.tasks.filter(t => t.assigned_to === name);
  const myTasksDone = myTasks.filter(t => t.status === 'Completed' || t.status === 'Done');
  const myTickets = ctx.tickets.filter(t => t.resolved_by === name || t.assigned_to === name);
  const myTicketsClosed = myTickets.filter(t => t.status === 'Done');
  const myCRM = ctx.crm.filter(c => c.crm_executive === name);
  const connectedCalls = myCRM.filter(c => (c.call_outcome || '').toLowerCase().includes('connected'));
  const myWorklog = ctx.worklog.filter(w => w.executive_name === name);
  const myDSR = ctx.dsr.filter(d => d.entered_by === name);

  // 1. Task Completion (25 pts)
  const completionPct = myTasks.length ? Math.round((myTasksDone.length / myTasks.length) * 100) : 0;
  const taskCompletionScore = (completionPct / 100) * 25;

  // 2. Task Timeliness (15 pts)
  const doneOnTime = myTasksDone.filter(t => {
    if (!t.deadline || !t.completed_at) return false;
    return new Date(t.completed_at) <= new Date(t.deadline);
  }).length;
  const timelinessPct = myTasksDone.length ? Math.round((doneOnTime / myTasksDone.length) * 100) : 0;
  const timelinessScore = (timelinessPct / 100) * 15;

  // 3. Domain Excellence (25 pts) — role-specific
  const domainPct = _domainExcellencePct(user, ctx);
  const domainScore = (domainPct / 100) * 25;

  // 4. Activity Consistency (20 pts)
  const workingDays = _workingDaysBetween(ctx.from, ctx.to);
  const daysActive = _daysActiveInPeriod(name, ctx);
  const consistencyPct = Math.round((daysActive / workingDays) * 100);
  const consistencyScore = (Math.min(consistencyPct, 100) / 100) * 20;

  // 5. Ticket SLA Score (15 pts)
  const noBreachTickets = myTicketsClosed.filter(t => {
    if (!t.hours_to_close) return true;
    const slaMap = { Critical: 4, High: 12, Medium: 24, Low: 48 };
    const sla = slaMap[t.priority] || 24;
    return t.hours_to_close <= sla;
  }).length;
  const slaPct = myTicketsClosed.length ? Math.round((noBreachTickets / myTicketsClosed.length) * 100) : (myTickets.length ? 0 : 100);
  const slaScore = (slaPct / 100) * 15;

  const baseScore = taskCompletionScore + timelinessScore + domainScore + consistencyScore + slaScore;

  // Bonuses / Penalties
  let bonus = 0;
  const bonusReasons = [];
  let penalty = 0;
  const penaltyReasons = [];

  // Aged tickets
  const agedTickets = myTickets.filter(t => {
    if (t.status === 'Done') return false;
    if (!t.created_at) return false;
    const ageDays = Math.floor((today - new Date(t.created_at)) / 86400000);
    return ageDays > 10;
  });
  if (agedTickets.length === 0 && myTickets.length > 0) {
    bonus += 5; bonusReasons.push('No aged tickets');
  } else if (agedTickets.length > 0) {
    penalty += 5; penaltyReasons.push(agedTickets.length + ' aged ticket(s)');
  }

  // Inactive 3+ days
  const lastAct = _lastActivityDate(name, ctx);
  let daysIdle = null;
  if (lastAct) {
    daysIdle = Math.floor((today - lastAct) / 86400000);
    if (daysIdle >= 3) { penalty += 10; penaltyReasons.push('Inactive ' + daysIdle + 'd'); }
  } else {
    penalty += 10; penaltyReasons.push('No activity in period');
    daysIdle = workingDays;
  }

  // Staff aging label
  const joining = user.joining_date ? new Date(user.joining_date) : null;
  const staffAgingDays = joining ? Math.floor((today - joining) / 86400000) : null;
  const staffAgingLabel = staffAgingDays != null
    ? (Math.floor(staffAgingDays / 365) > 0
        ? Math.floor(staffAgingDays / 365) + 'y ' + Math.floor((staffAgingDays % 365) / 30) + 'm'
        : Math.floor((staffAgingDays % 365) / 30) + ' months')
    : '—';

  // Avg days to close tasks
  const taskClosureDurations = myTasksDone
    .filter(t => t.completed_at && t.created_at)
    .map(t => (new Date(t.completed_at) - new Date(t.created_at)) / 86400000);
  const avgDaysToClose = taskClosureDurations.length
    ? Math.round((taskClosureDurations.reduce((s,d)=>s+d,0) / taskClosureDurations.length) * 10) / 10
    : null;

  // Avg ticket hours
  const ticketHours = myTicketsClosed.map(t => t.hours_to_close).filter(h => h != null);
  const avgTicketHours = ticketHours.length
    ? Math.round(ticketHours.reduce((s,h)=>s+h,0) / ticketHours.length)
    : null;

  // Final cap 0-100
  const finalScore = Math.max(0, Math.min(100, Math.round(baseScore + bonus - penalty)));

  // Grade
  let grade = 'F', gradeLabel = '🚨 Critical';
  if (finalScore >= 90) { grade = 'A+'; gradeLabel = '🌟 Outstanding'; }
  else if (finalScore >= 80) { grade = 'A'; gradeLabel = '🏆 Excellent'; }
  else if (finalScore >= 65) { grade = 'B'; gradeLabel = '👍 Good'; }
  else if (finalScore >= 50) { grade = 'C'; gradeLabel = '⚠️ Average'; }
  else if (finalScore >= 35) { grade = 'D'; gradeLabel = '🔴 Needs Improvement'; }

  return {
    name, role,
    designation: user.designation || role,
    staffAging: staffAgingLabel, staffAgingDays,
    tasksAssigned: myTasks.length,
    tasksDone: myTasksDone.length,
    tasksOverdue: myTasks.filter(t => t.deadline && t.status !== 'Done' && t.status !== 'Completed' && new Date(t.deadline) < today).length,
    completionPct,
    avgDaysToClose,
    timelinessPct,
    ticketsHandled: myTickets.length,
    ticketsClosed: myTicketsClosed.length,
    avgTicketHours,
    slaPct,
    crmCallsTotal: myCRM.length,
    crmCallsConnected: connectedCalls.length,
    crmConnectedPct: myCRM.length ? Math.round((connectedCalls.length / myCRM.length) * 100) : 0,
    dsrEntries: myDSR.length,
    workLogCount: myWorklog.length,
    daysActive, workingDays, consistencyPct,
    domainPct,
    baseScore: Math.round(baseScore * 10) / 10,
    bonus, bonusReasons,
    penalty, penaltyReasons,
    score: finalScore,
    grade, gradeLabel,
    flags: {
      inactive: daysIdle !== null && daysIdle >= 3,
      daysIdle,
      agedTicketCount: agedTickets.length,
      lastActiveDate: lastAct ? lastAct.toLocaleDateString('en-IN') : 'Never',
    },
  };
}

// ── REPORT ANALYZER EXECUTION SCORES ─────────────────────────
function computeReportAnalyzerScores(reportLogs) {
  const userMap = {};
  (reportLogs || []).forEach(log => {
    const user = log.analyzed_by || 'Unknown';
    if (!userMap[user]) userMap[user] = {
      user, role: log.analyzed_by_role || '',
      timesUsed: 0, sellersAnalyzed: new Set(),
      tasksGenerated: 0, tasksDone: 0, tasksPending: 0,
      lastUsed: null,
    };
    const entry = userMap[user];
    entry.timesUsed++;
    if (log.client_code) entry.sellersAnalyzed.add(log.client_code);
    const tasks = log.tasks_generated || [];
    entry.tasksGenerated += tasks.length;
    entry.tasksDone += tasks.filter(t => t.status === 'done').length;
    entry.tasksPending += tasks.filter(t => t.status !== 'done').length;
    const lu = log.analyzed_at ? new Date(log.analyzed_at) : null;
    if (lu && (!entry.lastUsed || lu > entry.lastUsed)) entry.lastUsed = lu;
  });
  return Object.values(userMap).map(e => {
    const executionPct = e.tasksGenerated ? Math.round((e.tasksDone / e.tasksGenerated) * 100) : 0;
    let flag = null;
    if (e.tasksGenerated > 20 && executionPct < 30) flag = '🚨 Low execution despite heavy use';
    else if (e.tasksGenerated > 10 && executionPct < 40) flag = '⚠️ Execution below benchmark';
    return {
      user: e.user, role: e.role,
      timesUsed: e.timesUsed,
      sellersAnalyzed: e.sellersAnalyzed.size,
      tasksGenerated: e.tasksGenerated,
      tasksDone: e.tasksDone,
      tasksPending: e.tasksPending,
      executionPct,
      lastUsed: e.lastUsed ? e.lastUsed.toLocaleDateString('en-IN') : '—',
      flag,
    };
  }).sort((a, b) => b.executionPct - a.executionPct);
}

// ── ALERTS COMPUTATION ───────────────────────────────────────
function computeAlerts(leaderboard, tickets) {
  const idle = leaderboard
    .filter(e => e.flags.inactive)
    .map(e => ({ name: e.name, role: e.role, lastActive: e.flags.lastActiveDate, daysIdle: e.flags.daysIdle }))
    .sort((a, b) => b.daysIdle - a.daysIdle);

  const backlogGrowing = leaderboard
    .filter(e => e.tasksAssigned > 5 && e.tasksDone < e.tasksAssigned * 0.5)
    .map(e => ({ name: e.name, role: e.role, assigned: e.tasksAssigned, done: e.tasksDone, pendingRatio: Math.round(((e.tasksAssigned - e.tasksDone) / e.tasksAssigned) * 100) }));

  const agedTickets = leaderboard
    .filter(e => e.flags.agedTicketCount > 0)
    .map(e => ({ name: e.name, role: e.role, count: e.flags.agedTicketCount }));

  const lowCompletion = leaderboard
    .filter(e => e.tasksAssigned > 5 && e.completionPct < 20)
    .map(e => ({ name: e.name, role: e.role, completionPct: e.completionPct, tasksAssigned: e.tasksAssigned }));

  return { idle, backlogGrowing, agedTickets, lowCompletion };
}

// ── AI INSIGHTS PROMPT BUILDER ───────────────────────────────
function buildAIPrompt(leaderboard, reportScores, alerts, from, to) {
  const top5 = leaderboard.slice().sort((a,b) => b.score - a.score).slice(0, 5);
  const bottom5 = leaderboard.slice().sort((a,b) => a.score - b.score).slice(0, 5);

  const formatPerson = (e) => `- ${e.name} (${e.role}): Score ${e.score}/100 [${e.grade}], Tasks ${e.tasksDone}/${e.tasksAssigned} (${e.completionPct}%), Tickets ${e.ticketsClosed} closed, CRM ${e.crmCallsConnected} connected, ${e.daysActive}/${e.workingDays} active days`;

  const formatRA = (r) => `- ${r.user}: Used ${r.timesUsed}x → Generated ${r.tasksGenerated} tasks → Done ${r.tasksDone} (${r.executionPct}%)${r.flag ? ' ' + r.flag : ''}`;

  const prompt = `You are an HR + productivity analyst for eNewcleus (Amazon seller management company in Indore, India). Analyze this team performance data from ${from} to ${to} and respond in natural Hinglish (Hindi + English mix, written in Roman/English letters).

TOTAL EXECUTIVES: ${leaderboard.length}
ACTIVE: ${leaderboard.filter(e => !e.flags.inactive).length}

TOP 5 PERFORMERS:
${top5.map(formatPerson).join('\n')}

BOTTOM 5 PERFORMERS:
${bottom5.map(formatPerson).join('\n')}

REPORT ANALYZER (AI tool) USAGE:
${reportScores.slice(0, 8).map(formatRA).join('\n') || 'No usage data'}

ALERTS:
- Idle (3+ days no activity): ${alerts.idle.map(a => a.name + ' (' + a.daysIdle + 'd)').join(', ') || 'None'}
- Backlog growing: ${alerts.backlogGrowing.map(a => a.name).join(', ') || 'None'}
- Aged tickets holders: ${alerts.agedTickets.map(a => a.name + ' (' + a.count + ')').join(', ') || 'None'}

Generate a productivity analysis. Return ONLY a valid JSON object with this exact shape:
{
  "summary": "3-4 sentence Hinglish overview of team health",
  "topPerformers": [{"name": "...", "highlight": "1-line Hinglish praise with specific data"}],
  "concerns": [{"name": "...", "issue": "1-line empathetic Hinglish framing with possible reason"}],
  "recommendations": ["action 1", "action 2", "action 3"]
}

Rules:
- 3 top performers, 3 concerns, 3 recommendations
- Use actual names from the data
- Recommendations should be specific and actionable (not generic)
- Hinglish tone: warm but direct, like a COO talking to fellow leader
- Reference specific numbers/metrics where possible
- Keep each field concise; total JSON should be under 1500 characters`;

  return prompt;
}

async function getAIInsightsCached(leaderboard, reportScores, alerts, from, to) {
  const userSig = leaderboard.map(e => e.name).sort().join(',');
  const key = _cacheKey(from, to, userSig);
  const cached = _getCachedInsights(key);
  if (cached) return { ...cached, fromCache: true };

  const prompt = buildAIPrompt(leaderboard, reportScores, alerts, from, to);
  const rawResponse = await callAI(prompt, { maxTokens: 1000 });
  if (!rawResponse) {
    return {
      summary: 'AI insights abhi generate nahi ho paaye. Data review kar sakte ho table mein.',
      topPerformers: [], concerns: [], recommendations: [],
      aiProvider: (process.env.AI_PROVIDER || 'gemini'),
      error: true,
    };
  }

  let parsed;
  try {
    // Clean any markdown fences
    const cleaned = rawResponse.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch(e) {
    parsed = {
      summary: rawResponse.slice(0, 500),
      topPerformers: [], concerns: [], recommendations: [],
      parseError: true,
    };
  }

  const result = {
    ...parsed,
    generatedAt: new Date().toISOString(),
    aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'anthropic' ? 'claude-haiku-4-5' : 'gemini-2.5-flash',
  };
  _setCachedInsights(key, result);
  return result;
}

// ── PRODUCTIVITY ROUTER ──────────────────────────────────────
const productivityRouter = require('express').Router();

const PROD_NAMED_ADMINS = ['piyush','gaurav','manpreet','devendra','shivendra'];

productivityRouter.get('/productivity', authMiddleware, async (req, res) => {
  try {
    const { role, name } = req.user;
    const lowerName = (name || '').toLowerCase();
    const isNamedAdmin = PROD_NAMED_ADMINS.some(n => lowerName.includes(n));
    // Full access roles see everyone with names
    const FULL_ACCESS_ROLES = ['Admin','Ops Lead','CRM Lead','CSI Lead','Sub Admin'];
    const canViewAll = FULL_ACCESS_ROLES.includes(role) || isNamedAdmin;

    // Default date range: last 7 days
    const now = new Date();
    const defaultTo = now.toISOString().split('T')[0];
    const defaultFromDate = new Date(now); defaultFromDate.setDate(defaultFromDate.getDate() - 6);
    const defaultFrom = defaultFromDate.toISOString().split('T')[0];
    const from = (req.query.from || defaultFrom);
    const to   = (req.query.to   || defaultTo);
    const fromISO = from + 'T00:00:00';
    const toISO   = to   + 'T23:59:59';

    // Parallel fetch
    const [usersRes, tasksRes, ticketsRes, crmRes, worklogRes, dsrRes, reportLogsRes] = await Promise.all([
      supabase.from('users').select('name, role, designation, joining_date, is_active').eq('is_active', true).not('role', 'in', '("Viewer","CSI Executive")'),
      supabase.from('tasks').select('task_id, title, assigned_to, assigned_by, category, status, deadline, created_at, completed_at, priority').gte('created_at', fromISO).lte('created_at', toISO),
      supabase.from('tickets').select('ticket_id, assigned_to, resolved_by, status, created_at, approved_at, hours_to_close, priority').gte('created_at', fromISO).lte('created_at', toISO),
      supabase.from('crm_calls').select('call_id, crm_executive, call_outcome, created_at').gte('created_at', fromISO).lte('created_at', toISO),
      supabase.from('work_log').select('log_id, executive_name, work_type, created_at').gte('created_at', fromISO).lte('created_at', toISO),
      supabase.from('dsr_data').select('entered_by, report_date').gte('report_date', from).lte('report_date', to),
      supabase.from('report_analyzer_logs').select('log_id, client_code, analyzed_by, analyzed_by_role, tasks_generated, analyzed_at').gte('analyzed_at', fromISO).lte('analyzed_at', toISO),
    ]);

    const users = usersRes.data || [];
    const ctx = {
      tasks: tasksRes.data || [], tickets: ticketsRes.data || [],
      crm: crmRes.data || [], worklog: worklogRes.data || [], dsr: dsrRes.data || [],
      from, to,
    };

    let leaderboard = users.map(u => computeUserScore(u, ctx))
      .filter(e => e.tasksAssigned > 0 || e.ticketsHandled > 0 || e.crmCallsTotal > 0 || e.workLogCount > 0 || e.dsrEntries > 0 || e.flags.inactive)
      .sort((a, b) => b.score - a.score);

    let reportScores = computeReportAnalyzerScores(reportLogsRes.data || []);
    let alerts = computeAlerts(leaderboard, ctx.tickets);

    // Access control: non-full-access sees only own data
    if (!canViewAll) {
      leaderboard = leaderboard.filter(e => e.name === name);
      reportScores = reportScores.filter(e => e.user === name);
      alerts = { idle: [], backlogGrowing: [], agedTickets: [], lowCompletion: [] };
    }

    // AI insights (only for full access, non-empty leaderboard)
    let aiInsights = null;
    if (canViewAll && leaderboard.length > 0 && req.query.skipAI !== '1') {
      aiInsights = await getAIInsightsCached(leaderboard, reportScores, alerts, from, to);
    }

    // Summary
    const totalTasksDone = leaderboard.reduce((s, e) => s + e.tasksDone, 0);
    const avgCompletion = leaderboard.length ? Math.round(leaderboard.reduce((s, e) => s + e.completionPct, 0) / leaderboard.length) : 0;

    res.json({
      period: { from, to, days: _workingDaysBetween(from, to) },
      summary: {
        totalExecutives: leaderboard.length,
        activeExecutives: leaderboard.filter(e => !e.flags.inactive).length,
        totalTasksCompleted: totalTasksDone,
        avgCompletionRate: avgCompletion,
      },
      leaderboard,
      reportAnalyzerScore: reportScores,
      alerts,
      aiInsights,
      canViewAll,
    });
  } catch(e) {
    console.error('Productivity report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Force regenerate AI insights (bypasses cache)
productivityRouter.post('/productivity/regenerate-ai', authMiddleware, async (req, res) => {
  try {
    // Clear cache for this period
    const { from, to } = req.body;
    if (from && to) {
      for (const key of _aiInsightsCache.keys()) {
        if (key.startsWith(from + '|' + to + '|')) _aiInsightsCache.delete(key);
      }
    } else {
      _aiInsightsCache.clear();
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ── SALES RETENTION REPORT ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════
//
// Tracks business impact per Account Manager:
// - Monthly sales per AM (current vs previous month)
// - MoM growth % (target: 15%+ minimum)
// - Sellers with 0 sale (no grace period — zero is zero)
// - Sellers with <15% growth (concern)
// - Sellers with 15%+ growth (healthy)
// - ACOS management (current vs prev month)
// - Ticket burden + resolution speed
// - Overall "Retention Health Score" per AM

const salesRetentionRouter = require('express').Router();

const SR_NAMED_ADMINS = ['piyush','gaurav','manpreet','devendra','shivendra'];
const GROWTH_TARGET_PCT = 15; // Minimum expected monthly growth per seller

// Helpers
function _monthBoundaries(refDate) {
  // Returns {currFrom, currTo, prevFrom, prevTo} as YYYY-MM-DD strings
  const d = refDate ? new Date(refDate) : new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const currStart = new Date(y, m, 1);
  const currEnd   = new Date(y, m + 1, 0);
  const prevStart = new Date(y, m - 1, 1);
  const prevEnd   = new Date(y, m, 0);
  const iso = (dt) => dt.toISOString().split('T')[0];
  return {
    currFrom: iso(currStart), currTo: iso(currEnd),
    prevFrom: iso(prevStart), prevTo: iso(prevEnd),
    currLabel: currStart.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
    prevLabel: prevStart.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
  };
}

function _growthBucket(growthPct, hasCurr, hasPrev) {
  // Categorize a seller's month-over-month growth
  if (!hasPrev && !hasCurr) return 'dormant';       // no data either month
  if (!hasPrev && hasCurr)  return 'new_or_restart';// new sales this month, nothing last month
  if (hasPrev && !hasCurr)  return 'zero';          // had sales, now zero
  if (growthPct < 0)         return 'negative';
  if (growthPct < GROWTH_TARGET_PCT) return 'below_target'; // 0 to <15%
  return 'healthy';                                  // 15%+
}

// Aggregate DSR data into client monthly totals
function _clientMonthlyTotals(dsrRows) {
  // Returns { client_code: { sales, adSpend, orders } }
  const map = {};
  (dsrRows || []).forEach(r => {
    const cc = r.client_code;
    if (!cc) return;
    if (!map[cc]) map[cc] = { sales: 0, adSpend: 0, orders: 0, entries: 0 };
    map[cc].sales   += parseFloat(r.sales_amount || 0);
    map[cc].adSpend += parseFloat(r.ad_spend || 0);
    map[cc].orders  += parseInt(r.orders_count || 0);
    map[cc].entries += 1;
  });
  return map;
}

function _amRetentionScore(am) {
  // am object contains aggregated numbers. Returns 0-100.
  const sellers = am.totalSellers || 1;

  // 1. Growth score (40 pts) — based on avg growth across sellers
  let growthScore = 0;
  if (am.avgGrowthPct >= 20) growthScore = 40;
  else if (am.avgGrowthPct >= 15) growthScore = 35;
  else if (am.avgGrowthPct >= 10) growthScore = 28;
  else if (am.avgGrowthPct >= 5)  growthScore = 20;
  else if (am.avgGrowthPct >= 0)  growthScore = 12;
  else if (am.avgGrowthPct >= -10) growthScore = 5;
  else growthScore = 0;

  // 2. Zero sale penalty (up to -30)
  const zeroPct = (am.zeroSaleCount / sellers) * 100;
  let zeroPenalty = 0;
  if (zeroPct >= 40) zeroPenalty = 30;
  else if (zeroPct >= 25) zeroPenalty = 20;
  else if (zeroPct >= 15) zeroPenalty = 12;
  else if (zeroPct >= 5)  zeroPenalty = 5;

  // 3. Ticket health (20 pts) — fewer tickets + fast resolution
  let ticketScore = 20;
  const ticketsPerSeller = am.totalTickets / sellers;
  if (ticketsPerSeller > 3)     ticketScore -= 8;
  else if (ticketsPerSeller > 2) ticketScore -= 4;
  if (am.avgResolutionHours > 48) ticketScore -= 8;
  else if (am.avgResolutionHours > 24) ticketScore -= 4;
  if (am.agedTickets > 0) ticketScore -= (am.agedTickets * 2);
  ticketScore = Math.max(0, ticketScore);

  // 4. ACOS management (20 pts) — based on current ACOS + trend
  let acosScore = 0;
  const acos = am.avgACOS;
  if (acos == null || isNaN(acos)) acosScore = 10; // neutral if no data
  else if (acos < 20) acosScore = 20;
  else if (acos < 25) acosScore = 17;
  else if (acos < 30) acosScore = 13;
  else if (acos < 40) acosScore = 8;
  else acosScore = 3;
  // Bonus if improved from last month
  if (am.acosImproved) acosScore = Math.min(20, acosScore + 3);

  // 5. Tenure bonus (0-10 pts) — based on retention/staying power
  // Proxy: % of sellers with >90 day seller_aging
  let tenureBonus = 0;
  if (am.stableSellerPct >= 70) tenureBonus = 10;
  else if (am.stableSellerPct >= 50) tenureBonus = 6;
  else if (am.stableSellerPct >= 30) tenureBonus = 3;

  const base = Math.max(0, growthScore - zeroPenalty + ticketScore + acosScore + tenureBonus);
  return {
    total: Math.min(100, Math.round(base)),
    breakdown: {
      growthScore, zeroPenalty, ticketScore, acosScore, tenureBonus,
    },
  };
}

function _retentionGrade(score) {
  if (score >= 85) return { grade: 'A+', label: '🌟 Elite Retainer' };
  if (score >= 75) return { grade: 'A',  label: '🏆 Strong Retainer' };
  if (score >= 60) return { grade: 'B',  label: '👍 Solid' };
  if (score >= 45) return { grade: 'C',  label: '⚠️ Needs Attention' };
  if (score >= 30) return { grade: 'D',  label: '🔴 Churn Risk' };
  return            { grade: 'F', label: '🚨 Critical — Intervention' };
}

// Main endpoint: full retention report for all AMs
salesRetentionRouter.get('/sales-retention', authMiddleware, async (req, res) => {
  try {
    const { role, name } = req.user;
    const lowerName = (name || '').toLowerCase();
    const isNamedAdmin = SR_NAMED_ADMINS.some(n => lowerName.includes(n));
    const FULL_ACCESS = ['Admin','Ops Lead','CRM Lead','CSI Lead','Sub Admin'];
    const canViewAll = FULL_ACCESS.includes(role) || isNamedAdmin;

    const refDate = req.query.refDate || null;
    const bounds = _monthBoundaries(refDate);

    // Parallel fetch
    const [clientsRes, dsrCurrRes, dsrPrevRes, adsRes, ticketsRes, usersRes] = await Promise.all([
      supabase.from('clients').select('client_code, busy_name, am_name, marketplace, service_plan, status, seller_aging, renewal_date').in('status', ['Active','Hold']),
      supabase.from('dsr_data').select('client_code, sales_amount, ad_spend, orders_count, report_date').gte('report_date', bounds.currFrom).lte('report_date', bounds.currTo),
      supabase.from('dsr_data').select('client_code, sales_amount, ad_spend, orders_count, report_date').gte('report_date', bounds.prevFrom).lte('report_date', bounds.prevTo),
      supabase.from('ads_data').select('client_code, acos'),
      supabase.from('tickets').select('ticket_id, client_code, status, created_at, hours_to_close, resolved_by, assigned_to').gte('created_at', bounds.currFrom + 'T00:00:00'),
      supabase.from('users').select('name, role, joining_date').eq('is_active', true).eq('role', 'Account Manager'),
    ]);

    const clients = clientsRes.data || [];
    const currMonthly = _clientMonthlyTotals(dsrCurrRes.data);
    const prevMonthly = _clientMonthlyTotals(dsrPrevRes.data);
    const adsMap = {};
    (adsRes.data || []).forEach(a => { if (a.client_code) adsMap[a.client_code] = parseFloat(a.acos) || null; });
    const tickets = ticketsRes.data || [];
    const today = new Date();

    // Build per-seller records grouped by AM
    const amMap = {};
    clients.forEach(c => {
      const am = (c.am_name || '').trim();
      if (!am) return;
      if (!amMap[am]) amMap[am] = {
        am_name: am,
        sellers: [],
        totalSellers: 0,
        currSales: 0, prevSales: 0,
        totalAdSpend: 0, totalOrders: 0,
        zeroSaleCount: 0, negativeGrowthCount: 0,
        belowTargetCount: 0, healthyCount: 0,
        newOrRestartCount: 0, dormantCount: 0,
        growthPcts: [], // for avg calculation
        acosValues: [],
        stableSellers: 0, // sellers > 90 days old
      };
      const curr = currMonthly[c.client_code] || { sales: 0, adSpend: 0, orders: 0 };
      const prev = prevMonthly[c.client_code] || { sales: 0, adSpend: 0, orders: 0 };
      const hasCurr = curr.sales > 0;
      const hasPrev = prev.sales > 0;
      let growthPct = 0;
      if (hasPrev) growthPct = Math.round(((curr.sales - prev.sales) / prev.sales) * 100);
      else if (hasCurr) growthPct = 100;
      const bucket = _growthBucket(growthPct, hasCurr, hasPrev);

      const entry = amMap[am];
      entry.totalSellers++;
      entry.currSales += curr.sales;
      entry.prevSales += prev.sales;
      entry.totalAdSpend += curr.adSpend;
      entry.totalOrders  += curr.orders;

      if (bucket === 'zero') entry.zeroSaleCount++;
      else if (bucket === 'negative') entry.negativeGrowthCount++;
      else if (bucket === 'below_target') entry.belowTargetCount++;
      else if (bucket === 'healthy') entry.healthyCount++;
      else if (bucket === 'new_or_restart') entry.newOrRestartCount++;
      else if (bucket === 'dormant') entry.dormantCount++;

      // Only include growth% for sellers that actually had prev sales (stable comparison)
      if (hasPrev) entry.growthPcts.push(growthPct);
      if (adsMap[c.client_code] != null) entry.acosValues.push(adsMap[c.client_code]);
      if ((c.seller_aging || 0) > 90) entry.stableSellers++;

      entry.sellers.push({
        clientCode: c.client_code, busyName: c.busy_name,
        marketplace: c.marketplace, servicePlan: c.service_plan,
        sellerAging: c.seller_aging || 0,
        currSales: Math.round(curr.sales),
        prevSales: Math.round(prev.sales),
        growthPct,
        bucket,
        acos: adsMap[c.client_code] || null,
        renewalDate: c.renewal_date,
      });
    });

    // Compute ticket stats per AM (using assigned_to or resolved_by matching am_name)
    // Since tickets are assigned to generic roles mostly, we use client->AM map
    const clientAmMap = {};
    clients.forEach(c => { clientAmMap[c.client_code] = (c.am_name || '').trim(); });
    tickets.forEach(t => {
      const am = clientAmMap[t.client_code];
      if (!am || !amMap[am]) return;
      if (!amMap[am].tickets) amMap[am].tickets = [];
      amMap[am].tickets.push(t);
    });

    // Final AM list
    const amList = Object.values(amMap).map(am => {
      const ticketsArr = am.tickets || [];
      const closed = ticketsArr.filter(t => t.status === 'Done' && t.hours_to_close != null);
      const resolutionHours = closed.map(t => t.hours_to_close);
      const avgResolutionHours = resolutionHours.length
        ? Math.round(resolutionHours.reduce((s,h) => s+h, 0) / resolutionHours.length)
        : 0;
      const aged = ticketsArr.filter(t => {
        if (t.status === 'Done') return false;
        if (!t.created_at) return false;
        return Math.floor((today - new Date(t.created_at)) / 86400000) > 10;
      }).length;

      const mom = am.prevSales > 0
        ? Math.round(((am.currSales - am.prevSales) / am.prevSales) * 100)
        : (am.currSales > 0 ? 100 : 0);
      const avgGrowthPct = am.growthPcts.length
        ? Math.round(am.growthPcts.reduce((s,g) => s+g, 0) / am.growthPcts.length)
        : 0;
      const avgACOS = am.acosValues.length
        ? Math.round((am.acosValues.reduce((s,a) => s+a, 0) / am.acosValues.length) * 10) / 10
        : null;

      const stableSellerPct = am.totalSellers ? Math.round((am.stableSellers / am.totalSellers) * 100) : 0;
      const acosImproved = false; // placeholder — would need historical ACOS data

      const amInput = {
        totalSellers: am.totalSellers,
        avgGrowthPct,
        zeroSaleCount: am.zeroSaleCount,
        totalTickets: ticketsArr.length,
        avgResolutionHours,
        agedTickets: aged,
        avgACOS,
        acosImproved,
        stableSellerPct,
      };
      const scoreObj = _amRetentionScore(amInput);
      const gradeObj = _retentionGrade(scoreObj.total);

      return {
        amName: am.am_name,
        totalSellers: am.totalSellers,
        currMonthSales: Math.round(am.currSales),
        prevMonthSales: Math.round(am.prevSales),
        momGrowthPct: mom,
        avgSellerGrowthPct: avgGrowthPct,
        totalAdSpend: Math.round(am.totalAdSpend),
        totalOrders: am.totalOrders,
        avgACOS,
        // Bucket counts
        zeroSale: am.zeroSaleCount,
        negativeGrowth: am.negativeGrowthCount,
        belowTarget: am.belowTargetCount,
        healthy: am.healthyCount,
        newOrRestart: am.newOrRestartCount,
        dormant: am.dormantCount,
        // Ticket
        totalTickets: ticketsArr.length,
        avgResolutionHours,
        agedTickets: aged,
        ticketsPerSeller: am.totalSellers ? Math.round((ticketsArr.length / am.totalSellers) * 10) / 10 : 0,
        // Retention
        stableSellerPct,
        retentionScore: scoreObj.total,
        scoreBreakdown: scoreObj.breakdown,
        grade: gradeObj.grade,
        gradeLabel: gradeObj.label,
        sellers: am.sellers,
      };
    }).sort((a, b) => b.retentionScore - a.retentionScore);

    // Access filter
    let finalList = amList;
    if (!canViewAll) {
      finalList = amList.filter(am => am.amName.toLowerCase() === name.toLowerCase());
    }

    // Company-wide summary
    const totalCurrSales = amList.reduce((s, am) => s + am.currMonthSales, 0);
    const totalPrevSales = amList.reduce((s, am) => s + am.prevMonthSales, 0);
    const companyMoM = totalPrevSales > 0 ? Math.round(((totalCurrSales - totalPrevSales) / totalPrevSales) * 100) : 0;
    const totalZeroSale = amList.reduce((s, am) => s + am.zeroSale, 0);
    const totalHealthy  = amList.reduce((s, am) => s + am.healthy, 0);
    const totalSellers  = amList.reduce((s, am) => s + am.totalSellers, 0);

    // AI insights (only for full access)
    let aiInsights = null;
    if (canViewAll && finalList.length > 0 && req.query.skipAI !== '1') {
      aiInsights = await getRetentionAIInsights(finalList, bounds);
    }

    res.json({
      period: {
        currLabel: bounds.currLabel, prevLabel: bounds.prevLabel,
        currFrom: bounds.currFrom, currTo: bounds.currTo,
        prevFrom: bounds.prevFrom, prevTo: bounds.prevTo,
      },
      companySummary: {
        totalAMs: amList.length,
        totalSellers,
        currMonthSales: totalCurrSales,
        prevMonthSales: totalPrevSales,
        momGrowthPct: companyMoM,
        healthyPct: totalSellers ? Math.round((totalHealthy / totalSellers) * 100) : 0,
        zeroSalePct: totalSellers ? Math.round((totalZeroSale / totalSellers) * 100) : 0,
        zeroSaleCount: totalZeroSale,
      },
      amList: finalList,
      aiInsights,
      canViewAll,
      growthTarget: GROWTH_TARGET_PCT,
    });
  } catch(e) {
    console.error('Sales retention error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Drilldown: detailed seller list for a specific AM
salesRetentionRouter.get('/sales-retention/am/:amName', authMiddleware, async (req, res) => {
  try {
    const { role, name } = req.user;
    const lowerName = (name || '').toLowerCase();
    const isNamedAdmin = SR_NAMED_ADMINS.some(n => lowerName.includes(n));
    const FULL_ACCESS = ['Admin','Ops Lead','CRM Lead','CSI Lead','Sub Admin'];
    const canViewAll = FULL_ACCESS.includes(role) || isNamedAdmin;
    const requestedAM = decodeURIComponent(req.params.amName);
    if (!canViewAll && requestedAM.toLowerCase() !== name.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const bounds = _monthBoundaries(req.query.refDate);
    const [clientsRes, dsrCurrRes, dsrPrevRes, adsRes] = await Promise.all([
      supabase.from('clients').select('client_code, busy_name, am_name, marketplace, service_plan, status, seller_aging, renewal_date').ilike('am_name', requestedAM).in('status', ['Active','Hold']),
      supabase.from('dsr_data').select('client_code, sales_amount, ad_spend, orders_count').gte('report_date', bounds.currFrom).lte('report_date', bounds.currTo),
      supabase.from('dsr_data').select('client_code, sales_amount, ad_spend, orders_count').gte('report_date', bounds.prevFrom).lte('report_date', bounds.prevTo),
      supabase.from('ads_data').select('client_code, acos'),
    ]);
    const clients = clientsRes.data || [];
    const currMonthly = _clientMonthlyTotals(dsrCurrRes.data);
    const prevMonthly = _clientMonthlyTotals(dsrPrevRes.data);
    const adsMap = {};
    (adsRes.data || []).forEach(a => { if (a.client_code) adsMap[a.client_code] = parseFloat(a.acos) || null; });

    const sellers = clients.map(c => {
      const curr = currMonthly[c.client_code] || { sales: 0, adSpend: 0, orders: 0 };
      const prev = prevMonthly[c.client_code] || { sales: 0, adSpend: 0, orders: 0 };
      const hasCurr = curr.sales > 0, hasPrev = prev.sales > 0;
      let growthPct = 0;
      if (hasPrev) growthPct = Math.round(((curr.sales - prev.sales) / prev.sales) * 100);
      else if (hasCurr) growthPct = 100;
      return {
        clientCode: c.client_code, busyName: c.busy_name,
        marketplace: c.marketplace, servicePlan: c.service_plan,
        sellerAging: c.seller_aging || 0,
        currSales: Math.round(curr.sales),
        prevSales: Math.round(prev.sales),
        growthPct,
        bucket: _growthBucket(growthPct, hasCurr, hasPrev),
        currOrders: curr.orders,
        currAdSpend: Math.round(curr.adSpend),
        acos: adsMap[c.client_code] || null,
        renewalDate: c.renewal_date,
      };
    }).sort((a, b) => a.growthPct - b.growthPct); // worst first

    res.json({ amName: requestedAM, period: bounds, sellers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI insights cache (separate from productivity cache)
const _retentionAICache = new Map();
async function getRetentionAIInsights(amList, bounds) {
  const key = bounds.currFrom + '|' + bounds.currTo + '|' + amList.map(a => a.amName).sort().join(',');
  const entry = _retentionAICache.get(key);
  if (entry && Date.now() - entry.timestamp < AI_CACHE_TTL_MS) {
    return { ...entry.data, fromCache: true };
  }

  const top3 = amList.slice(0, 3);
  const bottom3 = amList.slice(-3).reverse();
  const zeroSaleChamps = amList.filter(a => a.zeroSale >= 3).slice(0, 3);
  const growthChamps = amList.filter(a => a.avgSellerGrowthPct >= 15).slice(0, 5);

  const fmt = (a) => `- ${a.amName}: ${a.totalSellers} sellers, Curr ₹${(a.currMonthSales/100000).toFixed(1)}L (${a.momGrowthPct >= 0 ? '+' : ''}${a.momGrowthPct}% MoM), Healthy ${a.healthy}/${a.totalSellers}, ZeroSale ${a.zeroSale}, Avg Growth ${a.avgSellerGrowthPct}%, ACOS ${a.avgACOS != null ? a.avgACOS + '%' : 'N/A'}, ${a.totalTickets} tickets (${a.avgResolutionHours}h avg), Score ${a.retentionScore}/100 [${a.grade}]`;

  const prompt = `You are a retention + sales strategist for eNewcleus (Amazon seller management, Indore). Analyze this Account Manager team performance for ${bounds.currLabel} vs ${bounds.prevLabel}. Target: minimum 15% monthly growth per seller. Zero grace period.

TOP 3 RETAINERS:
${top3.map(fmt).join('\n')}

BOTTOM 3 (CHURN RISK):
${bottom3.map(fmt).join('\n')}

GROWTH CHAMPIONS (avg seller growth 15%+):
${growthChamps.length ? growthChamps.map(fmt).join('\n') : 'Koi nahi — alarming'}

ZERO-SALE CLUSTERS (AMs with 3+ zero-sale sellers):
${zeroSaleChamps.length ? zeroSaleChamps.map(a => '- ' + a.amName + ': ' + a.zeroSale + ' zero-sale out of ' + a.totalSellers).join('\n') : 'None'}

Return ONLY valid JSON:
{
  "summary": "3-4 line Hinglish overview focusing on retention health + concerns",
  "retentionChampions": [{"name": "...", "highlight": "Hinglish praise with data"}],
  "churnRisks": [{"name": "...", "issue": "Hinglish concern + possible reason"}],
  "zeroSaleAlerts": [{"name": "...", "action": "Specific action needed"}],
  "recommendations": ["specific action 1", "2", "3"]
}

Rules: 3 champions, 3 risks, 3 zero-sale alerts (if any), 3 recommendations. Tone: warm but direct, like a COO. Reference specific numbers. Keep JSON under 2000 chars.`;

  const raw = await callAI(prompt, { maxTokens: 1400 });
  if (!raw) {
    return {
      summary: 'AI insights abhi generate nahi ho paaye. Data review kar sakte ho directly.',
      retentionChampions: [], churnRisks: [], zeroSaleAlerts: [], recommendations: [],
      aiProvider: (process.env.AI_PROVIDER || 'gemini'),
      error: true,
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch(e) { parsed = { summary: raw.slice(0, 600), retentionChampions: [], churnRisks: [], zeroSaleAlerts: [], recommendations: [], parseError: true }; }

  const result = {
    ...parsed,
    generatedAt: new Date().toISOString(),
    aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'anthropic' ? 'claude-haiku-4-5' : 'gemini-2.5-flash',
  };
  _retentionAICache.set(key, { data: result, timestamp: Date.now() });
  return result;
}

// Regenerate AI (force refresh)
salesRetentionRouter.post('/sales-retention/regenerate-ai', authMiddleware, async (req, res) => {
  try {
    _retentionAICache.clear();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SINGLE EXPORT — SABHI ROUTERS SAATH ──────────────────────
module.exports = {
  crmRouter, csiRouter, tasksRouter, dashRouter, notifRouter,
  usersRouter, renewalsRouter, adsRouter, clientsRouter,
  hurdleRouter, renewalHistoryRouter, reportAnalyzerRouter,
  expectationsRouter, monthlyReportsRouter, misRouter, docsRouter, approvalRouter,
  productivityRouter, salesRetentionRouter,
};
