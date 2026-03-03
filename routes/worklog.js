const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/worklog?client=CLT001&date=2026-03-03
router.get('/', authMiddleware, async (req, res) => {
  const { client, date, from, to } = req.query;
  let query = supabase.from('seller_worklog').select('*').order('created_at', { ascending: false });
  if (client) query = query.eq('client_code', client);
  if (date) query = query.eq('work_date', date);
  if (from) query = query.gte('work_date', from);
  if (to) query = query.lte('work_date', to);
  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/worklog
router.post('/', authMiddleware, async (req, res) => {
  const { clientCode, clientName, workDate, department, workType, description, campaignName, budgetChange, suggestion, issueRaised, nextAction } = req.body;
  if (!clientCode || !workDate) return res.status(400).json({ error: 'clientCode and workDate required' });
  const { error } = await supabase.from('seller_worklog').insert({
    client_code: clientCode, client_name: clientName, work_date: workDate,
    department: department || null, work_type: workType || null,
    description: description || null, campaign_name: campaignName || null,
    budget_change: budgetChange || null, suggestion: suggestion || null,
    issue_raised: issueRaised || null, next_action: nextAction || null,
    entered_by: req.user.name, entered_by_role: req.user.role,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE /api/worklog/:id (own entry only)
router.delete('/:id', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('seller_worklog').select('entered_by').eq('id', req.params.id).single();
  if (data?.entered_by !== req.user.name && req.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Sirf apni entry delete kar sakte ho' });
  }
  const { error } = await supabase.from('seller_worklog').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
