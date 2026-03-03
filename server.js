const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0, lastModified: false }));

// Rate limiting — trust Railway proxy
app.set('trust proxy', 1);
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use('/api/', limiter);

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/clients',         require('./routes/clients'));
app.use('/api/tickets',         require('./routes/tickets'));
app.use('/api/crm',             require('./routes/crm'));
app.use('/api/csi',             require('./routes/csi'));
app.use('/api/tasks',           require('./routes/tasks'));
app.use('/api/renewals',        require('./routes/renewals'));
app.use('/api/ads',             require('./routes/ads'));
app.use('/api/dashboard',       require('./routes/dashboard'));
app.use('/api/notifications',   require('./routes/notifications'));
app.use('/api/users',           require('./routes/users'));
app.use('/api/close-requests',  require('./routes/close_requests'));

// ── SERVE FRONTEND ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => console.log(`eNewcleus Server running on port ${PORT}`));
