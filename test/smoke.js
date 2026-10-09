/* End-to-end smoke test. Needs DATABASE_URL pointing at an empty or disposable database.
   Run: npm test */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
const assert = require('assert');
const { app, migrate, pool } = require('../src/server');

(async () => {
  await migrate();
  const server = app.listen(0), base = 'http://127.0.0.1:' + server.address().port;
  const mk = () => { let cookie = ''; return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type: ct };
  }; };
  const a = mk(), b = mk(), stamp = Date.now();
  let r;
  try {
    assert.equal((await a('GET', '/api/state')).status, 401, 'state needs a login');
    r = await a('POST', '/api/auth/register', { company: 'Test Traders', name: 'Thandi', email: `a${stamp}@test.co.za`, password: 'password123', examples: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    let s = (await a('GET', '/api/state')).body;
    assert.equal(s.bins.length, 96); assert.equal(s.products.length, 14); assert.ok(s.orders.length >= 5);
    const onHand = st => st.bins.reduce((t, x) => t + x.qty, 0);

    // second company sees none of it
    await b('POST', '/api/auth/register', { company: 'Other Co', name: 'Sipho', email: `b${stamp}@test.co.za`, password: 'password123' });
    const s2 = (await b('GET', '/api/state')).body;
    assert.equal(s2.products.length, 0); assert.equal(s2.orders.length, 0);
    assert.equal((await b('POST', `/api/orders/${s.orders[0].id}/pick`, {})).status, 404, 'cannot touch another company order');
    assert.equal((await b('GET', `/api/orders/${s.orders[0].id}/pick-slip.pdf`)).status, 404);

    // VAT number, then an order: pick, dispatch, documents
    r = await a('PATCH', '/api/company', { name: 'Test Traders', vatNumber: '4123456789', address: '1 Main Road, Paarl, 7646', vatRate: 15, bankDetails: 'Bank: Example Bank, Acc: 000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cust = s.partners.find(p => p.type === 'customer'), prod = s.products.find(p => p.sku === 'MM-10');
    r = await a('POST', '/api/orders', { type: 'out', partnerId: cust.id, courier: 'RAM', lines: [{ productId: prod.id, qty: 10 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body)); const oid = r.body.id;
    const before = onHand(s);
    r = await a('GET', `/api/orders/${oid}/pick-slip.pdf`); assert.equal(r.status, 200); assert.ok(r.body.slice(0, 4).toString() === '%PDF');
    assert.equal((await a('POST', `/api/orders/${oid}/dispatch`, {})).status, 409, 'cannot dispatch before picking');
    assert.equal((await a('POST', `/api/orders/${oid}/pick`, {})).status, 200);
    assert.equal((await a('POST', `/api/orders/${oid}/pick`, {})).status, 409, 'cannot pick twice');
    s = (await a('GET', '/api/state')).body; assert.equal(onHand(s), before - 10, 'pick deducts stock');
    r = await a('POST', `/api/orders/${oid}/dispatch`, { waybill: 'WB123' }); assert.equal(r.status, 200); assert.match(r.body.invoiceNo, /^INV-\d{6}$/);
    for (const d of ['invoice', 'delivery-note', 'pick-slip']) { r = await a('GET', `/api/orders/${oid}/${d}.pdf`); assert.equal(r.status, 200, d); assert.ok(r.body.length > 1500, d); }
    s = (await a('GET', '/api/state')).body; assert.equal(s.orders.find(o => o.id === oid).vatRate, 15);

    // short stock is refused and changes nothing
    r = await a('POST', '/api/orders', { type: 'out', partnerId: cust.id, lines: [{ productId: prod.id, qty: 99999 }] });
    const big = r.body.id, b4 = onHand(s);
    r = await a('POST', `/api/orders/${big}/pick`, {}); assert.equal(r.status, 409); assert.match(r.body.error, /short by/);
    assert.equal(onHand((await a('GET', '/api/state')).body), b4);
    assert.equal((await a('POST', `/api/orders/${big}/cancel`, {})).status, 200);

    // a picked order can be cancelled, and its stock goes back on the shelves
    r = await a('POST', '/api/orders', { type: 'out', partnerId: cust.id, lines: [{ productId: prod.id, qty: 7 }] });
    const undo = r.body.id; assert.equal((await a('POST', `/api/orders/${undo}/pick`, {})).status, 200);
    assert.equal(onHand((await a('GET', '/api/state')).body), b4 - 7);
    r = await a('POST', `/api/orders/${undo}/cancel`, {}); assert.equal(r.status, 200, JSON.stringify(r.body));
    s = (await a('GET', '/api/state')).body; assert.equal(onHand(s), b4, 'cancelling a picked order returns its stock');
    assert.equal(s.orders.find(o => o.id === undo).status, 'cancelled');
    assert.ok((await a('GET', '/api/movements')).body.some(m => m.reason === 'unpick' && m.ref));
    assert.equal((await a('POST', `/api/orders/${oid}/cancel`, {})).status, 409, 'a dispatched order cannot be cancelled');

    // receive a purchase order
    const po = s.orders.find(o => o.type === 'in' && o.status === 'expected'), poUnits = po.lines.reduce((t, l) => t + l.qty, 0);
    assert.equal((await a('POST', `/api/orders/${po.id}/receive`, {})).status, 200);
    s = (await a('GET', '/api/state')).body; assert.equal(onHand(s), b4 + poUnits, 'receive adds stock');
    assert.ok(s.bins.every(x => x.qty <= s.warehouse.binCapacity));

    // bin count, move, put
    const full = s.bins.find(x => x.qty > 0), empty = s.bins.find(x => x.qty === 0);
    assert.equal((await a('POST', `/api/bins/${full.code}/count`, { qty: 5 })).status, 200);
    assert.equal((await a('POST', `/api/bins/${full.code}/move`, { to: empty.code })).status, 200);
    assert.equal((await a('POST', `/api/bins/${full.code}/put`, { productId: prod.id, qty: 7 })).status, 200);
    assert.equal((await a('POST', `/api/bins/${full.code}/count`, { qty: 9999 })).status, 400);
    s = (await a('GET', '/api/state')).body;
    assert.equal(s.bins.find(x => x.code === empty.code).qty, 5); assert.equal(s.bins.find(x => x.code === full.code).qty, 7);
    const mv = (await a('GET', '/api/movements')).body; assert.ok(mv.length > 20); assert.equal(mv[0].reason, 'put');

    // layout: growing works, shrinking over stock is refused
    assert.equal((await a('PUT', '/api/warehouse', { name: 'Main', aisles: 5, bays: 10, levels: 4, binCapacity: 60 })).status, 200);
    assert.equal((await a('GET', '/api/state')).body.bins.length, 200);
    r = await a('PUT', '/api/warehouse', { name: 'Main', aisles: 1, bays: 2, levels: 1, binCapacity: 60 }); assert.equal(r.status, 409, JSON.stringify(r.body));

    // roles
    r = await a('POST', '/api/users', { name: 'Picker Pete', email: `p${stamp}@test.co.za`, password: 'password123', role: 'picker' }); assert.equal(r.status, 201);
    const p = mk(); assert.equal((await p('POST', '/api/auth/login', { email: `p${stamp}@test.co.za`, password: 'password123' })).status, 200);
    assert.equal((await p('POST', '/api/products', { sku: 'XX-1', name: 'x' })).status, 403);
    assert.equal((await p('GET', '/api/users')).status, 403);
    assert.equal((await p('GET', '/api/reports/summary')).status, 403);
    assert.equal((await p('POST', '/api/auth/login', { email: `p${stamp}@test.co.za`, password: 'wrong-password' })).status, 401);
    // a rejected password must not half-apply the other changes
    assert.equal((await a('PATCH', `/api/users/${r.body.id}`, { role: 'admin', active: true, password: 'short' })).status, 400);
    assert.equal((await a('GET', '/api/users')).body.find(u => u.id === r.body.id).role, 'picker', 'role unchanged after a rejected update');
    await a('PATCH', `/api/users/${r.body.id}`, { role: 'picker', active: false });
    assert.equal((await p('GET', '/api/state')).status, 401, 'deactivated user is locked out at once');

    // reports, labels, csv
    r = await a('GET', '/api/reports/summary'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.daily.length, 14); assert.ok(r.body.byCategory.length > 0);
    for (const u of ['/api/labels/bins.pdf', '/api/labels/products.pdf']) { r = await a('GET', u); assert.equal(r.status, 200, u); assert.ok(r.body.length > 3000); }
    for (const u of ['/api/reports/valuation.csv', '/api/reports/movements.csv']) { r = await a('GET', u); assert.equal(r.status, 200, u); }
    // a product whose barcode has no printable characters still gets a label
    r = await a('POST', '/api/products', { sku: 'UNI-1', name: 'Unicode barcode', barcode: 'é€' }); assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await a('GET', '/api/labels/products.pdf'); assert.equal(r.status, 200, 'labels with an unprintable barcode');
    // two sign-ups with the same email at once: one wins, the other is told why
    const em = `race${stamp}@test.co.za`, reg = () => mk()('POST', '/api/auth/register', { company: 'Race', name: 'R', email: em, password: 'password123' });
    const codes = (await Promise.all([reg(), reg(), reg()])).map(x => x.status).sort();
    assert.deepEqual(codes, [201, 409, 409], 'duplicate sign-up gives 409, not 500: ' + codes);
    // form posts are refused
    const f = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a' }); assert.equal(f.status, 415);
    console.log('All smoke checks passed.');
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  server.close(); await pool.end();
})();
