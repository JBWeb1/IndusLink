const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { tx, q } = require('../db');
const { h, str, int, cents, oneOf, need, HttpError } = require('../util');
const D = require('../domain');

const id = v => int(v, 1, 2147483647, 'Id');
const skuCode = v => { v = str(v, 20, 'SKU code').toUpperCase(); if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(v)) throw new HttpError(400, 'SKU code: 2 to 20 letters, digits or dashes.'); return v; };

/* ---------- everything the app needs, in one call ---------- */
router.get('/state', h(async (req, res) => {
  const cid = req.user.company_id;
  const co = (await q('SELECT id, name, vat_number, reg_number, address, phone, email, bank_details, vat_rate FROM companies WHERE id=$1', [cid])).rows[0];
  const wh = await D.getWarehouse({ query: q }, cid);
  const [products, bins, partners, orders] = await Promise.all([
    q('SELECT id, sku, name, category, barcode, cost_cents, price_cents, reorder_level, active FROM products WHERE company_id=$1 ORDER BY sku', [cid]),
    q('SELECT code, aisle, bay, level, product_id, qty FROM bins WHERE warehouse_id=$1 ORDER BY aisle, bay, level', [wh.id]),
    q('SELECT id, type, name, vat_number, address, city, phone, email FROM partners WHERE company_id=$1 ORDER BY name', [cid]),
    q('SELECT * FROM orders WHERE company_id=$1 ORDER BY created_at DESC LIMIT 300', [cid]),
  ]);
  const ids = orders.rows.map(o => o.id);
  const [lines, allocs] = await Promise.all([
    q('SELECT order_id, product_id, qty, unit_cents FROM order_lines WHERE order_id = ANY($1) ORDER BY id', [ids]),
    q('SELECT order_id, product_id, bin_code, qty FROM order_allocations WHERE order_id = ANY($1) ORDER BY bin_code', [ids]),
  ]);
  const by = (rows, f) => { const m = new Map(); for (const r of rows) { if (!m.has(r.order_id)) m.set(r.order_id, []); m.get(r.order_id).push(f(r)); } return m; };
  const lm = by(lines.rows, r => ({ productId: r.product_id, qty: r.qty, unitCents: r.unit_cents }));
  const am = by(allocs.rows, r => ({ productId: r.product_id, bin: r.bin_code, qty: r.qty }));
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
    company: { name: co.name, vatNumber: co.vat_number, regNumber: co.reg_number, address: co.address, phone: co.phone, email: co.email, bankDetails: co.bank_details, vatRate: Number(co.vat_rate) },
    warehouse: { name: wh.name, aisles: wh.aisles, bays: wh.bays, levels: wh.levels, binCapacity: wh.bin_capacity },
    products: products.rows.map(p => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, barcode: p.barcode, costCents: p.cost_cents, priceCents: p.price_cents, reorder: p.reorder_level, active: p.active })),
    bins: bins.rows.map(b => ({ code: b.code, aisle: b.aisle, bay: b.bay, level: b.level, productId: b.product_id, qty: b.qty })),
    partners: partners.rows.map(p => ({ id: p.id, type: p.type, name: p.name, vatNumber: p.vat_number, address: p.address, city: p.city, phone: p.phone, email: p.email })),
    orders: orders.rows.map(o => ({ id: o.id, type: o.type, ref: o.ref, partnerId: o.partner_id, courier: o.courier, status: o.status, waybill: o.waybill, notes: o.notes, vatRate: Number(o.vat_rate), invoiceNo: o.invoice_no,
      createdAt: o.created_at, pickedAt: o.picked_at, dispatchedAt: o.dispatched_at, receivedAt: o.received_at, lines: lm.get(o.id) || [], allocs: am.get(o.id) || [] })),
  });
}));

/* ---------- products ---------- */
router.post('/products', need('manager'), h(async (req, res) => {
  const b = req.body;
  const r = await q(
    'INSERT INTO products(company_id, sku, name, category, barcode, cost_cents, price_cents, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (company_id, sku) DO NOTHING RETURNING id',
    [req.user.company_id, skuCode(b.sku), str(b.name, 120, 'Name'), str(b.category, 40, 'Category', false) || 'General', str(b.barcode, 48, 'Barcode', false),
      cents(b.cost ?? 0, 'Cost'), cents(b.price ?? 0, 'Selling price'), int(b.reorder ?? 0, 0, 1e6, 'Reorder level')]);
  if (!r.rows[0]) throw new HttpError(409, 'A product with that SKU code already exists.');
  res.status(201).json({ id: r.rows[0].id });
}));
router.patch('/products/:id', need('manager'), h(async (req, res) => {
  const b = req.body;
  const r = await q(
    'UPDATE products SET name=$3, category=$4, barcode=$5, cost_cents=$6, price_cents=$7, reorder_level=$8, active=$9 WHERE id=$1 AND company_id=$2 RETURNING id',
    [id(req.params.id), req.user.company_id, str(b.name, 120, 'Name'), str(b.category, 40, 'Category', false) || 'General', str(b.barcode, 48, 'Barcode', false),
      cents(b.cost, 'Cost'), cents(b.price, 'Selling price'), int(b.reorder, 0, 1e6, 'Reorder level'), b.active !== false]);
  if (!r.rows[0]) throw new HttpError(404, 'Product not found.');
  res.json({ ok: true });
}));

/* ---------- customers and suppliers ---------- */
const partnerFields = b => [oneOf(b.type, ['customer', 'supplier'], 'Type'), str(b.name, 120, 'Name'), str(b.vatNumber, 20, 'VAT number', false), str(b.address, 300, 'Address', false), str(b.city, 80, 'Town or city', false), str(b.phone, 30, 'Phone', false), str(b.email, 200, 'Email', false)];
router.post('/partners', need('manager'), h(async (req, res) => {
  const r = await q('INSERT INTO partners(company_id, type, name, vat_number, address, city, phone, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [req.user.company_id, ...partnerFields(req.body)]);
  res.status(201).json({ id: r.rows[0].id });
}));
router.patch('/partners/:id', need('manager'), h(async (req, res) => {
  const f = partnerFields(req.body);
  const r = await q('UPDATE partners SET name=$3, vat_number=$4, address=$5, city=$6, phone=$7, email=$8 WHERE id=$1 AND company_id=$2 RETURNING id', [id(req.params.id), req.user.company_id, ...f.slice(1)]);
  if (!r.rows[0]) throw new HttpError(404, 'Not found.');
  res.json({ ok: true });
}));

/* ---------- bins ---------- */
async function withBins(req, fn) {
  return tx(async c => {
    const wh = await D.getWarehouse(c, req.user.company_id), bins = await D.lockBins(c, wh.id);
    const find = code => { const b = bins.find(x => x.code === String(code).toUpperCase()); if (!b) throw new HttpError(404, `Bin ${code} does not exist.`); return b; };
    return fn(c, wh, find);
  });
}
router.post('/bins/:code/count', h(async (req, res) => {
  await withBins(req, async (c, wh, find) => {
    const b = find(req.params.code);
    if (!b.product_id) throw new HttpError(409, 'That bin is empty. Use "Put stock here" instead.');
    await D.applyBin(c, req.who, b, int(req.body.qty, 0, wh.bin_capacity, 'Counted quantity'), b.product_id, 'count', null, str(req.body.note, 200, 'Note', false));
  });
  res.json({ ok: true });
}));
router.post('/bins/:code/put', h(async (req, res) => {
  await withBins(req, async (c, wh, find) => {
    const b = find(req.params.code);
    if (b.qty > 0) throw new HttpError(409, 'That bin already holds stock.');
    const p = (await c.query('SELECT id FROM products WHERE id=$1 AND company_id=$2', [id(req.body.productId), req.user.company_id])).rows[0];
    if (!p) throw new HttpError(400, 'Choose a product.');
    await D.applyBin(c, req.who, b, int(req.body.qty, 1, wh.bin_capacity, 'Quantity'), p.id, 'put', null, str(req.body.note, 200, 'Note', false));
  });
  res.json({ ok: true });
}));
router.post('/bins/:code/move', h(async (req, res) => {
  await withBins(req, async (c, wh, find) => {
    const from = find(req.params.code), to = find(req.body.to);
    if (!from.qty) throw new HttpError(409, 'There is nothing in that bin to move.');
    if (to.qty) throw new HttpError(409, `Bin ${to.code} is not empty.`);
    const pid = from.product_id, qty = from.qty;
    await D.applyBin(c, req.who, from, 0, pid, 'move out', null, 'To ' + to.code);
    await D.applyBin(c, req.who, to, qty, pid, 'move in', null, 'From ' + from.code);
  });
  res.json({ ok: true });
}));

/* ---------- warehouse layout ---------- */
router.put('/warehouse', need('admin'), h(async (req, res) => {
  const b = req.body, name = str(b.name, 80, 'Warehouse name');
  const aisles = int(b.aisles, 1, 8, 'Aisles'), bays = int(b.bays, 1, 20, 'Bays'), levels = int(b.levels, 1, 5, 'Levels'), cap = int(b.binCapacity, 1, 10000, 'Bin capacity');
  await tx(async c => {
    const wh = await D.getWarehouse(c, req.user.company_id), bins = await D.lockBins(c, wh.id);
    const cut = bins.filter(x => x.aisle > aisles || x.bay > bays || x.level > levels);
    const full = cut.filter(x => x.qty > 0);
    if (full.length) throw new HttpError(409, `Move or empty these bins first, they would be removed: ${full.slice(0, 8).map(x => x.code).join(', ')}${full.length > 8 ? ` and ${full.length - 8} more` : ''}.`);
    const over = bins.filter(x => x.qty > cap);
    if (over.length) throw new HttpError(409, `Bin ${over[0].code} holds ${over[0].qty} units, more than the new capacity.`);
    if (cut.length) await c.query('DELETE FROM bins WHERE id = ANY($1)', [cut.map(x => x.id)]);
    await c.query('UPDATE warehouses SET name=$2, aisles=$3, bays=$4, levels=$5, bin_capacity=$6 WHERE id=$1', [wh.id, name, aisles, bays, levels, cap]);
    await D.createBins(c, { id: wh.id, aisles, bays, levels });
  });
  res.json({ ok: true });
}));

/* ---------- orders ---------- */
router.post('/orders', need('manager'), h(async (req, res) => {
  const b = req.body, type = oneOf(b.type, ['out', 'in'], 'Type');
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 50) throw new HttpError(400, 'Add between 1 and 50 lines to the order.');
  const lines = b.lines.map(l => ({ productId: id(l.productId), qty: int(l.qty, 1, 100000, 'Quantity') }));
  const o = await tx(c => D.createOrder(c, req.who, { type, partnerId: id(b.partnerId), courier: str(b.courier, 60, 'Courier', false), notes: str(b.notes, 500, 'Notes', false), lines }));
  res.status(201).json({ id: o.id, ref: o.ref });
}));
router.post('/orders/:id/pick', h(async (req, res) => { res.json({ bins: await tx(c => D.pickOrder(c, req.who, id(req.params.id))) }); }));
router.post('/orders/:id/dispatch', h(async (req, res) => { res.json({ invoiceNo: await tx(c => D.dispatchOrder(c, req.who, id(req.params.id), str(req.body.waybill, 60, 'Waybill', false))) }); }));
router.post('/orders/:id/receive', h(async (req, res) => { res.json({ bins: await tx(c => D.receiveOrder(c, req.who, id(req.params.id))) }); }));
router.post('/orders/:id/cancel', need('manager'), h(async (req, res) => {
  await tx(c => D.cancelOrder(c, req.who, id(req.params.id)));
  res.json({ ok: true });
}));

/* ---------- company and users (admin) ---------- */
router.patch('/company', need('admin'), h(async (req, res) => {
  const b = req.body, rate = Number(b.vatRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 30) throw new HttpError(400, 'VAT rate must be between 0 and 30.');
  await q('UPDATE companies SET name=$2, vat_number=$3, reg_number=$4, address=$5, phone=$6, email=$7, bank_details=$8, vat_rate=$9 WHERE id=$1',
    [req.user.company_id, str(b.name, 120, 'Company name'), str(b.vatNumber, 20, 'VAT number', false), str(b.regNumber, 30, 'Registration number', false), str(b.address, 300, 'Address', false),
      str(b.phone, 30, 'Phone', false), str(b.email, 200, 'Email', false), str(b.bankDetails, 300, 'Bank details', false), rate]);
  res.json({ ok: true });
}));
router.get('/users', need('admin'), h(async (req, res) => {
  res.json((await q('SELECT id, name, email, role, active, created_at FROM users WHERE company_id=$1 ORDER BY name', [req.user.company_id])).rows);
}));
router.post('/users', need('admin'), h(async (req, res) => {
  const b = req.body, email = str(b.email, 200, 'Email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (typeof b.password !== 'string' || b.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const r = await q('INSERT INTO users(company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING RETURNING id',
    [req.user.company_id, str(b.name, 120, 'Name'), email, await bcrypt.hash(b.password, 11), oneOf(b.role, ['admin', 'manager', 'picker'], 'Role')]);
  if (!r.rows[0]) throw new HttpError(409, 'That email already has an account.');
  res.status(201).json({ id: r.rows[0].id });
}));
router.patch('/users/:id', need('admin'), h(async (req, res) => {
  const uid = id(req.params.id), b = req.body, role = oneOf(b.role, ['admin', 'manager', 'picker'], 'Role'), active = b.active !== false;
  if (uid === req.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'You cannot remove your own admin access.');
  // Check everything before changing anything, so a bad password does not half-apply the update.
  if (b.password !== undefined && b.password !== '' && (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200)) throw new HttpError(400, 'Password must be at least 8 characters.');
  const hash = b.password ? await bcrypt.hash(b.password, 11) : null;
  const r = await q('UPDATE users SET role=$3, active=$4, password_hash=COALESCE($5, password_hash) WHERE id=$1 AND company_id=$2 RETURNING id', [uid, req.user.company_id, role, active, hash]);
  if (!r.rows[0]) throw new HttpError(404, 'User not found.');
  res.json({ ok: true });
}));

module.exports = router;
