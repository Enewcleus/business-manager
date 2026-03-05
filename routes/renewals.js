// routes/renewals.js — REPLACE existing file
// Verified: separate 'renewals' table exists (not clients.renewal_date)

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

// GET /api/renewals
router.get('/', auth, async (req, res) => {
  try {
    // Try renewals table first; fallback to clients.renewal_date
    let query = supabase.from('renewals').select('*').order('renewal_date', { ascending: true });

    if (req.user.role === 'Account Manager') {
      query = query.ilike('am_name', `%${req.user.name}%`);
    } else if (['Ops Lead','Team Lead','SME'].includes(req.user.role)) {
      query = query.ilike('am_name', `%${req.user.name}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const today = new Date(); today.setHours(0,0,0,0);
    const renewals = (data || []).map(r => {
      const rd = r.renewal_date ? new Date(r.renewal_date) : null;
      const daysLeft = rd ? Math.ceil((rd - today) / 86400000) : null;
      return {
        renewalId: r.id,
        clientCode: r.client_code,
        clientName: r.client_name || r.busy_name,
        servicePlan: r.service_plan,
        renewalDate: r.renewal_date,
        amount: r.amount || r.renewal_amount,
        status: r.status || r.renewal_status || 'Pending',
        daysLeft,
        owner: r.am_name,
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
    const today = new Date(); today.setHours(0,0,0,0);
    const { data } = await supabase.from('renewals')
      .select('renewal_date, status, renewal_status, amount, renewal_amount');
    let due7=0, due15=0, confirmed=0, overdue=0, totalValue=0;
    (data||[]).forEach(r => {
      const d = Math.ceil((new Date(r.renewal_date) - today) / 86400000);
      const st = r.status || r.renewal_status || 'Pending';
      const amt = Number(r.amount || r.renewal_amount || 0);
      if (st === 'Confirmed') { confirmed++; totalValue += amt; }
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
    const { status, renewalDate, amount, notes } = req.body;
    const updateData = {};
    if (status) { updateData.status = status; updateData.renewal_status = status; }
    if (renewalDate) updateData.renewal_date = renewalDate;
    if (amount !== undefined) { updateData.amount = amount; updateData.renewal_amount = amount; }
    if (notes) updateData.notes = notes;
    const { error } = await supabase.from('renewals').update(updateData).eq('id', req.params.id);
    if (error) throw error;
    if (status === 'Confirmed') {
      const { data: r } = await supabase.from('renewals').select('client_name, busy_name').eq('id', req.params.id).single();
      await supabase.from('notifications').insert({
        type: 'RENEWAL_CONFIRMED',
        message: `✅ Renewal confirmed: ${r?.client_name || r?.busy_name}`,
        for_roles: JSON.stringify(['Admin','Ops Lead','CSI Lead']), is_read: false,
      }).catch(()=>{});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/renewals/trigger-reminders
router.post('/trigger-reminders', auth, async (req, res) => {
  try {
    if (!['Admin','Ops Lead'].includes(req.user.role))
      return res.status(403).json({ error: 'Admin only' });
    const today = new Date(); today.setHours(0,0,0,0);
    const { data } = await supabase.from('renewals').select('*')
      .not('renewal_date','is',null)
      .not('status','eq','Confirmed');
    const reminders = [];
    for (const r of (data||[])) {
      const d = Math.ceil((new Date(r.renewal_date) - today) / 86400000);
      if (![15,7,1,0].includes(d)) continue;
      const name = r.client_name || r.busy_name || r.client_code;
      const emoji = d<=0?'🚨':d===1?'🔴':d===7?'⚠️':'📅';
      const msg = d<=0 ? `🚨 OVERDUE: ${name} ka renewal miss ho gaya!`
                       : `${emoji} Renewal in ${d} day${d!==1?'s':''}: ${name}`;
      const { data: ex } = await supabase.from('notifications').select('id')
        .eq('type','RENEWAL_ALERT').eq('related_client', r.client_code||'')
        .gte('created_at', today.toISOString()).limit(1);
      if (!ex?.length) reminders.push({
        type: 'RENEWAL_ALERT', message: msg,
        for_roles: JSON.stringify(['Admin','Ops Lead','CSI Lead']),
        is_read: false, related_client: r.client_code,
      });
    }
    if (reminders.length) await supabase.from('notifications').insert(reminders);
    res.json({ success: true, reminders_sent: reminders.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
