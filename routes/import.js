const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

router.post('/clients', authMiddleware, async (req, res) => {
  if (!['Admin', 'Ops Lead'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only Admin/Ops Lead can bulk import' });
  }
  const { clients } = req.body;
  if (!clients || !Array.isArray(clients) || clients.length === 0) {
    return res.json({ success: false, message: 'No clients data provided' });
  }
  const results = { success: 0, failed: 0, errors: [] };
  for (const c of clients) {
    if (!c.busy_name || !c.marketplace) {
      results.failed++;
      continue;
    }
    const clientCode = 'CLT' + Date.now().toString().slice(-6) + Math.floor(Math.random()*100);
    const { error } = await supabase.from('clients').insert({
      client_code: clientCode,
      busy_name: c.busy_name.trim(),
      marketplace: c.marketplace.trim(),
      am_name: c.am_name || null,
      ads_manager: c.ads_manager || null,
      crm_executive: c.crm_executive || null,
      service_plan: c.service_plan || 'Basic',
      renewal_date: c.renewal_date || null,
      status: c.status || 'Active',
      notes: c.notes || null,
      health_status: 'Healthy',
      added_by: req.user.name,
    });
    if (error) { results.failed++; results.errors.push(c.busy_name + ': ' + error.message); }
    else { results.success++; }
    await new Promise(r => setTimeout(r, 30));
  }
  res.json({ success: true, message: `✅ ${results.success} imported, ❌ ${results.failed} failed`, results });
});

module.exports = router;
