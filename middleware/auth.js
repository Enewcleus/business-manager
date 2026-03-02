const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'enewcleus_secret_2025';

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, user_code: user.user_code },
    SECRET,
    { expiresIn: '12h' }
  );
}

module.exports = { authMiddleware, generateToken };
