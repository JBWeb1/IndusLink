/* Stock rules. Every change to a bin goes through applyBin so the movement history is complete. */
const { HttpError } = require('./util');

const binCode = (a, b, l) => String.fromCharCode(64 + a) + '-' + String(b).padStart(2, '0') + '-' + l;

async function createBins(c, wh) {
  await c.query(
    `INSERT INTO bins(warehouse_id, code, aisle, bay, level)
     SELECT $1, chr(64 + a) || '-' || lpad(b::text, 2, '0') || '-' || l, a, b, l
     FROM generate_series(1, $2::int) a, generate_series(1, $3::int) b, generate_series(1, $4::int) l
     ON CONFLICT (warehouse_id, code) DO NOTHING`,
    [wh.id, wh.aisles, wh.bays, wh.levels]);
}

async function getWarehouse(c, companyId) {
  const r = await c.query('SELECT * FROM warehouses WHERE company_id=$1 ORDER BY id LIMIT 1', [companyId]);
  if (!r.rows[0]) throw new HttpError(500, 'This company has no warehouse set up.');
  return r.rows[0];
}

/** Lock every bin in the warehouse for this transaction. Ground level first, so picks favour easy reach. */
async function lockBins(c, warehouseId) {
  return (await c.query('SELECT * FROM bins WHERE warehouse_id=$1 ORDER BY level, aisle, bay FOR UPDATE', [warehouseId])).rows;
}

async function applyBin(c, who, bin, newQty, productId, reason, orderId = null, note = '') {
  const delta = newQty - bin.qty;
  const holder = newQty > 0 ? productId : null;
  await c.query('UPDATE bins SET qty=$1, product_id=$2 WHERE id=$3', [newQty, holder, bin.id]);
  if (delta !== 0) {
    await c.query(
      `INSERT INTO movements(company_id, product_id, bin_code, delta, qty_after, reason, order_id, user_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [who.companyId, productId, bin.code, delta, newQty, reason, orderId, who.userId, note]);
  }
  bin.qty = newQty; bin.product_id = holder;
}

/** Pure: which bins to take each line from. */
function planPick(lines, bins) {
  const left = new Map(bins.map(b => [b.id, b.qty])), allocs = [], short = [];
  for (const l of lines) {
    let need = l.qty;
    for (const b of bins) {
      if (!need) break;
      const have = left.get(b.id);
      if (b.product_id !== l.product_id || !have) continue;
      const t = Math.min(need, have);
      left.set(b.id, have - t); allocs.push({ bin: b, product_id: l.product_id, qty: t }); need -= t;
    }
    if (need) short.push({ product_id: l.product_id, qty: need });
  }
  return { allocs, short };
}

/** Pure: where to put each received line. Tops up bins holding the same product, then uses empty bins. */
function planPut(lines, bins, cap) {
  const st = new Map(bins.map(b => [b.id, { qty: b.qty, pid: b.product_id }])), allocs = [], short = [];
  for (const l of lines) {
    let left = l.qty;
    for (const pass of [0, 1]) {
      for (const b of bins) {
        if (!left) break;
        const s = st.get(b.id);
        const ok = pass === 0 ? (s.qty > 0 && s.pid === l.product_id && s.qty < cap) : s.qty === 0;
        if (!ok) continue;
        const t = Math.min(left, cap - s.qty);
        s.qty += t; s.pid = l.product_id; allocs.push({ bin: b, product_id: l.product_id, qty: t }); left -= t;
      }
    }
    if (left) short.push({ product_id: l.product_id, qty: left });
  }
  return { allocs, short };
}

async function describeShort(c, short) {
  const r = await c.query('SELECT id, name FROM products WHERE id = ANY($1)', [short.map(s => s.product_id)]);
  const nm = new Map(r.rows.map(x => [x.id, x.name]));
  return short.map(s => `${s.qty} x ${nm.get(s.product_id)}`).join(', ');
}

async function lockOrder(c, companyId, id, type) {
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found.');
  if (type && o.type !== type) throw new HttpError(400, `That action is only for ${type === 'out' ? 'outbound' : 'inbound'} orders.`);
  o.lines = (await c.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [id])).rows;
  return o;
}

async function saveAllocs(c, who, order, allocs, reason, sign) {
  for (const a of allocs) {
    await applyBin(c, who, a.bin, a.bin.qty + sign * a.qty, a.product_id, reason, order.id);
    await c.query('INSERT INTO order_allocations(order_id, product_id, bin_code, qty) VALUES ($1,$2,$3,$4)', [order.id, a.product_id, a.bin.code, a.qty]);
  }
}

async function pickOrder(c, who, id) {
  const o = await lockOrder(c, who.companyId, id, 'out');
  if (o.status !== 'new') throw new HttpError(409, `${o.ref} has already been picked.`);
  const wh = await getWarehouse(c, who.companyId), bins = await lockBins(c, wh.id);
  const { allocs, short } = planPick(o.lines, bins);
  if (short.length) throw new HttpError(409, `Not enough stock: short by ${await describeShort(c, short)}. Receive more or reduce the order.`);
  await saveAllocs(c, who, o, allocs, 'pick', -1);
  await c.query("UPDATE orders SET status='picked', picked_at=now() WHERE id=$1", [id]);
  return allocs.length;
}

async function dispatchOrder(c, who, id, waybill) {
  const o = await lockOrder(c, who.companyId, id, 'out');
  if (o.status !== 'picked') throw new HttpError(409, o.status === 'new' ? `Pick ${o.ref} before dispatching it.` : `${o.ref} has already been dispatched.`);
  const n = (await c.query('UPDATE companies SET next_invoice = next_invoice + 1 WHERE id=$1 RETURNING next_invoice - 1 AS n', [who.companyId])).rows[0].n;
  const invoiceNo = 'INV-' + String(n).padStart(6, '0');
  await c.query("UPDATE orders SET status='dispatched', dispatched_at=now(), waybill=$2, invoice_no=$3 WHERE id=$1", [id, waybill, invoiceNo]);
  return invoiceNo;
}

async function receiveOrder(c, who, id) {
  const o = await lockOrder(c, who.companyId, id, 'in');
  if (o.status !== 'expected') throw new HttpError(409, `${o.ref} has already been received.`);
  const wh = await getWarehouse(c, who.companyId), bins = await lockBins(c, wh.id);
  const { allocs, short } = planPut(o.lines, bins, wh.bin_capacity);
  if (short.length) throw new HttpError(409, `Not enough empty bins: no space for ${await describeShort(c, short)}.`);
  await saveAllocs(c, who, o, allocs, 'receive', +1);
  await c.query("UPDATE orders SET status='received', received_at=now() WHERE id=$1", [id]);
  return allocs.length;
}

/** Cancel an order that has not left the building. A picked order's stock goes back to the bins it came from,
    or to other bins if those have since been filled. */
async function cancelOrder(c, who, id) {
  const o = await lockOrder(c, who.companyId, id);
  if (!['new', 'expected', 'picked'].includes(o.status)) throw new HttpError(409, `${o.ref} has already been ${o.status} and cannot be cancelled.`);
  if (o.status === 'picked') {
    const wh = await getWarehouse(c, who.companyId), bins = await lockBins(c, wh.id), cap = wh.bin_capacity, rest = [];
    for (const a of (await c.query('SELECT * FROM order_allocations WHERE order_id=$1 ORDER BY id', [o.id])).rows) {
      const b = bins.find(x => x.code === a.bin_code);
      const t = b && (!b.qty || b.product_id === a.product_id) ? Math.min(a.qty, cap - b.qty) : 0;
      if (t > 0) await applyBin(c, who, b, b.qty + t, a.product_id, 'unpick', o.id, 'Order cancelled');
      if (a.qty > t) rest.push({ product_id: a.product_id, qty: a.qty - t });
    }
    const { allocs, short } = planPut(rest, bins, cap);
    if (short.length) throw new HttpError(409, `Not enough space to put the stock back: no room for ${await describeShort(c, short)}.`);
    for (const a of allocs) await applyBin(c, who, a.bin, a.bin.qty + a.qty, a.product_id, 'unpick', o.id, 'Order cancelled');
  }
  await c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
}

/** VAT is only charged when the company has a VAT number: a business that is not a registered vendor may not charge it. */
async function createOrder(c, who, { type, partnerId, courier, notes, lines }) {
  const partner = (await c.query('SELECT * FROM partners WHERE id=$1 AND company_id=$2', [partnerId, who.companyId])).rows[0];
  if (!partner) throw new HttpError(400, 'Choose a customer or supplier.');
  if (partner.type !== (type === 'out' ? 'customer' : 'supplier')) throw new HttpError(400, type === 'out' ? 'Outbound orders go to a customer.' : 'Inbound orders come from a supplier.');
  const prods = (await c.query('SELECT * FROM products WHERE company_id=$1 AND id = ANY($2)', [who.companyId, lines.map(l => l.productId)])).rows;
  const pm = new Map(prods.map(p => [p.id, p]));
  const col = type === 'out' ? 'next_so' : 'next_po';
  const co = (await c.query(`UPDATE companies SET ${col} = ${col} + 1 WHERE id=$1 RETURNING ${col} - 1 AS n, vat_rate, vat_number`, [who.companyId])).rows[0];
  const ref = type === 'out' ? 'SO-' + co.n : 'PO-' + String(co.n).padStart(4, '0');
  const o = (await c.query(
    `INSERT INTO orders(company_id, type, ref, partner_id, courier, status, notes, vat_rate, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [who.companyId, type, ref, partnerId, courier, type === 'out' ? 'new' : 'expected', notes, co.vat_number ? co.vat_rate : 0, who.userId])).rows[0];
  for (const l of lines) {
    const p = pm.get(l.productId);
    if (!p) throw new HttpError(400, 'An order line refers to a product that does not exist.');
    await c.query('INSERT INTO order_lines(order_id, product_id, qty, unit_cents) VALUES ($1,$2,$3,$4)', [o.id, p.id, l.qty, type === 'out' ? p.price_cents : p.cost_cents]);
  }
  return o;
}

module.exports = { binCode, createBins, getWarehouse, lockBins, applyBin, planPick, planPut, pickOrder, dispatchOrder, receiveOrder, cancelOrder, createOrder };
