// routes/clients_updated.js — REPLACE routes/clients.js with this
// NEW: Role-based visibility (Ops Lead, SME, Team Lead see only their team)

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Role-based client filter
async function getFilteredClients(user) {
  const role = user.role;
  const name = user.name;

  let query = supabase
    .from('clients')
    .select('id, client_code, busy_name, marketplace, am_name, ads_manager, crm_executive, ops_lead, service_plan, status, health_status, renewal_date, seller_budget, csi_score, csi_percent')
    .order('busy_name', { ascending: true });

  if (role === 'Account Manager') {
    query = query.ilike('am_name', `%${name}%`);

  } else if (role === 'CRM Executive') {
    query = query.ilike('crm_executive', `%${name}%`);

  } else if (role === 'Ads Executive') {
    const { data: adsSellers } = await supabase
      .from('ads_data').select('client_code').ilike('ads_manager', `%${name}%`);
    const codes = [...new Set((adsSellers||[]).map(a => a.client_code))];
    if (!codes.length) return [];
    query = query.in('client_code', codes);

  } else if (['SME', 'Ops Lead', 'Team Lead'].includes(role)) {
    // Get direct reports
    const { data: teamMembers } = await supabase
      .from('users').select('name').ilike('reporting_to_name', `%${name}%`);
    const teamNames = [...(teamMembers||[]).map(m => m.name), name];
    const orParts = teamNames.map(n => `am_name.ilike.%${n}%`);
    orParts.push(`ops_lead.ilike.%${name}%`);
    query = query.or(orParts.join(','));
  }
  // Admin, CSI Lead, Senior Executive see all

  const { data, error } = await query;
  if (error) throw error;

  return (data||[]).map(c => ({
    id: c.id,
    clientCode: c.client_code,
    busyName: c.busy_name,
    marketplace: c.marketplace,
    amName: c.am_name,
    adsManager: c.ads_manager,
    crmExecutive: c.crm_executive,
    opsLead: c.ops_lead,
    servicePlan: c.service_plan,
    status: c.status || 'Active',
    healthStatus: c.health_status || 'Healthy',
    renewalDate: c.renewal_date,
    sellerBudget: c.seller_budget,
    csiScore: c.csi_score,
    csiPercent: c.csi_percent,
  }));
}

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    res.json(await getFilteredClients(req.user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  try {
    if (!['Admin','Ops Lead'].includes(req.user.role))
      return res.status(403).json({ error: 'Not authorized' });
    const { busyName, marketplace, amName, adsManager, crmExecutive, servicePlan, renewalDate, sellerBudget, opsLead } = req.body;
    if (!busyName) return res.status(400).json({ error: 'busyName required' });
    const prefix = busyName.replace(/[^a-zA-Z]/g,'').slice(0,3).toUpperCase();
    const clientCode = prefix + Math.floor(1000 + Math.random() * 9000);
    const { data, error } = await supabase.from('clients').insert({
      client_code: clientCode, busy_name: busyName, marketplace: marketplace || 'Amazon',
      am_name: amName || '', ads_manager: adsManager || '', crm_executive: crmExecutive || '',
      service_plan: servicePlan || 'Basic', renewal_date: renewalDate || null,
      seller_budget: sellerBudget || 0, ops_lead: opsLead || req.user.name,
      status: 'Active', health_status: 'Healthy',
    }).select().single();
    if (error) throw error;
    await supabase.from('activity_logs').insert({ client_code: clientCode, client_name: busyName, action_type: 'Client Added', action_detail: `New client: ${busyName} (${marketplace})`, user_name: req.user.name }).catch(()=>{});
    res.json({ success: true, clientCode, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/quickaction
router.post('/quickaction', auth, async (req, res) => {
  try {
    const { clientCode, clientName, action } = req.body;
    await supabase.from('activity_logs').insert({ client_code: clientCode, client_name: clientName, action_type: action, action_detail: `${action} — by ${req.user.name}`, user_name: req.user.name });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clients/:code/activity
router.get('/:code/activity', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('activity_logs').select('*').eq('client_code', req.params.code).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data||[]).map(l => ({ actionType: l.action_type, actionDetail: l.action_detail, userName: l.user_name, timestamp: l.created_at ? new Date(l.created_at).toLocaleString('en-IN') : '—' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clients/:code/timeline
router.get('/:code/timeline', auth, async (req, res) => {
  try {
    const code = req.params.code;
    const [crm, tickets, csi, tasks] = await Promise.all([
      supabase.from('crm_logs').select('*').eq('client_code', code).order('created_at', { ascending: false }).limit(20),
      supabase.from('tickets').select('*').eq('client_code', code).order('created_at', { ascending: false }).limit(20),
      supabase.from('csi_reviews').select('*').eq('client_code', code).order('review_date', { ascending: false }).limit(10),
      supabase.from('tasks').select('*').eq('client_code', code).order('created_at', { ascending: false }).limit(20),
    ]);
    res.json({ crmCalls: crm.data||[], tickets: tickets.data||[], csiData: csi.data||[], tasks: tasks.data||[] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
