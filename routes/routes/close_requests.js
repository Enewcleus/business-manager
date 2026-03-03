const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// CRM: Submit close request
router.post('/', async (req, res) => {
  const { client_id, client_name, requested_by, reason } = req.body;
  if (!client_id || !requested_by || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Check if pending request already exists
  const { data: existing } = await supabase
    .from('seller_close_requests')
    .select('id')
    .eq('client_id', client_id)
    .eq('status', 'pending')
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Close request already pending for this seller' });
  }

  const { data, error } = await supabase
    .from('seller_close_requests')
    .insert([{ client_id, client_name, requested_by, reason }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// Admin: Get all pending requests
router.get('/pending', async (req, res) => {
  const { data, error } = await supabase
    .from('seller_close_requests')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin: Approve or Reject
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, admin_remark, client_id } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Update request status
  const { error: updateError } = await supabase
    .from('seller_close_requests')
    .update({ status, admin_remark, resolved_at: new Date().toISOString() })
    .eq('id', id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  // If approved → mark client inactive
  if (status === 'approved' && client_id) {
    const { error: clientError } = await supabase
      .from('clients')
      .update({ status: 'inactive' })
      .eq('id', client_id);

    if (clientError) return res.status(500).json({ error: clientError.message });
  }

  res.json({ success: true });
});

// Get all requests (for history)
router.get('/all', async (req, res) => {
  const { data, error } = await supabase
    .from('seller_close_requests')
    .select('*')
    .order('requested_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
