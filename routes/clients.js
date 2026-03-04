// routes/clients.js — Role-based visibility + 60s cache
// Actual table names: clients, activity_log, crm_calls, csi_data, dsr_data, tickets, tasks

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── 60s IN-MEMORY CACHE ───────────────────────────────────────
const _cache = new Map();
function cacheGet(key) {
  const item = _cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > 60000) { _cache.delete(key); return null; }
  return item.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }
function cacheClear() { _cache.clear(); }

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

async function getFilteredClients(user) {
  const cacheKey = `clients_${user.name}_${user.role}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { role, name } = user;
  let query = supabase
    .from('clients')
    .select('id, client_code, busy_name, marketplace, am_name, ads_manager, crm_executive, status, service_plan, renewal_date, health_status, health_index, notes, seller_budget')
    .order('busy_name', { ascending: true });

  if (role === 'Account Manager') {
    query = query.ilike('am_name', `%${name}%`);
  } else if (role === 'CRM Executive') {
    query = query.ilike('crm_executive', `%${name}%`);
  } else if (role === 'Ads Executive') {
    const { data: adsSellers } = await supabase
      .from('ads_data').select('client_code').ilike('ads_manager', `%${name}%`);
    const codes = [...new Set((adsSellers || []).map(a => a.client_code))];
    if (!codes.length) { cacheSet(cacheKey, []); return []; }
    query = query.in('client_code', codes);
  } else if (['SME', 'Team Lead'].includes(role)) {
    const { data: team } = await supabase
      .from('users').select('name').ilike('reporting_to_name', `%${name}%`);
    const names = [...(team || []).map(m => m.name), name];
    const or = names.map(n => `am_name.ilike.%${n}%,crm_executive.ilike.%${n}%`).join(',');
    query = query.or(or);
  } else if (role === 'Ops Lead') {
    const { data: team } = await supabase
      .from('users').select('name').ilike('reporting_to_name', `%${name}%`);
    const names = [...(team || []).map(m => m.name), name];
    const or = names.map(n => `am_name.ilike.%${n}%,crm_executive.ilike.%${n}%,ads_manager.ilike.%${n}%`).join(',');
    query = query.or(or);
  }
  // Admin, CSI Lead, Senior Executive → see all

  const { data, error } = await query;
  if (error) throw error;

  const result = (data || []).map(c => ({
    id: c.id,
    clientCode: c.client_code,
    busyName: c.busy_name,
    marketplace: c.marketplace,
    amName: c.am_name,
    adsManager: c.ads_manager,
    crmExecutive: c.crm_executive,
    servicePlan: c.service_plan,
    status: c.status || 'Active',
    healthStatus: c.health_status || 'Healthy',
    healthIndex: c.health_index,
    renewalDate: c.renewal_date,
    sellerBudget: c.seller_budget,
    notes: c.notes,
  }));

  cacheSet(cacheKey, result);
  return result;
}

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try { res.json(await getFilteredClients(req.user)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  try {
    if (!['Admin', 'Ops Lead'].includes(req.user.role))
      return res.status(403).json({ error: 'Not authorized' });
    const { busyName, marketplace, amName, adsManager, crmExecutive, servicePlan, renewalDate, sellerBudget } = req.body;
    if (!busyName) return res.status(400).json({ error: 'busyName required' });
    const prefix = busyName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
    const clientCode = prefix + Math.floor(1000 + Math.random() * 9000);
    const { data, error } = await supabase.from('clients').insert({
      client_code: clientCode, busy_name: busyName,
      marketplace: marketplace || 'Amazon',
      am_name: amName || '', ads_manager: adsManager || '',
      crm_executive: crmExecutive || '', service_plan: servicePlan || 'Basic',
      renewal_date: renewalDate || null, seller_budget: sellerBudget || 0,
      status: 'Active', health_status: 'Healthy', added_by: req.user.name,
    }).select().single();
    if (error) throw error;
    cacheClear();
    await supabase.from('activity_log').insert({   // ✅ actual table name
      client_code: clientCode, client_name: busyName,
      action_type: 'Client Added',
      action_detail: `New client: ${busyName} (${marketplace || 'Amazon'})`,
      user_name: req.user.name,
    }).catch(() => {});
    res.json({ success: true, clientCode, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/quickaction
router.post('/quickaction', auth, async (req, res) => {
  try {
    const { clientCode, clientName, action } = req.body;
    await supabase.from('activity_log').insert({   // ✅ actual table name
      client_code: clientCode, client_name: clientName,
      action_type: action, action_detail: action,
      user_name: req.user.name,
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clients/:clientCode/activity
router.get('/:clientCode/activity', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('activity_log')  // ✅ actual table name
      .select('*').eq('client_code', req.params.clientCode)
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data || []).map(l => ({
      actionType: l.action_type, actionDetail: l.action_detail,
      userName: l.user_name,
      timestamp: l.created_at ? new Date(l.created_at).toLocaleString('en-IN') : '—',
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clients/:clientCode/timeline
router.get('/:clientCode/timeline', auth, async (req, res) => {
  try {
    const cc = req.params.clientCode;
    const [crm, tix, csi, tsk] = await Promise.all([
      supabase.from('crm_calls').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(20),   // ✅
      supabase.from('tickets').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(20),
      supabase.from('csi_data').select('*').eq('client_code', cc).order('review_date', { ascending: false }).limit(10),   // ✅
      supabase.from('tasks').select('*').eq('client_code', cc).order('created_at', { ascending: false }).limit(10),
    ]);
    res.json({
      crmCalls: crm.data || [],
      tickets: tix.data || [],
      csiData: csi.data || [],
      tasks: tsk.data || [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
