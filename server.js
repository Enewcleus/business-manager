const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();

const app = express();
app.set('etag', false);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

const PORT = process.env.PORT || 3001;

// ── PERFORMANCE: Compression (saves 60-70% bandwidth) ────────
app.use(compression({ level: 6 }));

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Static files with caching
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// Rate limiting
app.set('trust proxy', 1);
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
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
app.use('/api/dsr',             require('./routes/dsr'));
app.use('/api/close-requests',  require('./routes/close_requests'));
app.use('/api/settings',        require('./routes/settings'));
app.use('/api/payments',        require('./routes/payment'));
app.use('/api/hurdles',          require('./routes/allroutes').hurdleRouter);
app.use('/api/renewal-history',  require('./routes/allroutes').renewalHistoryRouter);
app.use('/api/report-analyzer',  require('./routes/allroutes').reportAnalyzerRouter);
app.use('/api/expectations',     require('./routes/allroutes').expectationsRouter);
app.use('/api/monthly-reports',  require('./routes/allroutes').monthlyReportsRouter);
app.use('/api/mis',              require('./routes/allroutes').misRouter);
app.use('/api/documents',        require('./routes/allroutes').docsRouter);
app.use('/api/approvals',        require('./routes/allroutes').approvalRouter);
app.use('/api/reports',          require('./routes/allroutes').productivityRouter);
app.use('/api/reports',          require('./routes/allroutes').salesRetentionRouter);
app.use('/api/chat',             require('./routes/chat'));
app.use('/api/ads-analyzer', require('./routes/allroutes').adsAnalyzerRouter);
const { feedbackRouter } = require('./routes/allroutes');
app.use('/api/feedback', feedbackRouter);

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── SERVE FRONTEND ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ── ERROR HANDLING ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => console.log(`eNewcleus Server running on port ${PORT}`));
