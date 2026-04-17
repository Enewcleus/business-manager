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

// ── SINGLE EXPORT — SABHI ROUTERS SAATH ──────────────────────
module.exports = {
  crmRouter, csiRouter, tasksRouter, dashRouter, notifRouter,
  usersRouter, renewalsRouter, adsRouter, clientsRouter,
  hurdleRouter, renewalHistoryRouter, reportAnalyzerRouter,
  expectationsRouter, monthlyReportsRouter, misRouter, docsRouter,
};
