// ── CRM ROUTES ────────────────────────────────────────────────
const crmRouter = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

crmRouter.get('/today', authMiddleware, async (req, res) => {
  const today = new Date(); today.setHours(0,0,0,0);
  const { data, error } = await supabase.from('crm_calls').select('*')
    .eq('crm_executive', req.user.name).gte('created_at', today.toISOString())
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(c => ({
    callId: c.call_id, clientCode: c.client_code, clientName: c.client_name,
    callOutcome: c.call_outcome, sellerComment: c.seller_comment,
    severity: c.severity, nextFollowUp: c.next_follow_up,
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

crmRouter.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const callId = 'CRM' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('crm_calls').insert({
    call_id: callId, client_code: d.clientCode, client_name: d.clientName,
    crm_executive: req.user.name, call_outcome: d.callOutcome,
    seller_comment: d.sellerComment, severity: d.severity,
    next_follow_up: d.nextFollowUp || null, ticket_raised: d.ticketRaised || false,
  });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('activity_log').insert({
    client_code: d.clientCode, client_name: d.clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: 'CRM Call', action_detail: d.callOutcome + (d.sellerComment ? ' — ' + d.sellerComment : ''),
  });
  res.json({ success: true, callId });
});

// ── CSI ROUTES ────────────────────────────────────────────────
const csiRouter = require('express').Router();

csiRouter.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('csi_data').select('*').order('review_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  // Return latest per client
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
  // Upsert — update if exists for this client
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
  // Update client health
  await supabase.from('clients').update({ health_status: d.healthStatus, health_index: d.csiPercent, last_updated: new Date() }).eq('client_code', d.clientCode);
  await supabase.from('activity_log').insert({
    client_code: d.clientCode, client_name: d.clientName, user_name: req.user.name, user_role: req.user.role,
    action_type: 'CSI Review', action_detail: `CSI Score: ${d.csiPercent}% — ${d.healthStatus}`,
  });
  res.json({ success: true, csiId });
});

// ── TASKS ROUTES ──────────────────────────────────────────────
const tasksRouter = require('express').Router();

tasksRouter.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    query = query.or(`assigned_to.eq.${name},assigned_by.eq.${name}`);
  }
  const { data, error } = await query.limit(100);
  if (error) return res.status(500).json({ error: error.message });
  const now = new Date();
  res.json(data.map(t => ({
    taskId: t.task_id, title: t.title, description: t.description,
    clientCode: t.client_code, clientName: t.client_name,
    assignedTo: t.assigned_to, assignedToRole: t.assigned_to_role,
    assignedBy: t.assigned_by, assignedByRole: t.assigned_by_role,
    priority: t.priority, category: t.category, status: t.status,
    deadline: t.deadline, workLog: t.work_log,
    isOverdue: t.deadline && t.status !== 'Completed' ? new Date(t.deadline) < now : false,
    createdAt: new Date(t.created_at).toLocaleString('en-IN'),
    completedAt: t.completed_at ? new Date(t.completed_at).toLocaleString('en-IN') : '',
  })));
});

tasksRouter.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const taskId = 'TSK' + Date.now().toString().slice(-7);
  const { error } = await supabase.from('tasks').insert({
    task_id: taskId, title: d.title, description: d.description,
    client_code: d.clientCode || null, client_name: d.clientName || null,
    assigned_to: d.assignedTo, assigned_to_role: d.assignedToRole,
    assigned_by: req.user.name, assigned_by_role: req.user.role,
    priority: d.priority, category: d.category, deadline: d.deadline || null,
  });
  if (error) return res.status(500).json({ error: error.message });
  if (d.assignedTo !== req.user.name) {
    await supabase.from('notifications').insert({
      notif_id: 'NTF' + Date.now(), assigned_to: d.assignedTo, assigned_role: d.assignedToRole,
      type: 'NEW_TASK', message: `New task from ${req.user.name}: "${d.title}"`, related_id: taskId,
    });
  }
  res.json({ success: true, taskId });
});

tasksRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { status, workLog } = req.body;
  const updates = { status };
  if (workLog) updates.work_log = workLog;
  if (status === 'Completed') updates.completed_at = new Date();
  const { error } = await supabase.from('tasks').update(updates).eq('task_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Work Log
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

dashRouter.get('/team', authMiddleware, async (req, res) => {
  const { data: users } = await supabase.from('users').select('name, role').eq('is_active', true)
    .in('role', ['Account Manager', 'Ads Executive', 'CRM Executive']);
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
  const { data, error } = await supabase.from('users').select('user_code, name, email, role, is_active, last_login').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(u => ({ userId: u.user_code, name: u.name, email: u.email, role: u.role, isActive: u.is_active })));
});

usersRouter.post('/', authMiddleware, async (req, res) => {
  const { name, email, password, role } = req.body;
  const userCode = 'USR' + Date.now().toString().slice(-5);
  const { error } = await supabase.from('users').insert({ user_code: userCode, name, email: email.toLowerCase(), password_hash: password, role });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, userId: userCode });
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
    return { renewalId: r.renewal_id, clientCode: r.client_code, clientName: r.client_name, servicePlan: r.service_plan, amount: r.amount, renewalDate: r.renewal_date, status: r.status, owner: r.owner, daysLeft };
  }));
});

renewalsRouter.patch('/:id', authMiddleware, async (req, res) => {
  const { status, notes } = req.body;
  const { error } = await supabase.from('renewals').update({ status, notes, updated_at: new Date() }).eq('renewal_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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

module.exports = { crmRouter, csiRouter, tasksRouter, dashRouter, notifRouter, usersRouter, renewalsRouter, adsRouter };
