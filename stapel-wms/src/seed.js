/* Example data for a new company that asks for it. Invented businesses; nothing here is a real customer. */
const D = require('./domain');

const PRODUCTS = [
  ['MM-10', 'Maize meal 10 kg', 'Dry goods', 89.5, 112, 120], ['RC-02', 'Rice 2 kg', 'Dry goods', 38, 48.5, 80],
  ['SG-25', 'White sugar 2.5 kg', 'Dry goods', 52, 64, 90], ['RT-80', 'Rooibos tea 80s', 'Beverages', 31.5, 42, 40],
  ['IC-200', 'Instant coffee 200 g', 'Beverages', 68, 89, 40], ['LM-6', 'Long-life milk 1 L x 6', 'Beverages', 84, 104, 60],
  ['CO-2', 'Cooking oil 2 L', 'Dry goods', 74, 92, 70], ['BB-12', 'Baked beans 410 g x 12', 'Canned', 118, 149, 50],
  ['CK-12', 'Chakalaka 410 g x 12', 'Canned', 132, 168, 40], ['PL-12', 'Pilchards 400 g x 12', 'Canned', 246, 299, 40],
  ['WP-2', 'Washing powder 2 kg', 'Household', 58, 76, 60], ['TT-18', 'Toilet tissue 18s', 'Household', 96, 124, 50],
  ['BS-12', 'Bar soap 175 g x 12', 'Household', 88, 115, 40], ['BR-4', 'Braai briquettes 4 kg', 'Fuel & braai', 44, 59, 60],
];
const PARTNERS = [
  ['customer', 'Mokoena Cash & Carry', 'Soweto, Johannesburg', '12 Vilakazi Street, Orlando West, Soweto, 1804'],
  ['customer', 'Umgeni Wholesale', 'Pinetown, Durban', '48 Josiah Gumede Road, Pinetown, 3610'],
  ['customer', 'Karoo Trading Co-op', 'Beaufort West', '7 Donkin Street, Beaufort West, 6970'],
  ['customer', 'Bosveld Superette', 'Polokwane', '31 Landdros Mare Street, Polokwane, 0699'],
  ['supplier', 'Highveld Milling', 'Randfontein', '5 Main Reef Road, Randfontein, 1759'],
  ['supplier', 'Cederberg Tea Packers', 'Clanwilliam', '2 Ou Kaapse Weg, Clanwilliam, 8135'],
];

async function seedExamples(c, who, wh) {
  let s = 20261009; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pid = {}, partner = {};
  for (const [sku, name, cat, cost, price, reorder] of PRODUCTS) {
    const r = await c.query(
      'INSERT INTO products(company_id, sku, name, category, barcode, cost_cents, price_cents, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [who.companyId, sku, name, cat, '', Math.round(cost * 100), Math.round(price * 100), reorder]);
    pid[sku] = r.rows[0].id;
  }
  for (const [type, name, city, address] of PARTNERS) {
    const r = await c.query('INSERT INTO partners(company_id, type, name, city, address) VALUES ($1,$2,$3,$4,$5) RETURNING id', [who.companyId, type, name, city, address]);
    partner[name] = r.rows[0].id;
  }
  const bins = await D.lockBins(c, wh.id), pool = PRODUCTS.map(p => p[0]).filter(x => x !== 'RT-80');
  for (const b of bins) {
    if (rnd() < 0.62) await D.applyBin(c, who, b, Math.min(wh.bin_capacity, 8 + Math.floor(rnd() * 53)), pid[pool[Math.floor(rnd() * pool.length)]], 'opening', null, 'Opening stock');
  }
  const low = bins.find(b => b.qty === 0);
  if (low) await D.applyBin(c, who, low, 14, pid['RT-80'], 'opening', null, 'Opening stock');

  const mk = (type, name, courier, lines) => D.createOrder(c, who, { type, partnerId: partner[name], courier, notes: '', lines: lines.map(([sku, qty]) => ({ productId: pid[sku], qty })) });
  // Dispatched history across the last two weeks, so reports have something to show.
  const customers = PARTNERS.filter(p => p[0] === 'customer').map(p => p[1]), couriers = ['The Courier Guy', 'RAM', 'Aramex', 'Own truck'];
  for (let d = 12; d >= 1; d--) {
    if (rnd() < 0.25) continue;
    const a = pool[Math.floor(rnd() * pool.length)], b = pool[Math.floor(rnd() * pool.length)];
    const lines = a === b ? [[a, 6 + Math.floor(rnd() * 10)]] : [[a, 6 + Math.floor(rnd() * 10)], [b, 4 + Math.floor(rnd() * 8)]];
    const o = await mk('out', customers[d % customers.length], couriers[d % couriers.length], lines);
    try { await D.pickOrder(c, who, o.id); } catch (e) { await c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]); continue; }
    await D.dispatchOrder(c, who, o.id, 'WB' + (4400000 + o.id * 37));
    const when = `now() - interval '${d} days'`;
    await c.query(`UPDATE orders SET created_at=${when} - interval '5 hours', picked_at=${when} - interval '2 hours', dispatched_at=${when} WHERE id=$1`, [o.id]);
    await c.query(`UPDATE movements SET created_at=${when} - interval '2 hours' WHERE order_id=$1`, [o.id]);
  }
  await mk('out', 'Mokoena Cash & Carry', 'The Courier Guy', [['MM-10', 24], ['CO-2', 12], ['SG-25', 18]]);
  await mk('out', 'Umgeni Wholesale', 'RAM', [['PL-12', 10], ['BB-12', 16]]);
  const p = await mk('out', 'Karoo Trading Co-op', 'Own truck', [['BR-4', 20], ['TT-18', 12]]);
  try { await D.pickOrder(c, who, p.id); } catch (e) { /* leave it as new if stock is short */ }
  await mk('in', 'Highveld Milling', 'Supplier delivery', [['MM-10', 120]]);
  await mk('in', 'Cederberg Tea Packers', 'Supplier delivery', [['RT-80', 90]]);
}

module.exports = { seedExamples };
