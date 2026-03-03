const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0, lastModified: false }));

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/clients',       require('./routes/clients'));
app.use('/api/tickets',       require('./routes/tickets'));
app.use('/api/crm',           require('./routes/crm'));
app.use('/api/csi',           require('./routes/csi'));
app.use('/api/tasks',         require('./routes/tasks'));
app.use('/api/renewals',      require('./routes/renewals'));
app.use('/api/ads',           require('./routes/ads'));
app.use('/api/dashboard',     require('./routes/dashboard'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/import',        require('./routes/import'));
app.use('/api/dsr',           require('./routes/dsr'));

app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`eNewcleus Server running on port ${PORT}`);
});
