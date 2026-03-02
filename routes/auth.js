const router = require('express').Router();
const supabase = require('../db');
const { generateToken, authMiddleware } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .eq('is_active', true)
    .single();

  if (error || !user) return res.json({ success: false, message: 'User not found or inactive' });
  if (user.password_hash !== password) return res.json({ success: false, message: 'Incorrect password' });

  // Update last login
  await supabase.from('users').update({ last_login: new Date() }).eq('id', user.id);

  const token = generateToken(user);
  res.json({
    success: true,
    token,
    user: {
      userId: user.user_code,
      name: user.name,
      email: user.email,
      role: user.role,
      assignedClients: user.assigned_clients || [],
    }
  });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
