const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/payments?clientCode=xxx
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { clientCode } = req.query;
    let query = supabase.from('payments').select('*').order('payment_date', { ascending: false });
    if (clientCode) query = query.eq('client_code', clientCode);
    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json((data || []).map(p => ({
      id: p.id,
      clientCode: p.client_code,
      clientName: p.client_name,
      amount: p.amount,
      paymentDate: p.payment_date,
      paymentMode: p.payment_mode,
      utrNumber: p.utr_number,
      periodFrom: p.period_from,
      periodTo: p.period_to,
      recordedBy: p.recorded_by,
      notes: p.notes,
      createdAt: p.created_at,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { clientCode, clientName, amount, paymentDate, paymentMode,
            utrNumber, periodFrom, periodTo, notes } = req.body;
    if (!clientCode || !amount || !paymentDate)
      return res.status(400).json({ error: 'clientCode, amount, paymentDate required' });

    const { error } = await supabase.from('payments').insert({
      client_code: clientCode, client_name: clientName,
      amount: Number(amount), payment_date: paymentDate,
      payment_mode: paymentMode || 'UPI',
      utr_number: utrNumber || null,
      period_from: periodFrom || null,
      period_to: periodTo || null,
      recorded_by: req.user.name,
      notes: notes || null,
    });
    if (error) throw error;

    // Update renewal date on client
    if (periodTo) {
      await supabase.from('clients').update({ renewal_date: periodTo })
        .eq('client_code', clientCode);
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/payments/:id (Admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (!['Admin','Ops Lead','Sub Admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Not authorized' });
  const { error } = await supabase.from('payments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
