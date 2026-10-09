const router = require('express').Router();
const { q } = require('../db');
const { h, int, HttpError } = require('../util');
const D = require('../domain');
const pdf = require('../pdf');

async function loadOrder(companyId, id) {
  const o = (await q('SELECT * FROM orders WHERE id=$1 AND company_id=$2', [int(id, 1, 2147483647, 'Id'), companyId])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found.');
  o.vat_rate = Number(o.vat_rate);
  o.company = (await q('SELECT * FROM companies WHERE id=$1', [companyId])).rows[0];
  o.partner = (await q('SELECT * FROM partners WHERE id=$1', [o.partner_id])).rows[0];
  o.lines = (await q('SELECT l.*, p.sku, p.name FROM order_lines l JOIN products p ON p.id=l.product_id WHERE l.order_id=$1 ORDER BY l.id', [o.id])).rows;
  return o;
}

router.get('/orders/:id/invoice.pdf', h(async (req, res) => {
  const o = await loadOrder(req.user.company_id, req.params.id);
  if (o.type !== 'out' || !o.invoice_no) throw new HttpError(409, 'The invoice is created when the order is dispatched.');
  pdf.invoice(res, o);
}));
router.get('/orders/:id/delivery-note.pdf', h(async (req, res) => {
  const o = await loadOrder(req.user.company_id, req.params.id);
  if (o.type !== 'out' || !['picked', 'dispatched'].includes(o.status)) throw new HttpError(409, 'Pick the order before printing its delivery note.');
  pdf.deliveryNote(res, o);
}));
router.get('/orders/:id/pick-slip.pdf', h(async (req, res) => {
  const o = await loadOrder(req.user.company_id, req.params.id);
  if (o.type !== 'out') throw new HttpError(400, 'Pick slips are for outbound orders.');
  const pm = new Map(o.lines.map(l => [l.product_id, l]));
  let plan;
  if (o.status === 'new') {
    const wh = await D.getWarehouse({ query: q }, req.user.company_id);
    const bins = (await q('SELECT * FROM bins WHERE warehouse_id=$1 ORDER BY level, aisle, bay', [wh.id])).rows;
    const r = D.planPick(o.lines, bins);
    plan = r.allocs.map(a => ({ bin: a.bin.code, product_id: a.product_id, qty: a.qty })).concat(r.short.map(s => ({ bin: 'SHORT', product_id: s.product_id, qty: s.qty })));
  } else {
    plan = (await q('SELECT bin_code AS bin, product_id, qty FROM order_allocations WHERE order_id=$1', [o.id])).rows;
  }
  plan = plan.map(p => ({ ...p, sku: pm.get(p.product_id).sku, name: pm.get(p.product_id).name })).sort((a, b) => a.bin.localeCompare(b.bin));
  await pdf.pickSlip(res, o, plan);
}));

router.get('/labels/bins.pdf', h(async (req, res) => {
  const wh = await D.getWarehouse({ query: q }, req.user.company_id);
  const r = await q('SELECT code FROM bins WHERE warehouse_id=$1 ORDER BY aisle, bay, level', [wh.id]);
  await pdf.labels(res, 'bin-labels.pdf', r.rows.map(b => ({ code: b.code, title: b.code })));
}));
router.get('/labels/products.pdf', h(async (req, res) => {
  const r = await q('SELECT sku, name, barcode FROM products WHERE company_id=$1 AND active ORDER BY sku', [req.user.company_id]);
  await pdf.labels(res, 'product-labels.pdf', r.rows.map(p => ({ code: p.barcode.replace(/[^\x20-\x7e]/g, '').trim() || p.sku, title: p.sku, sub: p.name })));
}));

module.exports = router;
