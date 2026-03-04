// routes/renewals.js — REPLACE existing file with this
// NEW: hierarchy filtering + auto reminder trigger + stats endpoint

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

// GET /api/renewals — with role-based filtering
router.get('/', auth, async (req, res) => {
  try {
    let query = supabase
      .from('clients')
      .select('id, client_code, busy_name, service_plan, renewal_date, renewal_amount, renewal_status, am_name, ops_lead')
      .not('renewal_date', 'is', null)
      .order('renewal_date', { ascending: true });

    // Ops Lead / Team Lead / SME — see only their sellers
    if (['Ops Lead', 'Team Lead', 'SME'].includes(req.user.role)) {
      query = query.or(
        `am_name.ilike.%${req.user.name}%,ops_lead.ilike.%${req.user.name}%`
      );
    }
    // Account Manager — only their own sellers
    if (req.user.role === 'Account Manager') {
      query = query.ilike('am_name', `%${req.user.name}%`);
    }

    const { data: clients, error } = await query;
    if (error) throw error;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const renewals = (clients || []).map(c => {
      const rd = c.renewal_date ? new Date(c.renewal_date) : null;
      const daysLeft = rd ? Math.ceil((rd - today) / 86400000) : null;
      return {
        renewalId: c.id,
        clientCode: c.client_code,
        clientName: c.busy_name,
        servicePlan: c.service_plan,
        renewalDate: c.renewal_date,
        amount: c.renewal_amount,
        status: c.renewal_status || 'Pending',
        daysLeft,
        owner: c.am_name,
        isUrgent: daysLeft !== null && daysLeft <= 7 && daysLeft >= 0,
        isDueSoon: daysLeft !== null && daysLeft <= 15 && daysLeft >= 0,
        isOverdue: daysLeft !== null && daysLeft < 0,
      };
    });
    res.json(renewals);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/renewals/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from('clients')
      .select('renewal_date, renewal_status, renewal_amount')
      .eq('status', 'Active')
      .not('renewal_date', 'is', null);

    let due7 = 0, due15 = 0, confirmed = 0, overdue = 0, totalValue = 0;
    (data || []).forEach(c => {
      const d = Math.ceil((new Date(c.renewal_date) - today) / 86400000);
      if (c.renewal_status === 'Confirmed') { confirmed++; totalValue += Number(c.renewal_amount || 0); }
      else if (d < 0) overdue++;
      else if (d <= 7) due7++;
      else if (d <= 15) due15++;
    });
    res.json({ due7, due15, confirmed, overdue, totalValue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/renewals/:id
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status, amount, renewalDate, notes } = req.body;
    const updateData = {};
    if (status) updateData.renewal_status = status;
    if (amount !== undefined) updateData.renewal_amount = amount;
    if (renewalDate) updateData.renewal_date = renewalDate;
    if (notes) updateData.renewal_notes = notes;
    if (status === 'Confirmed') updateData.renewal_confirmed_at = new Date().toISOString();

    const { error } = await supabase.from('clients').update(updateData).eq('id', req.params.id);
    if (error) throw error;

    // Notify on confirm
    if (status === 'Confirmed') {
      const { data: c } = await supabase.from('clients').select('busy_name').eq('id', req.params.id).single();
      await supabase.from('notifications').insert({
        type: 'RENEWAL_CONFIRMED',
        message: `✅ Renewal confirmed: ${c?.busy_name}`,
        for_roles: JSON.stringify(['Admin', 'Ops Lead', 'CSI Lead']),
        is_read: false,
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/renewals/trigger-reminders
// Call this daily (or add a cron job / Railway cron)
router.post('/trigger-reminders', auth, async (req, res) => {
  try {
    if (!['Admin', 'Ops Lead'].includes(req.user.role))
      return res.status(403).json({ error: 'Admin only' });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { data: clients } = await supabase
      .from('clients')
      .select('id, client_code, busy_name, renewal_date, am_name, renewal_status')
      .eq('status', 'Active')
      .not('renewal_date', 'is', null)
      .neq('renewal_status', 'Confirmed');

    const reminders = [];
    for (const c of (clients || [])) {
      const daysLeft = Math.ceil((new Date(c.renewal_date) - today) / 86400000);
      if (![15, 7, 1, 0].includes(daysLeft)) continue;

      const emoji = daysLeft <= 0 ? '🚨' : daysLeft === 1 ? '🔴' : daysLeft === 7 ? '⚠️' : '📅';
      const msg = daysLeft <= 0
        ? `🚨 OVERDUE: ${c.busy_name} ka renewal miss ho gaya!`
        : `${emoji} Renewal in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}: ${c.busy_name}`;

      // Avoid duplicate same-day
      const { data: exists } = await supabase
        .from('notifications')
        .select('id')
        .eq('type', 'RENEWAL_ALERT')
        .eq('related_client', c.client_code)
        .gte('created_at', today.toISOString())
        .limit(1);

      if (!exists?.length) {
        reminders.push({
          type: 'RENEWAL_ALERT',
          message: msg,
          for_roles: JSON.stringify(['Admin', 'Ops Lead', 'CSI Lead']),
          is_read: false,
          related_client: c.client_code,
        });
      }
    }

    if (reminders.length) await supabase.from('notifications').insert(reminders);
    res.json({ success: true, reminders_sent: reminders.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
