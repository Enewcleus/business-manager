const router = require('express').Router();
const supabase = require('../db');
const { generateToken, authMiddleware } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  const emailClean = email.toLowerCase().trim();

  const { data: users, error } = await supabase.from('users').select('*').eq('is_active', true);

  if (error) return res.json({ success: false, message: 'Database error: ' + error.message });

  const user = (users || []).find(u => u.email.toLowerCase().trim() === emailClean);
  if (!user) return res.json({ success: false, message: 'User not found: ' + emailClean });

  if (user.password_hash !== password) return res.json({ success: false, message: 'Incorrect password' });

  await supabase.from('users').update({ last_login: new Date() }).eq('id', user.id);

  const token = generateToken(user);
  res.json({
    success: true, token,
    user: { userId: user.user_code, name: user.name, email: user.email, role: user.role, assignedClients: user.assigned_clients || [] }
  });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
