// ADD THIS TO server.js:
// const settingsRouter = require('./routes/settings');
// app.use('/api/settings', settingsRouter);
//
// Also run this SQL in Supabase:
// CREATE TABLE IF NOT EXISTS app_settings (
//   key TEXT PRIMARY KEY,
//   value TEXT,
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );

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

// GET /api/settings/access-matrix
router.get('/access-matrix', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'access_matrix')
      .single();
    if (error || !data) return res.json({ value: null });
    res.json({ value: data.value });
  } catch(e) {
    res.json({ value: null });
  }
});

// POST /api/settings/access-matrix  (Admin only)
router.post('/access-matrix', auth, async (req, res) => {
  if (!['Admin', 'Ops Lead'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only Admin can change access settings' });
  }
  try {
    const { value } = req.body;
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'access_matrix', value, updated_at: new Date() }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
