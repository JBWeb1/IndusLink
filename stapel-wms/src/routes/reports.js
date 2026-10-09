const router = require('express').Router();
const { q } = require('../db');
const { h, csv, need } = require('../util');

const TZ = "'Africa/Johannesburg'";

router.get('/reports/summary', need('manager'), h(async (req, res) => {
  const cid = req.user.company_id;
  const [cat, low, daily, top, kpi] = await Promise.all([
    q(`SELECT p.category, SUM(b.qty)::int AS units, SUM(b.qty::bigint * p.cost_cents)::float8 AS value_cents
       FROM bins b JOIN products p ON p.id = b.product_id WHERE p.company_id=$1 AND b.qty > 0 GROUP BY p.category ORDER BY value_cents DESC`, [cid]),
    q(`SELECT p.sku, p.name, p.reorder_level, COALESCE(SUM(b.qty),0)::int AS on_hand
       FROM products p LEFT JOIN bins b ON b.product_id = p.id WHERE p.company_id=$1 AND p.active
       GROUP BY p.id HAVING COALESCE(SUM(b.qty),0) < p.reorder_level ORDER BY (COALESCE(SUM(b.qty),0)::float / NULLIF(p.reorder_level,0)), p.sku`, [cid]),
    q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(SUM(l.qty::bigint * l.unit_cents),0)::float8 AS cents, COUNT(DISTINCT o.id)::int AS orders
       FROM generate_series((now() AT TIME ZONE ${TZ})::date - 13, (now() AT TIME ZONE ${TZ})::date, interval '1 day') d
       LEFT JOIN orders o ON o.company_id=$1 AND o.status='dispatched' AND (o.dispatched_at AT TIME ZONE ${TZ})::date = d::date
       LEFT JOIN order_lines l ON l.order_id = o.id GROUP BY d ORDER BY d`, [cid]),
    q(`SELECT p.sku, p.name, SUM(l.qty)::int AS units, SUM(l.qty::bigint * l.unit_cents)::float8 AS cents
       FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN products p ON p.id=l.product_id
       WHERE o.company_id=$1 AND o.status='dispatched' AND o.dispatched_at > now() - interval '30 days' GROUP BY p.id ORDER BY units DESC LIMIT 8`, [cid]),
    q(`SELECT
        (SELECT COUNT(*) FROM orders WHERE company_id=$1 AND status IN ('new','picked'))::int AS open_out,
        (SELECT COUNT(*) FROM orders WHERE company_id=$1 AND status='expected')::int AS open_in,
        (SELECT COALESCE(SUM(l.qty::bigint * l.unit_cents),0) FROM orders o JOIN order_lines l ON l.order_id=o.id
           WHERE o.company_id=$1 AND o.status='dispatched' AND o.dispatched_at > now() - interval '30 days')::float8 AS sales30,
        (SELECT COALESCE(SUM(delta),0) FROM movements WHERE company_id=$1 AND reason='receive' AND created_at > now() - interval '30 days')::int AS received30`, [cid]),
  ]);
  res.json({
    byCategory: cat.rows.map(r => ({ category: r.category, units: r.units, valueCents: r.value_cents })),
    lowStock: low.rows.map(r => ({ sku: r.sku, name: r.name, reorder: r.reorder_level, onHand: r.on_hand })),
    daily: daily.rows.map(r => ({ day: r.day, cents: r.cents, orders: r.orders })),
    top: top.rows.map(r => ({ sku: r.sku, name: r.name, units: r.units, cents: r.cents })),
    kpi: { openOut: kpi.rows[0].open_out, openIn: kpi.rows[0].open_in, sales30Cents: kpi.rows[0].sales30, received30: kpi.rows[0].received30 },
  });
}));

const MOVES = `SELECT m.created_at, m.bin_code, m.delta, m.qty_after, m.reason, m.note, p.sku, p.name AS product, u.name AS who, o.ref
  FROM movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN orders o ON o.id = m.order_id
  WHERE m.company_id = $1 AND ($2::int IS NULL OR m.product_id = $2) ORDER BY m.created_at DESC, m.id DESC LIMIT $3`;

router.get('/movements', h(async (req, res) => {
  const pid = Number.isInteger(Number(req.query.productId)) && req.query.productId ? Number(req.query.productId) : null;
  const r = await q(MOVES, [req.user.company_id, pid, 300]);
  res.json(r.rows.map(m => ({ at: m.created_at, bin: m.bin_code, delta: m.delta, after: m.qty_after, reason: m.reason, note: m.note, sku: m.sku, product: m.product, who: m.who, ref: m.ref })));
}));

const sendCsv = (res, name, rows) => { res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send('﻿' + csv(rows)); };

router.get('/reports/movements.csv', need('manager'), h(async (req, res) => {
  const r = await q(MOVES, [req.user.company_id, null, 20000]);
  sendCsv(res, 'stock-movements.csv', [['Date', 'Bin', 'SKU', 'Product', 'Change', 'Qty after', 'Reason', 'Order', 'User', 'Note'],
    ...r.rows.map(m => [m.created_at.toISOString(), m.bin_code, m.sku, m.product, m.delta, m.qty_after, m.reason, m.ref || '', m.who || '', m.note])]);
}));
router.get('/reports/valuation.csv', need('manager'), h(async (req, res) => {
  const r = await q(`SELECT p.sku, p.name, p.category, COALESCE(SUM(b.qty),0)::int AS on_hand, p.cost_cents, p.price_cents, p.reorder_level
    FROM products p LEFT JOIN bins b ON b.product_id = p.id WHERE p.company_id=$1 GROUP BY p.id ORDER BY p.sku`, [req.user.company_id]);
  sendCsv(res, 'stock-valuation.csv', [['SKU', 'Product', 'Category', 'On hand', 'Cost (R)', 'Selling price (R)', 'Stock value at cost (R)', 'Reorder level'],
    ...r.rows.map(p => [p.sku, p.name, p.category, p.on_hand, (p.cost_cents / 100).toFixed(2), (p.price_cents / 100).toFixed(2), (p.on_hand * p.cost_cents / 100).toFixed(2), p.reorder_level])]);
}));

module.exports = router;
