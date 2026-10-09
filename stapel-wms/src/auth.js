const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { q } = require('./db');
const { HttpError } = require('./util');

let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change-me') {
  if (process.env.NODE_ENV === 'production') throw new Error('Set JWT_SECRET to a long random string before running in production.');
  SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('JWT_SECRET is not set: using a temporary one. Everyone is signed out when the server restarts.');
}
const COOKIE = 'stapel_session';
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000, path: '/' };

function signIn(res, user) {
  res.cookie(COOKIE, jwt.sign({ uid: user.id }, SECRET, { expiresIn: '7d' }), cookieOpts);
}
function signOut(res) { res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }); }

/** Loads the user fresh on every request, so deactivating someone takes effect immediately. */
async function requireAuth(req, res, next) {
  try {
    const t = req.cookies[COOKIE];
    if (!t) throw new HttpError(401, 'Sign in to continue.');
    let p; try { p = jwt.verify(t, SECRET); } catch (e) { throw new HttpError(401, 'Your session has expired. Sign in again.'); }
    const u = (await q('SELECT id, company_id, name, email, role, active FROM users WHERE id=$1', [p.uid])).rows[0];
    if (!u || !u.active) throw new HttpError(401, 'This account is no longer active.');
    req.user = u;
    req.who = { companyId: u.company_id, userId: u.id };
    next();
  } catch (e) { next(e); }
}

module.exports = { signIn, signOut, requireAuth };
