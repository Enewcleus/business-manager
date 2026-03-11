const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// ── Role-based client filtering ───────────────────────────────
async function getFilteredClients(user) {
  const { role, name } = user;

  // Admin, Ops Lead, CSI Lead → see ALL
  if (['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    const { data, error } = await supabase.from('clients').select('*').order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // Account Manager → sirf apne sellers (am_name field)
  if (role === 'Account Manager') {
    const { data, error } = await supabase.from('clients').select('*')
      .ilike('am_name', name).order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // CRM Executive → sirf apne sellers (crm_executive field)
  if (role === 'CRM Executive') {
    const { data, error } = await supabase.from('clients').select('*')
      .ilike('crm_executive', name).order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // Ads Executive → sirf apne sellers (ads_manager field)
  if (role === 'Ads Executive') {
    const { data, error } = await supabase.from('clients').select('*')
      .ilike('ads_manager', name).order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // SME, Team Lead, Senior Executive →
  // Apne allocated sellers (am_name/ads_manager/crm_executive mein naam) 
  // + Direct reports ke sellers
  if (['SME', 'Team Lead', 'Senior Executive'].includes(role)) {
    // Step 1: apni direct team ke members
    const { data: teamMembers } = await supabase
      .from('users')
      .select('name, role')
      .ilike('reporting_to_name', `%${name}%`)
      .eq('is_active', true);

    const teamNames = [name, ...(teamMembers || []).map(m => m.name)];

    // Step 2: un sab ka naam kisi bhi field mein ho wo sellers
    const orFilter = teamNames.map(n =>
      `am_name.ilike.%${n}%,ads_manager.ilike.%${n}%,crm_executive.ilike.%${n}%`
    ).join(',');

    const { data, error } = await supabase.from('clients').select('*')
      .or(orFilter).order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // Executive → sirf apne allocated sellers (kisi bhi field mein naam ho)
  if (role === 'Executive') {
    const { data, error } = await supabase.from('clients').select('*')
      .or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`)
      .order('busy_name');
    if (error) throw error;
    return data || [];
  }

  // Default → apne allocated sellers
  const { data, error } = await supabase.from('clients').select('*')
    .or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`)
    .order('busy_name');
  if (error) throw error;
  return data || [];
}

function formatClient(c) {
  return {
    id: c.id,
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
  };
}

// GET /api/clients
router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await getFilteredClients(req.user);
    res.json(data.map(formatClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// POST /api/clients/:code/quick-action
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

// DELETE /api/clients/:code — Admin/Ops Lead only
router.delete('/:code', authMiddleware, async (req, res) => {
  if (!['Admin', 'Ops Lead'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const code = req.params.code;
  // Delete from all related tables
  await supabase.from('crm_calls').delete().eq('client_code', code);
  await supabase.from('csi_data').delete().eq('client_code', code);
  await supabase.from('tasks').delete().eq('client_code', code);
  await supabase.from('tickets').delete().eq('client_code', code);
  await supabase.from('renewals').delete().eq('client_code', code);
  await supabase.from('dsr_entries').delete().eq('client_code', code).catch(()=>{});
  const { error } = await supabase.from('clients').delete().eq('client_code', code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;

// POST /api/clients/quickaction — legacy route (backward compat)
router.post('/quickaction', authMiddleware, async (req, res) => {
  const { clientCode, clientName, action } = req.body;
  await supabase.from('activity_log').insert({
    client_code: clientCode, client_name: clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: action, action_detail: action,
  }).catch(() => {});
  res.json({ success: true });
});
