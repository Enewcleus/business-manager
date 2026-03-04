const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/clients
router.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('clients').select('*').order('busy_name');

  if (role === 'Account Manager') query = query.eq('am_name', name);
  else if (role === 'Ads Executive') query = query.eq('ads_manager', name);
  else if (role === 'CRM Executive') query = query.eq('crm_executive', name);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json(data.map(c => ({
    id: c.id,                          // ✅ Added — required for close requests, CSI, staff transfer
    clientCode: c.client_code,
    busyName: c.busy_name,
    marketplace: c.marketplace,
    amName: c.am_name,
    adsManager: c.ads_manager,
    crmExecutive: c.crm_executive,
    status: c.status,
    servicePlan: c.service_plan,
    renewalDate: c.renewal_date,
    healthStatus: c.health_status,
    healthIndex: c.health_index,
    sellerBudget: c.seller_budget,
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
  res.json({ success: true, clientCode });
});

// PUT /api/clients/:code
router.put('/:code', authMiddleware, async (req, res) => {
  const d = req.body;
  const { error } = await supabase.from('clients').update({
    busy_name: d.busyName, marketplace: d.marketplace,
    am_name: d.amName, ads_manager: d.adsManager, crm_executive: d.crmExecutive,
    status: d.status, service_plan: d.servicePlan,
    renewal_date: d.renewalDate || null, notes: d.notes,
    last_updated: new Date(),
  }).eq('client_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/clients/:code/timeline
router.get('/:code/timeline', authMiddleware, async (req, res) => {
  const cc = req.params.code;
  const [crmCalls, tickets, csiData, tasks] = await Promise.all([
    supabase.from('crm_calls').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    supabase.from('tickets').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    supabase.from('csi_data').select('*').eq('client_code', cc).order('review_date', { ascending: false }).limit(5),
    supabase.from('tasks').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
  ]);
  res.json({
    crmCalls: crmCalls.data || [],
    tickets: tickets.data || [],
    csiData: csiData.data || [],
    tasks: tasks.data || [],
  });
});

// Quick actions
router.post('/:code/quick-action', authMiddleware, async (req, res) => {
  const { action } = req.body;
  const updates = {};
  if (action === 'mark-healthy') updates.health_status = 'Healthy';
  if (action === 'mark-atrisk') updates.health_status = 'At Risk';
  if (action === 'mark-warning') updates.health_status = 'Warning';
  if (Object.keys(updates).length) {
    updates.last_updated = new Date();
    await supabase.from('clients').update(updates).eq('client_code', req.params.code);
  }
  res.json({ success: true });
});

module.exports = router;
