const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/dsr?date=2026-03-03&client=CLT001&from=2026-03-01&to=2026-03-31
router.get('/', authMiddleware, async (req, res) => {
  const { date, client, from, to } = req.query;
  let query = supabase.from('dsr_data').select('*').order('report_date', { ascending: false });
  if (date) query = query.eq('report_date', date);
  if (client) query = query.eq('client_code', client);
  if (from) query = query.gte('report_date', from);
  if (to) query = query.lte('report_date', to);
  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/dsr/today-status — which clients have DSR entered today
router.get('/today-status', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { data: clients } = await supabase.from('clients').select('client_code,busy_name,marketplace,ads_manager,seller_budget').eq('status','Active');
  const { data: todayDsr } = await supabase.from('dsr_data').select('client_code').eq('report_date', today);
  const doneSet = new Set((todayDsr||[]).map(d => d.client_code));
  res.json({
    total: (clients||[]).length,
    done: doneSet.size,
    pending: (clients||[]).filter(c => !doneSet.has(c.client_code)),
    completed: (clients||[]).filter(c => doneSet.has(c.client_code)),
  });
});

// GET /api/dsr/alerts — all active alerts
router.get('/alerts', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('dsr_data')
    .select('*')
    .or('alert_overspend.eq.true,alert_sales_drop.eq.true,alert_high_returns.eq.true,alert_budget_80.eq.true')
    .order('report_date', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/dsr/trend/:clientCode — last 7 days trend
router.get('/trend/:clientCode', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('dsr_data')
    .select('*')
    .eq('client_code', req.params.clientCode)
    .order('report_date', { ascending: false })
    .limit(7);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data||[]).reverse());
});

// POST /api/dsr — add/update daily report
router.post('/', authMiddleware, async (req, res) => {
  const { clientCode, clientName, reportDate, ordersCount, salesAmount, returnsCount, returnsAmount, adSpend, sellerBudget, notes } = req.body;
  
  if (!clientCode || !reportDate) return res.status(400).json({ error: 'clientCode and reportDate required' });

  const orders = parseFloat(ordersCount)||0;
  const sales = parseFloat(salesAmount)||0;
  const retCnt = parseFloat(returnsCount)||0;
  const retAmt = parseFloat(returnsAmount)||0;
  const spend = parseFloat(adSpend)||0;
  const budget = parseFloat(sellerBudget)||0;

  // Calculate rates
  const returnRate = orders > 0 ? (retCnt / orders * 100) : 0;
  const budgetUsedPct = budget > 0 ? (spend / budget * 100) : 0;

  // Check alerts
  const alertOverspend = budget > 0 && spend > budget;
  const alertBudget80 = budget > 0 && budgetUsedPct >= 80 && !alertOverspend;
  const alertHighReturns = returnRate > 10;

  // Check sales drop (last 3 days)
  const { data: recent } = await supabase.from('dsr_data')
    .select('sales_amount,report_date')
    .eq('client_code', clientCode)
    .order('report_date', { ascending: false })
    .limit(3);
  
  let alertSalesDrop = false;
  if (recent && recent.length >= 2) {
    const dropping = recent.every((r, i) => i === 0 || r.sales_amount >= (recent[i-1]?.sales_amount || 0));
    alertSalesDrop = dropping && sales < (recent[0]?.sales_amount || 0);
  }

  const record = {
    client_code: clientCode,
    client_name: clientName,
    report_date: reportDate,
    orders_count: orders,
    sales_amount: sales,
    returns_count: retCnt,
    returns_amount: retAmt,
    ad_spend: spend,
    seller_budget: budget,
    return_rate: Math.round(returnRate * 100) / 100,
    budget_used_pct: Math.round(budgetUsedPct * 100) / 100,
    alert_overspend: alertOverspend,
    alert_sales_drop: alertSalesDrop,
    alert_high_returns: alertHighReturns,
    alert_budget_80: alertBudget80,
    entered_by: req.user.name,
    notes: notes || null,
  };

  // Upsert (update if exists for same date)
  const { error } = await supabase.from('dsr_data').upsert(record, { onConflict: 'client_code,report_date' });
  if (error) return res.status(500).json({ error: error.message });

  // Create notification if alert
  if (alertOverspend || alertHighReturns) {
    const msg = alertOverspend 
      ? `⚠️ ${clientName}: Ad spend ₹${spend} budget ₹${budget} se zyada!`
      : `⚠️ ${clientName}: Returns ${returnRate.toFixed(1)}% — 10% se zyada!`;
    await supabase.from('notifications').insert({
      type: 'Alert', message: msg, client_code: clientCode, client_name: clientName,
      created_by: req.user.name,
    });
  }

  res.json({ 
    success: true, 
    alerts: { alertOverspend, alertSalesDrop, alertHighReturns, alertBudget80 },
    returnRate: returnRate.toFixed(1),
    budgetUsedPct: budgetUsedPct.toFixed(1),
  });
});

module.exports = router;
