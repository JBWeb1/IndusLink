require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { migrate, pool } = require('./db');
const { requireAuth } = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Changes must arrive as JSON. Together with the SameSite cookie this blocks cross-site form posts.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Send changes as JSON.' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', requireAuth, require('./routes/api'), require('./routes/reports'), require('./routes/docs'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use('/vendor', express.static(path.join(path.dirname(require.resolve('three/package.json')), 'build'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  migrate().then(() => app.listen(port, () => console.log(`Stapel WMS running on http://localhost:${port}`)))
    .catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
}
module.exports = { app, migrate, pool };
