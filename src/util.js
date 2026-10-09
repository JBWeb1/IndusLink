class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const str = (v, max, name, required = true) => {
  v = typeof v === 'string' ? v.trim() : '';
  if (required && !v) throw new HttpError(400, `${name} is required.`);
  if (v.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters).`);
  return v;
};
const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
/** Rands (number) in, integer cents out. */
const cents = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, `${name} must be an amount from 0 to 10 000 000.`);
  return Math.round(n * 100);
};
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}.`);
  return v;
};
const RANK = { picker: 1, manager: 2, admin: 3 };
const need = role => (req, res, next) =>
  RANK[req.user.role] >= RANK[role] ? next() : next(new HttpError(403, `Only a ${role}${role === 'admin' ? '' : ' or admin'} can do that.`));

/** Integer cents -> "R 1 234.50" (plain ASCII so PDFs render it). */
const money = c => (c < 0 ? '-' : '') + 'R ' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const csvCell = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

module.exports = { HttpError, h, str, int, cents, oneOf, need, money, csv, RANK };
