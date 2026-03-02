const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/clients
router.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('clients').select('*').order('busy_name');

  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    if (role === 'Account Manager') query = query.eq('am_name', name);
    else if (role === 'Ads Executive') query = query.eq('ads_manager', name);
    else if (role === 'CRM Executive') query = query.eq('crm_executive', name);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json(data.map(c => ({
    clientCode: c.client_code, busyName: c.busy_name, marketplace: c.marketplace,
    amName: c.am_name, adsManager: c.ads_manager, crmExecutive: c.crm_executive,
    status: c.status, servicePlan: c.service_plan,
    renewalDate: c.renewal_date, healthStatus: c.health_status, healthIndex: c.health_index,
    lastUpdated: c.last_updated ? new Date(c.last_updated).toLocaleString('en-IN') : '',
    notes: c.notes,
  })));
});

// POST /api/clients
router.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const clientCode = 'CLT' + Date.now().toString().slice(-6);
  const { error } = await supabase.from('clients').insert({
    client_code: clientCode, busy_name: d.busyName, marketplace: d.marketplace,
    am_name: d.amName, ads_manager: d.adsManager, crm_executive: d.crmExecutive,
    status: 'Active', service_plan: d.servicePlan,
    renewal_date: d.renewalDate || null, health_status: 'Healthy',
    added_by: req.user.name,
  });
  if (error) return res.status(500).json({ error: error.message });

  // Log activity
  await supabase.from('activity_log').insert({
    client_code: clientCode, client_name: d.busyName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: 'Client Added', action_detail: 'New client onboarded',
  });

  res.json({ success: true, clientCode });
});

// POST /api/clients/quickaction
router.post('/quickaction', authMiddleware, async (req, res) => {
  const { clientCode, clientName, action } = req.body;
  await supabase.from('activity_log').insert({
    client_code: clientCode, client_name: clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: action, action_detail: action + ' by ' + req.user.name,
  });
  // Update last_updated
  await supabase.from('clients').update({ last_updated: new Date() }).eq('client_code', clientCode);
  res.json({ success: true });
});

// GET /api/clients/:code/activity
router.get('/:code/activity', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .eq('client_code', req.params.code)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(l => ({
    actionType: l.action_type, actionDetail: l.action_detail,
    userName: l.user_name, userRole: l.user_role,
    timestamp: new Date(l.created_at).toLocaleString('en-IN'),
  })));
});

module.exports = router;
