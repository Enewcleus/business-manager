const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// ── GET pending transfers ─────────────────────────────────────
router.get('/pending', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('staff_transfers')
    .select('*').eq('status', 'pending').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET preview for a user ───────────────────────────────────
router.get('/preview/:name', authMiddleware, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const [am, ads, crm] = await Promise.all([
    supabase.from('clients').select('client_code, busy_name').ilike('am_name', `%${name}%`).eq('status','Active'),
    supabase.from('clients').select('client_code, busy_name').ilike('ads_manager', `%${name}%`).eq('status','Active'),
    supabase.from('clients').select('client_code, busy_name').ilike('crm_executive', `%${name}%`).eq('status','Active'),
  ]);
  res.json({
    am_clients: am.data || [],
    ads_clients: ads.data || [],
    crm_clients: crm.data || [],
    total: (am.data||[]).length + (ads.data||[]).length + (crm.data||[]).length,
  });
});

// ── POST account-wise permanent transfer ─────────────────────
router.post('/account-wise', authMiddleware, async (req, res) => {
  try {
    const { from_user, transfers, reason, effective_date } = req.body;
    if (!from_user || !transfers?.length) return res.status(400).json({ error: 'from_user and transfers required' });

    let successCount = 0;
    for (const t of transfers) {
      if (!t.clientCode || !t.transferTo) continue;

      // Get current client data
      const { data: client } = await supabase.from('clients')
        .select('am_name, ads_manager, crm_executive')
        .eq('client_code', t.clientCode).single();

      if (!client) continue;

      const updates = {};
      // Update whichever field matches from_user
      if ((client.am_name||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.am_name = t.transferTo;
      }
      if ((client.ads_manager||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.ads_manager = t.transferTo;
      }
      if ((client.crm_executive||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.crm_executive = t.transferTo;
      }

      if (Object.keys(updates).length) {
        await supabase.from('clients').update(updates).eq('client_code', t.clientCode);
        successCount++;
      }
    }

    // Log the transfer
    await supabase.from('staff_transfers').insert({
      exiting_user: from_user,
      transfer_to: 'Multiple (Account-wise)',
      transfer_type: 'Account-wise Permanent',
      fields_to_transfer: ['am_name'],
      reason: reason || '',
      effective_date: effective_date || new Date().toISOString().split('T')[0],
      status: 'approved',
      requested_by: req.user.name,
      admin_remark: `${successCount} accounts transferred account-wise`,
    });

    res.json({ success: true, transferred: successCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST temporary transfer ───────────────────────────────────
router.post('/temporary', authMiddleware, async (req, res) => {
  try {
    const { from_user, to_user, start_date, end_date, fields, clients } = req.body;
    if (!from_user || !to_user || !start_date || !end_date || !clients?.length) {
      return res.status(400).json({ error: 'All fields required' });
    }

    let successCount = 0;
    for (const c of clients) {
      const { data: client } = await supabase.from('clients')
        .select('am_name, ads_manager, crm_executive')
        .eq('client_code', c.clientCode).single();

      if (!client) continue;

      const updates = {
        temp_start_date: start_date,
        temp_end_date: end_date,
      };

      // Save originals and set temp
      if (fields.includes('am_name') && (client.am_name||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.temp_original_am = client.am_name;
        updates.temp_am_name = to_user;
        updates.am_name = to_user;
      }
      if (fields.includes('ads_manager') && (client.ads_manager||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.temp_original_ads = client.ads_manager;
        updates.temp_ads_manager = to_user;
        updates.ads_manager = to_user;
      }
      if (fields.includes('crm_executive') && (client.crm_executive||'').toLowerCase().includes(from_user.toLowerCase())) {
        updates.temp_original_crm = client.crm_executive;
        updates.temp_crm_executive = to_user;
        updates.crm_executive = to_user;
      }

      await supabase.from('clients').update(updates).eq('client_code', c.clientCode);
      successCount++;
    }

    // Log
    await supabase.from('staff_transfers').insert({
      exiting_user: from_user,
      transfer_to: to_user,
      transfer_type: 'Temporary',
      fields_to_transfer: fields,
      reason: `Temporary: ${start_date} to ${end_date}`,
      effective_date: start_date,
      status: 'approved',
      requested_by: req.user.name,
      admin_remark: `${successCount} accounts temp transferred till ${end_date}`,
    });

    res.json({ success: true, transferred: successCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST restore temp transfer ────────────────────────────────
router.post('/restore', authMiddleware, async (req, res) => {
  try {
    const { clients } = req.body;
    if (!clients?.length) return res.status(400).json({ error: 'clients required' });

    let successCount = 0;
    for (const c of clients) {
      const { data: client } = await supabase.from('clients')
        .select('temp_original_am, temp_original_ads, temp_original_crm, temp_am_name')
        .eq('client_code', c.clientCode).single();

      if (!client) continue;

      const updates = {
        temp_am_name: null, temp_ads_manager: null, temp_crm_executive: null,
        temp_start_date: null, temp_end_date: null,
        temp_original_am: null, temp_original_ads: null, temp_original_crm: null,
      };

      // Restore originals
      if (client.temp_original_am) updates.am_name = client.temp_original_am;
      if (client.temp_original_ads) updates.ads_manager = client.temp_original_ads;
      if (client.temp_original_crm) updates.crm_executive = client.temp_original_crm;

      await supabase.from('clients').update(updates).eq('client_code', c.clientCode);
      successCount++;
    }

    res.json({ success: true, restored: successCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST original transfer request ───────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { exiting_user, transfer_to, transfer_type, fields_to_transfer, reason, effective_date } = req.body;
    const { error } = await supabase.from('staff_transfers').insert({
      exiting_user, transfer_to, transfer_type,
      fields_to_transfer, reason, effective_date,
      status: 'pending',
      requested_by: req.user.name,
    });
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH approve/reject ──────────────────────────────────────
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { status, admin_remark } = req.body;

    if (status === 'approved') {
      const { data: transfer } = await supabase.from('staff_transfers')
        .select('*').eq('id', req.params.id).single();

      if (transfer) {
        const fields = transfer.fields_to_transfer || ['am_name', 'ads_manager', 'crm_executive'];
        const updates = {};
        if (fields.includes('am_name')) updates.am_name = transfer.transfer_to;
        if (fields.includes('ads_manager')) updates.ads_manager = transfer.transfer_to;
        if (fields.includes('crm_executive')) updates.crm_executive = transfer.transfer_to;

        if (Object.keys(updates).length) {
          for (const field of fields) {
            await supabase.from('clients').update(updates)
              .ilike(field, `%${transfer.exiting_user}%`);
          }
        }
      }
    }

    await supabase.from('staff_transfers').update({
      status, admin_remark,
      resolved_by: req.user.name,
      resolved_at: new Date(),
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
