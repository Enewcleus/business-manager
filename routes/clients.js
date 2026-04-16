const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

async function getFilteredClients(user) {
  const { role, name } = user;
  const marketplaceFilter = (user.marketplaceAccess && user.marketplaceAccess.length > 0)
    ? user.marketplaceAccess : null;

  // Admin, Ops Lead, CSI Lead, CSI Executive, Sub Admin, CRM Executive, CRM Lead, Viewer — sab clients
  if (['Admin', 'Ops Lead', 'CRM Lead', 'CSI Lead', 'CSI Executive', 'Sub Admin', 'CRM Executive', 'Viewer'].includes(role)) {
    let q = supabase.from('clients').select('*').order('busy_name');
    if (marketplaceFilter) q = q.in('marketplace', marketplaceFilter);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (role === 'Account Manager') {
    let q = supabase.from('clients').select('*').ilike('am_name', `%${name}%`).order('busy_name');
    if (marketplaceFilter) q = q.in('marketplace', marketplaceFilter);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (role === 'Ads Executive') {
    let q = supabase.from('clients').select('*').ilike('ads_manager', `%${name}%`).order('busy_name');
    if (marketplaceFilter) q = q.in('marketplace', marketplaceFilter);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (['SME', 'Team Lead', 'Senior Executive'].includes(role)) {
    const { data: teamMembers } = await supabase
      .from('users').select('name, role')
      .ilike('reporting_to_name', `%${name}%`).eq('is_active', true);
    const teamNames = [name, ...(teamMembers || []).map(m => m.name)];
    const orFilter = teamNames.map(n =>
      `am_name.ilike.%${n}%,ads_manager.ilike.%${n}%,crm_executive.ilike.%${n}%`
    ).join(',');
    let q = supabase.from('clients').select('*').or(orFilter).order('busy_name');
    if (marketplaceFilter) q = q.in('marketplace', marketplaceFilter);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // Default — assigned clients only
  let q = supabase.from('clients').select('*')
    .or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`)
    .order('busy_name');
  if (marketplaceFilter) q = q.in('marketplace', marketplaceFilter);
  const { data, error } = await q;
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
    phone: c.phone || '',
    contactNumber: c.phone || '',
    paymentCycle: c.payment_cycle || 1,
    sellerAging: c.seller_aging || 0,
    tempAmName: c.temp_am_name || null,
    tempEndDate: c.temp_end_date || null,
    tempStartDate: c.temp_start_date || null,
    tempOriginalAm: c.temp_original_am || null,
    tempAdsManager: c.temp_ads_manager || null,
    tempCrmExecutive: c.temp_crm_executive || null,
    tempOriginalAds: c.temp_original_ads || null,
    tempOriginalCrm: c.temp_original_crm || null,
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await getFilteredClients(req.user);
    res.json(data.map(formatClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const clientCode = 'CLT' + Date.now().toString().slice(-6);
  const { error } = await supabase.from('clients').insert({
    client_code: clientCode, busy_name: d.busyName, marketplace: d.marketplace,
    am_name: d.amName, ads_manager: d.adsManager, crm_executive: d.crmExecutive,
    status: 'Active', service_plan: d.servicePlan,
    renewal_date: d.renewalDate || null, health_status: 'Healthy',
    phone: d.phone || null, added_by: req.user.name,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, clientCode });
});

router.patch('/:code', authMiddleware, async (req, res) => {
  const { busyName, marketplace, amName, adsManager, crmExecutive,
          servicePlan, renewalDate, status, phone } = req.body;
  const updates = { last_updated: new Date() };
  if (busyName !== undefined)     updates.busy_name     = busyName;
  if (marketplace !== undefined)  updates.marketplace   = marketplace;
  if (amName !== undefined)       updates.am_name       = amName;
  if (adsManager !== undefined)   updates.ads_manager   = adsManager;
  if (crmExecutive !== undefined) updates.crm_executive = crmExecutive;
  if (servicePlan !== undefined)  updates.service_plan  = servicePlan;
  if (renewalDate !== undefined)  updates.renewal_date  = renewalDate || null;
  if (status !== undefined)       updates.status        = status;
  if (phone !== undefined)        updates.phone         = phone || null;
  const { error } = await supabase.from('clients').update(updates).eq('client_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

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

router.get('/:code/timeline', authMiddleware, async (req, res) => {
  const cc = req.params.code;
  const [crmCalls, tickets, csiData, tasks, workLogs] = await Promise.all([
    supabase.from('crm_calls').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    supabase.from('tickets').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    supabase.from('csi_data').select('*').eq('client_code', cc).order('review_date', { ascending: false }).limit(5),
    supabase.from('tasks').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    supabase.from('work_log').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(20),
  ]);
  res.json({
    crmCalls: crmCalls.data || [], tickets: tickets.data || [],
    csiData: csiData.data || [], tasks: tasks.data || [],
    workLogs: workLogs.data || [],
  });
});

router.post('/:code/quick-action', authMiddleware, async (req, res) => {
  const { action } = req.body;
  const updates = {};
  if (action === 'mark-healthy') updates.health_status = 'Healthy';
  if (action === 'mark-atrisk')  updates.health_status = 'At Risk';
  if (action === 'mark-warning') updates.health_status = 'Warning';
  if (Object.keys(updates).length) {
    updates.last_updated = new Date();
    await supabase.from('clients').update(updates).eq('client_code', req.params.code);
  }
  res.json({ success: true });
});

router.delete('/:code', authMiddleware, async (req, res) => {
  if (!['Admin', 'Ops Lead'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const code = req.params.code;
  await supabase.from('crm_calls').delete().eq('client_code', code).catch(() => {});
  await supabase.from('csi_data').delete().eq('client_code', code).catch(() => {});
  await supabase.from('tasks').delete().eq('client_code', code).catch(() => {});
  await supabase.from('tickets').delete().eq('client_code', code).catch(() => {});
  await supabase.from('renewals').delete().eq('client_code', code).catch(() => {});
  await supabase.from('dsr_data').delete().eq('client_code', code).catch(() => {});
  await supabase.from('activity_log').delete().eq('client_code', code).catch(() => {});
  const { error } = await supabase.from('clients').delete().eq('client_code', code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get('/:code/activity', authMiddleware, async (req, res) => {
  const cc = req.params.code;
  const { data, error } = await supabase.from('activity_log').select('*')
    .eq('client_code', cc).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(l => ({
    actionType: l.action_type, actionDetail: l.action_detail,
    userName: l.user_name, userRole: l.user_role,
    timestamp: l.created_at ? new Date(l.created_at).toLocaleString('en-IN') : '—',
  })));
});

router.post('/quickaction', authMiddleware, async (req, res) => {
  const { clientCode, clientName, action } = req.body;
  await supabase.from('activity_log').insert({
    client_code: clientCode, client_name: clientName,
    user_name: req.user.name, user_role: req.user.role,
    action_type: action, action_detail: action,
  }).catch(() => {});
  res.json({ success: true });
});

module.exports = router;
