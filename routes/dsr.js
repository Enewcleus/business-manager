// routes/dsr.js — REPLACE existing file
// Verified table: dsr_data (not dsr_reports)

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

async function getSellerCodes(user) {
  const { role, name } = user;
  if (['Admin','Ops Lead','CSI Lead','Senior Executive'].includes(role)) return null;
  if (role === 'Account Manager') {
    const { data } = await supabase.from('clients').select('client_code').ilike('am_name', `%${name}%`);
    return (data || []).map(c => c.client_code);
  }
  if (role === 'CRM Executive') {
    const { data } = await supabase.from('clients').select('client_code').ilike('crm_executive', `%${name}%`);
    return (data || []).map(c => c.client_code);
  }
  if (role === 'Ads Executive') {
    const { data } = await supabase.from('ads_data').select('client_code').ilike('ads_manager', `%${name}%`);
    return [...new Set((data || []).map(d => d.client_code))];
  }
  if (['SME','Team Lead'].includes(role)) {
    const { data: team } = await supabase.from('users').select('name').ilike('reporting_to_name', `%${name}%`);
    const names = [...(team || []).map(m => m.name), name];
    const or = names.map(n => `am_name.ilike.%${n}%`).join(',');
    const { data } = await supabase.from('clients').select('client_code').or(or);
    return (data || []).map(c => c.client_code);
  }
  return null;
}

// GET /api/dsr
router.get('/', auth, async (req, res) => {
  try {
    const { from, to, client } = req.query;
    let query = supabase.from('dsr_data')
      .select('*').order('report_date', { ascending: false }).limit(500);
    if (from) query = query.gte('report_date', from);
    if (to)   query = query.lte('report_date', to);
    if (client) query = query.eq('client_code', client);
    const codes = await getSellerCodes(req.user);
    if (codes !== null) {
      if (!codes.length) return res.json([]);
      query = query.in('client_code', codes);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dsr/today-status
router.get('/today-status', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const codes = await getSellerCodes(req.user);
    let clientQuery = supabase.from('clients')
      .select('client_code, busy_name, marketplace, ads_manager').eq('status', 'Active');
    if (codes !== null) {
      if (!codes.length) return res.json({ total: 0, done: 0, pending: [] });
      clientQuery = clientQuery.in('client_code', codes);
    }
    const { data: allClients } = await clientQuery;
    const { data: todayDSR } = await supabase.from('dsr_data')
      .select('client_code').eq('report_date', today);
    const doneCodes = new Set((todayDSR || []).map(d => d.client_code));
    const pending = (allClients || []).filter(c => !doneCodes.has(c.client_code));
    res.json({
      total: (allClients || []).length, done: doneCodes.size,
      pending: pending.map(c => ({ client_code: c.client_code, busy_name: c.busy_name, marketplace: c.marketplace, ads_manager: c.ads_manager })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dsr/alerts
router.get('/alerts', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('dsr_data')
      .select('*')
      .or('alert_overspend.eq.true,alert_budget_80.eq.true,alert_high_returns.eq.true,alert_sales_drop.eq.true,alert_under_spend.eq.true')
      .order('report_date', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dsr/trend/:clientCode
router.get('/trend/:clientCode', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('dsr_data')
      .select('*').eq('client_code', req.params.clientCode)
      .order('report_date', { ascending: false }).limit(14);
    if (error) throw error;
    res.json((data || []).reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/dsr
router.post('/', auth, async (req, res) => {
  try {
    const { clientCode, clientName, reportDate, ordersCount, salesAmount, returnsCount, returnsAmount, adSpend, sellerBudget, notes } = req.body;
    if (!clientCode || !reportDate) return res.status(400).json({ error: 'clientCode and reportDate required' });

    const orders = Number(ordersCount) || 0;
    const sales  = Number(salesAmount) || 0;
    const retAmt = Number(returnsAmount) || 0;
    const spend  = Number(adSpend) || 0;
    const budget = Number(sellerBudget) || 0;

    const returnRate      = sales > 0 ? Math.round((retAmt / sales) * 100) : 0;
    const budgetUsed      = budget > 0 ? Math.round((spend / budget) * 100) : 0;
    const alertOverspend  = budget > 0 && spend > budget;
    const alertBudget80   = budget > 0 && budgetUsed >= 80 && !alertOverspend;
    const alertHighReturn = returnRate > 15;

    const { data: prev } = await supabase.from('dsr_data')
      .select('sales_amount').eq('client_code', clientCode)
      .lt('report_date', reportDate).order('report_date', { ascending: false }).limit(1);
    const alertSalesDrop = (prev?.[0]?.sales_amount || 0) > 0 && sales < (prev[0].sales_amount * 0.5);

    const { error } = await supabase.from('dsr_data').upsert({
      client_code: clientCode, client_name: clientName, report_date: reportDate,
      orders_count: orders, sales_amount: sales,
      returns_count: Number(returnsCount) || 0, returns_amount: retAmt,
      return_rate: returnRate, ad_spend: spend, seller_budget: budget,
      budget_used_pct: budgetUsed, alert_overspend: alertOverspend,
      alert_budget_80: alertBudget80, alert_high_returns: alertHighReturn,
      alert_sales_drop: alertSalesDrop, notes: notes || '',
      entered_by: req.user.name,
    }, { onConflict: 'client_code,report_date' });
    if (error) throw error;

    // Auto-ticket: 2+ consecutive zero sales days
    if (orders === 0 || sales === 0) {
      const { data: prevZero } = await supabase.from('dsr_data')
        .select('report_date').eq('client_code', clientCode)
        .lt('report_date', reportDate)
        .or('orders_count.eq.0,sales_amount.eq.0')
        .order('report_date', { ascending: false }).limit(1);

      if (prevZero?.length) {
        const { data: existing } = await supabase.from('tickets')
          .select('id').eq('client_code', clientCode)
          .ilike('category', '%Zero Sales%').eq('status', 'Open').limit(1);

        if (!existing?.length) {
          const { count } = await supabase.from('tickets').select('*', { count: 'exact', head: true });
          const ticketId = 'TKT' + String((count || 0) + 1001).padStart(4, '0');
          await supabase.from('tickets').insert({
            ticket_id: ticketId, client_code: clientCode, client_name: clientName,
            subject: `🚨 Zero Sales Alert — ${clientName}`, category: 'Zero Sales Alert',
            priority: 'High', status: 'Open', assigned_to: req.user.name, raised_by: 'System (Auto)',
            description: `${clientName} ke 2+ consecutive days zero sales. Date: ${reportDate}`,
          });
          await supabase.from('notifications').insert({
            type: 'ZERO_SALES_ALERT',
            message: `🚨 Zero Sales 2+ days: ${clientName} — Auto ticket ${ticketId}`,
            for_roles: JSON.stringify(['Admin', 'Ops Lead']), is_read: false,
          }).catch(() => {});
        }
      }
    }

    // Alert notifications
    if (alertOverspend || alertHighReturn) {
      await supabase.from('notifications').insert({
        type: 'DSR_ALERT',
        message: alertOverspend
          ? `⚠️ Budget overspent: ${clientName} — ₹${spend} vs ₹${budget}`
          : `⚠️ High returns (${returnRate}%): ${clientName}`,
        for_roles: JSON.stringify(['Admin', 'Ops Lead']),
        is_read: false, related_client: clientCode,
      }).catch(() => {});
    }

    res.json({ success: true, returnRate, budgetUsed, alerts: { alertOverspend, alertBudget80, alertHighReturn, alertSalesDrop } });
  } catch (e) {
    console.error('DSR POST:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
