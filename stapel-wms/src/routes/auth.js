const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { tx, q } = require('../db');
const { h, str, HttpError } = require('../util');
const { signIn, signOut, requireAuth } = require('../auth');
const D = require('../domain');
const { seedExamples } = require('../seed');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Wait a few minutes and try again.' } });
const email = v => { v = str(v, 200, 'Email').toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new HttpError(400, 'Enter a valid email address.'); return v; };
const password = v => { if (typeof v !== 'string' || v.length < 8 || v.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.'); return v; };

router.post('/register', limiter, h(async (req, res) => {
  const b = req.body, company = str(b.company, 120, 'Company name'), name = str(b.name, 120, 'Your name'), em = email(b.email), pw = password(b.password);
  if ((await q('SELECT 1 FROM users WHERE email=$1', [em])).rows[0]) throw new HttpError(409, 'That email already has an account. Sign in instead.');
  const hash = await bcrypt.hash(pw, 11);
  const user = await tx(async c => {
    const co = (await c.query('INSERT INTO companies(name) VALUES ($1) RETURNING id', [company])).rows[0];
    const u = (await c.query("INSERT INTO users(company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'admin') RETURNING id", [co.id, name, em, hash])).rows[0];
    const wh = (await c.query("INSERT INTO warehouses(company_id, name, aisles, bays, levels, bin_capacity) VALUES ($1,'Main warehouse',4,8,3,60) RETURNING *", [co.id])).rows[0];
    await D.createBins(c, wh);
    if (b.examples) await seedExamples(c, { companyId: co.id, userId: u.id }, wh);
    return u;
  });
  signIn(res, user);
  res.status(201).json({ ok: true });
}));

router.post('/login', limiter, h(async (req, res) => {
  const em = email(req.body.email), pw = typeof req.body.password === 'string' ? req.body.password : '';
  const u = (await q('SELECT * FROM users WHERE email=$1', [em])).rows[0];
  if (!u || !u.active || !(await bcrypt.compare(pw, u.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
  signIn(res, u);
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => { signOut(res); res.json({ ok: true }); });

router.post('/password', requireAuth, h(async (req, res) => {
  const u = (await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) throw new HttpError(400, 'Your current password is incorrect.');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password(req.body.next), 11), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
