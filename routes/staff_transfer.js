// routes/staff_transfer.js
// Staff Exit & Seller Transfer Workflow
// Add to server.js: app.use('/api/staff-transfer', require('./routes/staff_transfer'));

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

function adminOnly(req, res, next) {
  if (!['Admin', 'Ops Lead'].includes(req.user.role))
    return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── SUPABASE TABLE REQUIRED ──────────────────────────────────
// Run this SQL in Supabase:
/*
CREATE TABLE staff_transfer_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  exiting_user TEXT NOT NULL,
  transfer_to TEXT NOT NULL,
  transfer_type TEXT NOT NULL,
  fields_to_transfer JSONB DEFAULT '[]',
  reason TEXT,
  effective_date DATE,
  requested_by TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_remark TEXT,
  resolved_by TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);
*/

// POST /api/staff-transfer — Submit transfer request
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { exiting_user, transfer_to, transfer_type, fields_to_transfer, reason, effective_date } = req.body;
    if (!exiting_user || !transfer_to) return res.status(400).json({ error: 'exiting_user and transfer_to required' });

    // Check for existing pending request
    const { data: existing } = await supabase
      .from('staff_transfer_requests')
      .select('id')
      .eq('exiting_user', exiting_user)
      .eq('status', 'pending')
      .limit(1);

    if (existing?.length) return res.status(409).json({ error: 'Already one pending transfer for this user' });

    const { data, error } = await supabase
      .from('staff_transfer_requests')
      .insert({
        exiting_user,
        transfer_to,
        transfer_type: transfer_type || 'Full Transfer',
        fields_to_transfer: fields_to_transfer || [],
        reason: reason || '',
        effective_date: effective_date || new Date().toISOString().split('T')[0],
        requested_by: req.user.name,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (e) {
    console.error('staff_transfer POST error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/staff-transfer/pending
router.get('/pending', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_transfer_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/staff-transfer/all
router.get('/all', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_transfer_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/staff-transfer/preview/:username — See what will be transferred
router.get('/preview/:username', auth, adminOnly, async (req, res) => {
  try {
    const { username } = req.params;
    const [am, ads, crm, adsData] = await Promise.all([
      supabase.from('clients').select('client_code, busy_name').eq('am_name', username),
      supabase.from('clients').select('client_code, busy_name').eq('ads_manager', username),
      supabase.from('clients').select('client_code, busy_name').eq('crm_executive', username),
      supabase.from('ads_data').select('id').eq('ads_manager', username),
    ]);
    res.json({
      am_clients: am.data || [],
      ads_clients: ads.data || [],
      crm_clients: crm.data || [],
      ads_data_count: adsData.data?.length || 0,
      total: (am.data?.length || 0) + (ads.data?.length || 0) + (crm.data?.length || 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/staff-transfer/:id — Approve and execute
router.patch('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_remark } = req.body;

    const { data: request, error: fetchErr } = await supabase
      .from('staff_transfer_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !request) return res.status(404).json({ error: 'Request not found' });

    if (status === 'approved') {
      const { exiting_user, transfer_to, fields_to_transfer } = request;
      const updates = [];

      // Transfer clients fields
      if (fields_to_transfer.includes('am_name')) {
        updates.push(
          supabase.from('clients').update({ am_name: transfer_to }).ilike('am_name', exiting_user)
        );
      }
      if (fields_to_transfer.includes('ads_manager')) {
        updates.push(
          supabase.from('clients').update({ ads_manager: transfer_to }).ilike('ads_manager', exiting_user)
        );
        updates.push(
          supabase.from('ads_data').update({ ads_manager: transfer_to }).ilike('ads_manager', exiting_user)
        );
      }
      if (fields_to_transfer.includes('crm_executive')) {
        updates.push(
          supabase.from('clients').update({ crm_executive: transfer_to }).ilike('crm_executive', exiting_user)
        );
      }

      await Promise.all(updates);

      // Mark exiting user inactive
      await supabase.from('users').update({ is_active: false }).ilike('name', exiting_user);

      // Create notification
      await supabase.from('notifications').insert({
        type: 'STAFF_TRANSFER',
        message: `✅ Staff transfer done: ${exiting_user} → ${transfer_to}`,
        for_roles: JSON.stringify(['Admin', 'Ops Lead']),
        is_read: false,
      });
    }

    const { error: updateErr } = await supabase
      .from('staff_transfer_requests')
      .update({
        status,
        admin_remark: admin_remark || '',
        resolved_at: new Date().toISOString(),
        resolved_by: req.user.name,
      })
      .eq('id', id);

    if (updateErr) throw updateErr;
    res.json({ success: true, status });
  } catch (e) {
    console.error('staff_transfer PATCH error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
