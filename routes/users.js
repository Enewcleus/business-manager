const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET all users with hierarchy
router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users')
    .select('id, user_code, name, email, role, department, designation, reporting_to, is_active, last_login, permissions')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(u => ({
    id: u.id, userId: u.user_code, name: u.name, email: u.email,
    role: u.role, department: u.department, designation: u.designation,
    reportingTo: u.reporting_to, isActive: u.is_active,
    permissions: u.permissions || {},
  })));
});

// GET hierarchy — who reports to whom
router.get('/hierarchy', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users')
    .select('id, user_code, name, role, department, designation, reporting_to, is_active')
    .eq('is_active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  
  // Build tree
  const users = data || [];
  const tree = users.map(u => ({
    ...u,
    reports: users.filter(r => r.reporting_to === u.id).map(r => r.name)
  }));
  res.json(tree);
});

// GET my team (for leads)
router.get('/my-team', authMiddleware, async (req, res) => {
  const { data: me } = await supabase.from('users')
    .select('id').eq('user_code', req.user.userCode).single();
  if (!me) return res.json([]);
  
  const { data, error } = await supabase.from('users')
    .select('id, user_code, name, email, role, department, designation, is_active')
    .eq('reporting_to', me.id).eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST — create user
router.post('/', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
  const { name, email, password, role, department, designation, reportingTo } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  
  const userCode = 'USR' + Date.now().toString().slice(-5);
  
  // Get reporting_to UUID if provided
  let reportingToId = null;
  if (reportingTo) {
    const { data: mgr } = await supabase.from('users').select('id').eq('user_code', reportingTo).single();
    if (mgr) reportingToId = mgr.id;
  }
  
  const { error } = await supabase.from('users').insert({
    user_code: userCode, name, email: email.toLowerCase(),
    password_hash: password, role: role || 'Executive',
    department: department || null, designation: designation || null,
    reporting_to: reportingToId, is_active: true,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, userId: userCode });
});

// PATCH update user
router.patch('/:code', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
  const { name, email, role, department, designation, reportingTo, isActive } = req.body;
  
  let reportingToId = undefined;
  if (reportingTo !== undefined) {
    if (!reportingTo) { reportingToId = null; }
    else {
      const { data: mgr } = await supabase.from('users').select('id').eq('user_code', reportingTo).single();
      reportingToId = mgr?.id || null;
    }
  }
  
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email.toLowerCase();
  if (role !== undefined) updates.role = role;
  if (department !== undefined) updates.department = department;
  if (designation !== undefined) updates.designation = designation;
  if (reportingToId !== undefined) updates.reporting_to = reportingToId;
  if (isActive !== undefined) updates.is_active = isActive;
  
  const { error } = await supabase.from('users').update(updates).eq('user_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH password
router.patch('/:code/password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  const { error } = await supabase.from('users').update({ password_hash: password }).eq('user_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE (deactivate)
router.delete('/:code', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
  const { error } = await supabase.from('users').update({ is_active: false }).eq('user_code', req.params.code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
