/* Stapel WMS web app. Talks to /api; all stock rules live on the server. */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }), ZAR = cents => zar.format(cents / 100), NUM = new Intl.NumberFormat('en-ZA');
const when = d => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const RANK = { picker: 1, manager: 2, admin: 3 };

let S = null, has3d = false;
const P = new Map(), B = new Map(), PT = new Map(); let CATS = [];
const ui = { view: 'floor', tab: 'stock', q: '', selBin: null, selProd: null, selOrder: null, of: 'out', draft: [], err: {}, editPartner: null, histProd: '' };
const can = role => RANK[S.user.role] >= RANK[role];

/* ---------- api ---------- */
async function api(method, url, body) {
  const r = await fetch('/api' + url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* not json */ }
  if (r.status === 401 && !url.startsWith('/auth/')) { showAuth(); throw new Error((j && j.error) || 'Sign in to continue.'); }
  if (!r.ok) throw new Error((j && j.error) || 'Something went wrong. Try again.');
  return j;
}
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 4200); }
/** Run a change, say what happened, reload. Errors are shown, never swallowed. */
async function run(fn, done) { try { const r = await fn(); await load(); if (done) toast(typeof done === 'function' ? done(r) : done); return true; } catch (e) { toast(e.message); return false; } }
async function load() {
  S = await api('GET', '/state');
  P.clear(); B.clear(); PT.clear();
  for (const p of S.products) P.set(p.id, p); for (const b of S.bins) B.set(b.code, b); for (const p of S.partners) PT.set(p.id, p);
  CATS = [...new Set(S.products.map(p => p.category))].sort();
  render();
}

/* ---------- derived ---------- */
const bin = code => { const b = B.get(code); return b && b.qty > 0 ? b : null; };
function totals() { const t = new Map(); for (const b of S.bins) { if (!b.qty) continue; if (!t.has(b.productId)) t.set(b.productId, { qty: 0, bins: [] }); const x = t.get(b.productId); x.qty += b.qty; x.bins.push(b.code); } return t; }
const pname = id => (P.get(id) || {}).name || 'Unknown product';
const orderExcl = o => o.lines.reduce((s, l) => s + l.qty * l.unitCents, 0);
function hintBins() {
  if (ui.tab === 'orders' && ui.selOrder) {
    const o = S.orders.find(x => x.id === ui.selOrder);
    if (o) { if (o.allocs.length) return o.allocs.map(a => a.bin); const k = new Set(o.lines.map(l => l.productId)); return S.bins.filter(b => b.qty && k.has(b.productId)).map(b => b.code); }
  }
  if (ui.tab === 'stock' && ui.selProd) return S.bins.filter(b => b.qty && b.productId === ui.selProd).map(b => b.code);
  return [];
}
/** Don't wipe a form someone is typing in when fresh data arrives. */
function setHTML(el, html) { const a = document.activeElement; if (a && el.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return; el.innerHTML = html; }

/* ---------- floor view ---------- */
function render() {
  $('#wh-name').textContent = S.company.name + ' · ' + S.warehouse.name;
  $('#who').textContent = S.user.name + ' (' + S.user.role + ')';
  $$('[data-min]').forEach(el => el.hidden = !can(el.dataset.min));
  renderStats(); renderStock(); renderOrders(); renderBin(); fillSelects(); update3d();
}
function renderStats() {
  const t = totals(); let units = 0, val = 0; for (const [id, x] of t) { units += x.qty; val += x.qty * ((P.get(id) || {}).costCents || 0); }
  const used = S.bins.filter(b => b.qty).length, open = S.orders.filter(o => ['new', 'picked', 'expected'].includes(o.status)).length;
  const low = S.products.filter(p => p.active && ((t.get(p.id) || {}).qty || 0) < p.reorder).length;
  $('#stats').innerHTML = [['Units on hand', NUM.format(units)], ['Stock value (cost)', ZAR(val)], ['Bins in use', used + ' / ' + S.bins.length], ['Open orders', open], ['Low stock', low]]
    .map(s => `<div class="stat"><small>${s[0]}</small><strong>${s[1]}</strong></div>`).join('');
}
function renderStock() {
  const t = totals(), q = ui.q.trim().toLowerCase();
  const list = S.products.filter(p => !q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.barcode.toLowerCase() === q);
  $('#stock-empty').hidden = S.products.length > 0;
  setHTML($('#stock-rows'), list.map(p => {
    const x = t.get(p.id) || { qty: 0, bins: [] }, low = p.active && x.qty < p.reorder, sel = ui.selProd === p.id;
    return `<tr class="${sel ? 'sel' : ''}"><td><button class="link code" data-act="product" data-id="${p.id}" aria-expanded="${sel}">${esc(p.sku)}</button> ${low ? '<span class="pill p-low">Low</span>' : ''}${p.active ? '' : '<span class="pill p-off">Inactive</span>'}<span class="nm">${esc(p.name)}</span></td>
      <td class="num">${NUM.format(x.qty)}</td><td class="num">${ZAR(x.qty * p.costCents)}</td></tr>` + (sel ? `<tr class="sel"><td colspan="3"><div class="stack">
      <p class="muted">${esc(p.category)} · sells at ${ZAR(p.priceCents)} excl. VAT · reorder below ${NUM.format(p.reorder)} · ${x.bins.length ? 'highlighted on the floor' : 'no stock in any bin'}</p>
      <div class="chips">${x.bins.map(c => `<button class="chip code" data-act="bin" data-bin="${c}">${c} · ${bin(c).qty}</button>`).join('')}</div>
      ${can('manager') ? `<details><summary>Edit product</summary><div>
        <label>Name<input id="e-name" maxlength="120" value="${esc(p.name)}"></label>
        <div class="grid2"><label>Category<input id="e-cat" maxlength="40" list="cats" value="${esc(p.category)}"></label><label>Barcode<input id="e-barcode" maxlength="48" value="${esc(p.barcode)}"></label></div>
        <div class="grid2"><label>Cost (R)<input id="e-cost" type="number" min="0" step="0.01" value="${(p.costCents / 100).toFixed(2)}"></label><label>Selling price (R)<input id="e-price" type="number" min="0" step="0.01" value="${(p.priceCents / 100).toFixed(2)}"></label></div>
        <div class="row"><label>Reorder below<input id="e-reorder" type="number" min="0" step="1" value="${p.reorder}"></label><label class="check" style="flex:0 0 auto"><input id="e-active" type="checkbox" ${p.active ? 'checked' : ''}> Active</label><button class="btn pri" data-act="saveproduct" data-id="${p.id}">Save</button></div>
      </div></details>` : ''}
      <button class="link" data-act="prodhistory" data-id="${p.id}">See movement history</button></div></td></tr>` : '');
  }).join('') || (S.products.length ? '<tr><td colspan="3" class="muted">No product matches that search.</td></tr>' : ''));
  $('#cats').innerHTML = CATS.map(c => `<option value="${esc(c)}">`).join('');
}
const STAT = { new: ['To pick', 'p-new'], picked: ['Picked', 'p-picked'], dispatched: ['Dispatched', 'p-done'], expected: ['Expected', 'p-new'], received: ['Received', 'p-done'], cancelled: ['Cancelled', 'p-off'] };
function renderOrders() {
  $$('[data-of]').forEach(b => b.setAttribute('aria-pressed', b.dataset.of === ui.of));
  const rank = { new: 0, expected: 0, picked: 1, dispatched: 2, received: 2, cancelled: 3 };
  const list = S.orders.filter(o => o.type === ui.of).sort((a, b) => (rank[a.status] - rank[b.status]) || (new Date(b.createdAt) - new Date(a.createdAt))).slice(0, 60);
  setHTML($('#order-list'), list.map(o => {
    const st = STAT[o.status], pt = PT.get(o.partnerId) || {}, excl = orderExcl(o), doc = (n, label) => `<a class="link" target="_blank" rel="noopener" href="/api/orders/${o.id}/${n}.pdf">${label}</a>`;
    const where = o.allocs.length ? (o.type === 'out' ? 'Picked from: ' : 'Put away in: ') + o.allocs.map(a => `${a.bin} ×${a.qty}`).join(', ') : '';
    const docs = o.type === 'out' && o.status !== 'cancelled' ? [doc('pick-slip', 'Pick slip'), ...(o.status !== 'new' ? [doc('delivery-note', 'Delivery note')] : []), ...(o.invoiceNo ? [doc('invoice', 'Invoice ' + esc(o.invoiceNo))] : [])] : [];
    let action = '';
    if (o.status === 'new') action = `<button class="btn pri" data-act="pick" data-id="${o.id}">Pick stock</button>`;
    else if (o.status === 'picked') action = `<label style="flex:1 1 120px">Waybill no (optional)<input id="wb-${o.id}" maxlength="60"></label><button class="btn pri" data-act="dispatch" data-id="${o.id}">Dispatch</button>`;
    else if (o.status === 'expected') action = `<button class="btn pri" data-act="receive" data-id="${o.id}">Receive and put away</button>`;
    return `<article class="ord ${ui.selOrder === o.id ? 'sel' : ''}"><header><button class="link code" data-act="order" data-id="${o.id}">${esc(o.ref)}</button><span class="pill ${st[1]}">${st[0]}</span></header>
      <p><strong>${esc(pt.name)}</strong>${pt.city ? ' · ' + esc(pt.city) : ''}</p><p class="muted">${esc(o.courier || 'No courier set')}${o.waybill ? ' · waybill ' + esc(o.waybill) : ''} · ${when(o.createdAt)}</p>
      <ul>${o.lines.map(l => `<li>${NUM.format(l.qty)} × ${esc(pname(l.productId))} <span class="code muted">${esc((P.get(l.productId) || {}).sku)}</span></li>`).join('')}</ul>
      ${where ? `<p class="muted code">${esc(where)}</p>` : ''}${docs.length ? `<p class="docs">${docs.join('')}</p>` : ''}${ui.err[o.id] ? `<p class="err">${esc(ui.err[o.id])}</p>` : ''}
      <p>${o.type === 'out' ? `${ZAR(Math.round(excl * (1 + o.vatRate / 100)))} <span class="muted">${o.vatRate ? `incl. ${o.vatRate}% VAT` : 'no VAT charged'}</span>` : `${ZAR(excl)} <span class="muted">cost excl. VAT</span>`}</p>
      ${action || (can('manager') && ['new', 'expected'].includes(o.status)) ? `<footer class="row">${action}${can('manager') && ['new', 'expected'].includes(o.status) ? `<button class="btn" data-act="cancel" data-id="${o.id}">Cancel order</button>` : ''}</footer>` : ''}</article>`;
  }).join('') || `<p class="muted">No ${ui.of === 'out' ? 'outbound' : 'inbound'} orders yet.${can('manager') ? ' Create one below.' : ''}</p>`);
  $('#draft').innerHTML = ui.draft.length ? `<div class="chips">${ui.draft.map((l, i) => `<button class="chip" data-act="rmline" data-i="${i}" title="Remove line">${l.qty} × ${esc(pname(l.productId))} ✕</button>`).join('')}</div>` : '<p class="muted">Add at least one line.</p>';
}
function binWhere(b) { return `Aisle ${String.fromCharCode(64 + b.aisle)} · Bay ${String(b.bay).padStart(2, '0')} · Level ${b.level}${b.level === 1 ? ' (ground)' : ''}`; }
function renderBin() {
  const el = $('#p-bin'), b = ui.selBin && B.get(ui.selBin), cap = S.warehouse.binCapacity;
  if (!b) { ui.selBin = null; setHTML(el, '<h2>No bin selected</h2><p class="muted">Click any pallet position on the floor, or scan a bin label, to see what is in it, count it, or move it.</p>'); return; }
  if (b.qty > 0) {
    const p = P.get(b.productId) || { name: 'Unknown', sku: '', costCents: 0 }, empties = S.bins.filter(x => !x.qty);
    setHTML(el, `<h2><span class="code" style="font-size:18px">${b.code}</span></h2><p class="muted">${binWhere(b)}</p>
      <dl class="kv"><dt>Product</dt><dd>${esc(p.name)} <span class="code muted">${esc(p.sku)}</span></dd><dt>Quantity</dt><dd>${b.qty} of ${cap} units</dd><dt>Value</dt><dd>${ZAR(b.qty * p.costCents)}</dd></dl>
      <div class="meter"><i style="width:${Math.min(100, b.qty / cap * 100)}%"></i></div>
      <div class="row"><label>Counted quantity<input id="bin-count" type="number" min="0" max="${cap}" step="1" value="${b.qty}"></label><label>Reason (optional)<input id="bin-note" maxlength="200" placeholder="e.g. damaged, stock take"></label><button class="btn pri" data-act="count">Save count</button></div>
      <div class="row"><label>Move pallet to<select id="bin-to">${empties.map(x => `<option>${x.code}</option>`).join('')}</select></label><button class="btn" data-act="move" ${empties.length ? '' : 'disabled'}>Move</button></div>`);
  } else {
    const list = S.products.filter(p => p.active);
    setHTML(el, `<h2><span class="code" style="font-size:18px">${b.code}</span></h2><p class="muted">${binWhere(b)} · empty</p>
      ${list.length ? `<label>Product<select id="bin-prod">${list.map(p => `<option value="${p.id}">${esc(p.sku)} · ${esc(p.name)}</option>`).join('')}</select></label>
      <div class="row"><label>Quantity (max ${cap})<input id="bin-qty" type="number" min="1" max="${cap}" step="1" value="${cap}"></label><button class="btn pri" data-act="put">Put stock here</button></div>` : '<p class="muted">Add a product on the Stock tab first.</p>'}`);
  }
}
let selSig = '';
function fillSelects() {
  const type = $('#f-type').value, want = type === 'out' ? 'customer' : 'supplier';
  const sig = type + '|' + S.products.map(p => p.id + p.name + p.active).join() + '|' + S.partners.map(p => p.id + p.name).join(); if (sig === selSig) return; selSig = sig;
  $('#f-partner-label').textContent = type === 'out' ? 'Customer' : 'Supplier';
  const keep = (el, html) => { const v = el.value; el.innerHTML = html; if ([...el.options].some(o => o.value === v)) el.value = v; };
  keep($('#f-partner'), S.partners.filter(p => p.type === want).map(p => `<option value="${p.id}">${esc(p.name)}${p.city ? ' · ' + esc(p.city) : ''}</option>`).join('') || `<option value="">Add a ${want} first (Customers & suppliers)</option>`);
  keep($('#f-product'), S.products.filter(p => p.active).map(p => `<option value="${p.id}">${esc(p.sku)} · ${esc(p.name)}</option>`).join(''));
}
function update3d() {
  if (!has3d) return; FLOOR.setLayout(S.warehouse);
  const m = new Map(), cap = S.warehouse.binCapacity;
  for (const b of S.bins) if (b.qty) m.set(b.code, { fill: b.qty / cap, cat: Math.max(0, CATS.indexOf((P.get(b.productId) || {}).category)) });
  FLOOR.update(m, new Set(hintBins()), ui.selBin);
}
function showTab(t) { ui.tab = t; $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t)); for (const k of ['stock', 'orders', 'bin']) $('#p-' + k).hidden = k !== t; }
function selectBin(code) { ui.selBin = code; if (ui.view !== 'floor') showView('floor'); showTab('bin'); renderBin(); update3d(); FLOOR.flyTo(code); }
function scan(text) {
  const t = text.trim(), u = t.toUpperCase(); if (!t) return;
  if (B.has(u)) return selectBin(u);
  const o = S.orders.find(x => x.ref.toUpperCase() === u);
  if (o) { ui.of = o.type; ui.selOrder = o.id; showTab('orders'); renderOrders(); update3d(); return; }
  const p = S.products.find(x => x.barcode && x.barcode === t) || S.products.find(x => x.sku === u);
  if (p) { ui.selProd = p.id; ui.q = ''; $('#q').value = ''; showTab('stock'); renderStock(); update3d(); return; }
  toast(`Nothing matches "${t}". Check the label and scan again.`);
}

/* ---------- pages ---------- */
function showView(v) {
  if (!['floor', 'reports', 'history', 'partners', 'settings'].includes(v)) v = 'floor';
  if ((v === 'reports' || v === 'partners') && !can('manager')) v = 'floor';
  ui.view = v; for (const k of ['floor', 'reports', 'history', 'partners', 'settings']) $('#v-' + k).hidden = k !== v;
  $$('.nav button').forEach(b => b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  ({ reports: renderReports, history: renderHistory, partners: renderPartners, settings: renderSettings }[v] || (() => {}))();
}
const pageErr = (el, e) => { el.innerHTML = `<div class="wrap"><p class="err">${esc(e.message)}</p></div>`; };
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const short = c => { const r = c / 100; return 'R ' + (r >= 1e6 ? (r / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : r >= 1e3 ? (r / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(r)); };
async function renderReports() {
  const el = $('#v-reports'); let r; try { r = await api('GET', '/reports/summary'); } catch (e) { return pageErr(el, e); }
  const stockVal = r.byCategory.reduce((s, c) => s + c.valueCents, 0), W = 720, H = 230, L = 58, Bm = 28, T = 12, mx = niceMax(Math.max(...r.daily.map(d => d.cents))), bw = (W - L - 8) / r.daily.length;
  const y = v => T + (H - T - Bm) * (1 - v / mx);
  const chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dispatched sales per day for the last 14 days">
    ${[0, 0.5, 1].map(f => `<line class="grid" x1="${L}" x2="${W}" y1="${y(mx * f)}" y2="${y(mx * f)}"/><text x="${L - 8}" y="${y(mx * f) + 4}" text-anchor="end">${short(mx * f)}</text>`).join('')}
    ${r.daily.map((d, i) => { const x = L + i * bw + 4, h = Math.max(d.cents ? 2 : 0, H - Bm - y(d.cents)), dt = new Date(d.day + 'T12:00:00');
      return `<rect class="bar" x="${x}" y="${H - Bm - h}" width="${bw - 8}" height="${h}"><title>${dt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}: ${ZAR(d.cents)} from ${d.orders} order${d.orders === 1 ? '' : 's'}</title></rect><text x="${x + (bw - 8) / 2}" y="${H - 9}" text-anchor="middle">${dt.getDate()} ${i === 0 || dt.getDate() === 1 ? dt.toLocaleDateString('en-ZA', { month: 'short' }) : ''}</text>`; }).join('')}</svg>`;
  const cmax = Math.max(1, ...r.byCategory.map(c => c.valueCents));
  el.innerHTML = `<div class="wrap">
    <div class="pagehead"><h1>Reports</h1><div class="row"><a class="btn" href="/api/reports/valuation.csv">Download stock valuation (CSV)</a><a class="btn" href="/api/reports/movements.csv">Download movements (CSV)</a></div></div>
    <div class="kpis">${[['Sales, last 30 days (excl. VAT)', ZAR(r.kpi.sales30Cents)], ['Stock value at cost', ZAR(stockVal)], ['Outbound orders open', r.kpi.openOut], ['Deliveries expected', r.kpi.openIn], ['Units received, 30 days', NUM.format(r.kpi.received30)]].map(k => `<div class="stat"><small>${k[0]}</small><strong>${k[1]}</strong></div>`).join('')}</div>
    <div class="card"><h2>Dispatched sales per day</h2><p class="muted">Last 14 days, excluding VAT. Hover a bar for the figure.</p>${chart}</div>
    <div class="cols">
      <div class="card"><h2>Stock value by category</h2>${r.byCategory.map(c => `<div class="hbar"><span>${esc(c.category)}</span><div class="meter"><i style="width:${c.valueCents / cmax * 100}%"></i></div><span class="num">${ZAR(c.valueCents)}</span></div>`).join('') || '<p class="muted">No stock on hand.</p>'}</div>
      <div class="card"><h2>Low stock</h2>${r.lowStock.length ? `<div class="tblwrap"><table><thead><tr><th>Product</th><th class="num">On hand</th><th class="num">Reorder below</th></tr></thead><tbody>${r.lowStock.map(p => `<tr><td><span class="code">${esc(p.sku)}</span> ${esc(p.name)}</td><td class="num neg">${NUM.format(p.onHand)}</td><td class="num">${NUM.format(p.reorder)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Every product is above its reorder level.</p>'}</div>
      <div class="card"><h2>Best sellers, last 30 days</h2>${r.top.length ? `<div class="tblwrap"><table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Sales excl.</th></tr></thead><tbody>${r.top.map(p => `<tr><td><span class="code">${esc(p.sku)}</span> ${esc(p.name)}</td><td class="num">${NUM.format(p.units)}</td><td class="num">${ZAR(p.cents)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing dispatched in the last 30 days.</p>'}</div>
    </div></div>`;
}
async function renderHistory() {
  const el = $('#v-history'); let rows; try { rows = await api('GET', '/movements' + (ui.histProd ? '?productId=' + ui.histProd : '')); } catch (e) { return pageErr(el, e); }
  el.innerHTML = `<div class="wrap"><div class="pagehead"><div><h1>Stock history</h1><p class="muted">Every change to a bin: who, when and why. Latest 300.</p></div>
    <label style="min-width:240px">Product<select id="h-prod"><option value="">All products</option>${S.products.map(p => `<option value="${p.id}" ${String(p.id) === String(ui.histProd) ? 'selected' : ''}>${esc(p.sku)} · ${esc(p.name)}</option>`).join('')}</select></label></div>
    <div class="card"><div class="tblwrap"><table><thead><tr><th>When</th><th>Bin</th><th>Product</th><th class="num">Change</th><th class="num">Bin after</th><th>Reason</th><th>Order</th><th>By</th></tr></thead><tbody>
    ${rows.map(m => `<tr><td style="white-space:nowrap">${when(m.at)}</td><td><button class="link code" data-act="bin" data-bin="${esc(m.bin)}">${esc(m.bin)}</button></td><td><span class="code">${esc(m.sku)}</span> ${esc(m.product)}</td>
      <td class="num ${m.delta > 0 ? 'pos' : 'neg'}">${m.delta > 0 ? '+' : ''}${NUM.format(m.delta)}</td><td class="num">${NUM.format(m.after)}</td><td>${esc(m.reason)}${m.note ? ` <span class="muted">· ${esc(m.note)}</span>` : ''}</td><td class="code">${esc(m.ref || '')}</td><td>${esc(m.who || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No stock movements yet.</td></tr>'}
    </tbody></table></div></div></div>`;
}
function renderPartners() {
  const el = $('#v-partners'), ed = ui.editPartner && PT.get(ui.editPartner);
  const tbl = type => { const list = S.partners.filter(p => p.type === type);
    return list.length ? `<div class="tblwrap"><table><thead><tr><th>Name</th><th>Town</th><th>VAT no</th><th></th></tr></thead><tbody>${list.map(p => `<tr><td>${esc(p.name)}${p.phone ? `<span class="nm muted">${esc(p.phone)}</span>` : ''}</td><td>${esc(p.city)}</td><td class="code">${esc(p.vatNumber)}</td><td class="num"><button class="btn sm" data-act="editpartner" data-id="${p.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">No ${type}s yet.</p>`; };
  el.innerHTML = `<div class="wrap"><h1>Customers &amp; suppliers</h1><div class="cols">
    <div class="card"><h2>Customers</h2>${tbl('customer')}</div><div class="card"><h2>Suppliers</h2>${tbl('supplier')}</div>
    <div class="card"><h2>${ed ? 'Edit ' + esc(ed.name) : 'Add a customer or supplier'}</h2>
      <label>Type<select id="pt-type" ${ed ? 'disabled' : ''}><option value="customer">Customer</option><option value="supplier" ${ed && ed.type === 'supplier' ? 'selected' : ''}>Supplier</option></select></label>
      <label>Name<input id="pt-name" maxlength="120" value="${esc(ed && ed.name)}"></label>
      <div class="grid2"><label>VAT number<input id="pt-vat" maxlength="20" value="${esc(ed && ed.vatNumber)}"></label><label>Town or city<input id="pt-city" maxlength="80" value="${esc(ed && ed.city)}"></label></div>
      <label>Address (printed on invoices and delivery notes)<input id="pt-address" maxlength="300" value="${esc(ed && ed.address)}"></label>
      <div class="grid2"><label>Phone<input id="pt-phone" maxlength="30" value="${esc(ed && ed.phone)}"></label><label>Email<input id="pt-email" type="email" maxlength="200" value="${esc(ed && ed.email)}"></label></div>
      <div class="row"><button class="btn pri" data-act="savepartner">${ed ? 'Save changes' : 'Add'}</button>${ed ? '<button class="btn" data-act="editpartner" data-id="">Stop editing</button>' : ''}</div></div>
  </div></div>`;
}
async function renderSettings() {
  const el = $('#v-settings'), c = S.company, w = S.warehouse, admin = can('admin'); let users = [];
  if (admin) { try { users = await api('GET', '/users'); } catch (e) { return pageErr(el, e); } }
  el.innerHTML = `<div class="wrap"><h1>Settings</h1><div class="cols">
    ${admin ? `<div class="card"><h2>Company details</h2><p class="muted">Printed on invoices and delivery notes. VAT is only charged on new orders when a VAT number is filled in.</p>
      <label>Company name<input id="c-name" maxlength="120" value="${esc(c.name)}"></label>
      <div class="grid2"><label>VAT number<input id="c-vat" maxlength="20" value="${esc(c.vatNumber)}"></label><label>VAT rate (%)<input id="c-rate" type="number" min="0" max="30" step="0.5" value="${c.vatRate}"></label></div>
      <label>Company registration number<input id="c-reg" maxlength="30" value="${esc(c.regNumber)}"></label>
      <label>Address<input id="c-address" maxlength="300" value="${esc(c.address)}"></label>
      <div class="grid2"><label>Phone<input id="c-phone" maxlength="30" value="${esc(c.phone)}"></label><label>Email<input id="c-email" maxlength="200" value="${esc(c.email)}"></label></div>
      <label>Banking details (printed on invoices)<input id="c-bank" maxlength="300" value="${esc(c.bankDetails)}"></label>
      <button class="btn pri" data-act="savecompany" style="align-self:flex-start">Save company</button></div>
    <div class="card"><h2>Warehouse layout</h2><p class="muted">The 3D floor rebuilds to match. Bins that would be removed must be empty first.</p>
      <label>Warehouse name<input id="w-name" maxlength="80" value="${esc(w.name)}"></label>
      <div class="grid2"><label>Aisles (1 to 8)<input id="w-aisles" type="number" min="1" max="8" value="${w.aisles}"></label><label>Bays per aisle (1 to 20)<input id="w-bays" type="number" min="1" max="20" value="${w.bays}"></label></div>
      <div class="grid2"><label>Levels (1 to 5)<input id="w-levels" type="number" min="1" max="5" value="${w.levels}"></label><label>Units per bin<input id="w-cap" type="number" min="1" max="10000" value="${w.binCapacity}"></label></div>
      <button class="btn pri" data-act="savelayout" style="align-self:flex-start">Save layout</button></div>` : ''}
    <div class="card"><h2>Barcode labels</h2><p class="muted">Code 128 labels on A4, 24 to a page. A USB or Bluetooth scanner types straight into the scan box on the Floor screen.</p>
      <div class="row"><a class="btn" target="_blank" rel="noopener" href="/api/labels/bins.pdf">Print bin labels</a><a class="btn" target="_blank" rel="noopener" href="/api/labels/products.pdf">Print product labels</a></div></div>
    <div class="card"><h2>Your password</h2>
      <label>Current password<input id="pw-cur" type="password" autocomplete="current-password"></label><label>New password (8 characters or more)<input id="pw-new" type="password" autocomplete="new-password"></label>
      <button class="btn" data-act="savepassword" style="align-self:flex-start">Change password</button></div>
  </div>
  ${admin ? `<div class="card"><h2>People</h2><p class="muted">Admins manage everything. Managers handle products, orders, customers and reports. Pickers pick, dispatch, receive and count.</p>
    <div class="tblwrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><select id="u-role-${u.id}" aria-label="Role for ${esc(u.name)}">${['admin', 'manager', 'picker'].map(r => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td><input id="u-act-${u.id}" type="checkbox" aria-label="${esc(u.name)} is active" style="width:auto" ${u.active ? 'checked' : ''}></td><td class="num"><button class="btn sm" data-act="saveuser" data-id="${u.id}">Save</button></td></tr>`).join('')}</tbody></table></div>
    <h3>Add a person</h3><div class="row"><label>Name<input id="u-name" maxlength="120"></label><label>Email<input id="u-email" type="email" maxlength="200"></label><label>Temporary password<input id="u-pass" type="text" minlength="8" autocomplete="off"></label>
      <label style="flex:0 1 130px">Role<select id="u-role"><option>picker</option><option>manager</option><option>admin</option></select></label><button class="btn pri" data-act="adduser">Add</button></div></div>` : ''}
  </div>`;
}

/* ---------- actions ---------- */
const val = id => { const el = $('#' + id); return el ? el.value : ''; };
const orderAct = (id, verb, body, done) => async () => {
  delete ui.err[id]; ui.selOrder = id;
  try { const r = await api('POST', `/orders/${id}/${verb}`, body); await load(); toast(done(r)); } catch (e) { ui.err[id] = e.message; renderOrders(); update3d(); }
};
const ACT = {
  logout: async () => { try { await api('POST', '/auth/logout', {}); } catch (e) { /* ignore */ } S = null; showAuth(); },
  product: d => { ui.selProd = ui.selProd === +d.id ? null : +d.id; renderStock(); update3d(); },
  bin: d => selectBin(d.bin),
  order: d => { ui.selOrder = ui.selOrder === +d.id ? null : +d.id; renderOrders(); update3d(); },
  prodhistory: d => { ui.histProd = d.id; showView('history'); },
  pick: d => orderAct(+d.id, 'pick', {}, r => `Picked from ${r.bins} bin${r.bins === 1 ? '' : 's'}`)(),
  dispatch: d => orderAct(+d.id, 'dispatch', { waybill: val('wb-' + d.id) }, r => `Dispatched. Invoice ${r.invoiceNo} is ready to print.`)(),
  receive: d => orderAct(+d.id, 'receive', {}, r => `Received into ${r.bins} bin${r.bins === 1 ? '' : 's'}`)(),
  cancel: d => run(() => api('POST', `/orders/${d.id}/cancel`, {}), 'Order cancelled'),
  addline: () => { const productId = +val('f-product'), qty = Math.round(+val('f-qty')); if (!productId || !(qty > 0)) return toast('Choose a product and a quantity above zero.'); ui.draft.push({ productId, qty }); renderOrders(); },
  rmline: d => { ui.draft.splice(+d.i, 1); renderOrders(); },
  createorder: async () => {
    if (!val('f-partner')) return toast('Add a customer or supplier first.'); if (!ui.draft.length) return toast('Add at least one line to the order.');
    const type = val('f-type');
    try { const r = await api('POST', '/orders', { type, partnerId: +val('f-partner'), courier: val('f-courier'), notes: val('f-notes'), lines: ui.draft }); ui.draft = []; ui.of = type; ui.selOrder = r.id; $('#f-notes').value = ''; await load(); toast(r.ref + ' created'); } catch (e) { toast(e.message); }
  },
  addproduct: async () => { if (await run(() => api('POST', '/products', { sku: val('s-sku'), name: val('s-name'), category: val('s-cat'), barcode: val('s-barcode'), cost: +val('s-cost') || 0, price: +val('s-price') || 0, reorder: Math.round(+val('s-reorder') || 0) }), 'Product added')) for (const k of ['s-sku', 's-name', 's-barcode', 's-cost', 's-price']) $('#' + k).value = ''; },
  saveproduct: async d => { const body = { name: val('e-name'), category: val('e-cat'), barcode: val('e-barcode'), cost: +val('e-cost'), price: +val('e-price'), reorder: Math.round(+val('e-reorder')), active: $('#e-active').checked }; document.activeElement.blur(); await run(() => api('PATCH', '/products/' + d.id, body), 'Product saved'); },
  count: () => { const code = ui.selBin, qty = Math.round(+val('bin-count')), note = val('bin-note'); return run(() => api('POST', `/bins/${code}/count`, { qty, note }), `${code} count saved: ${qty}`); },
  move: () => { const from = ui.selBin, to = val('bin-to'); return run(async () => { await api('POST', `/bins/${from}/move`, { to }); ui.selBin = to; }, `Moved ${from} to ${to}`); },
  put: () => { const code = ui.selBin, body = { productId: +val('bin-prod'), qty: Math.round(+val('bin-qty')) }; return run(() => api('POST', `/bins/${code}/put`, body), `Stock put in ${code}`); },
  editpartner: d => { ui.editPartner = +d.id || null; renderPartners(); },
  savepartner: async () => {
    const body = { type: val('pt-type'), name: val('pt-name'), vatNumber: val('pt-vat'), city: val('pt-city'), address: val('pt-address'), phone: val('pt-phone'), email: val('pt-email') }, id = ui.editPartner;
    if (await run(() => id ? api('PATCH', '/partners/' + id, body) : api('POST', '/partners', body), id ? 'Saved' : 'Added')) { ui.editPartner = null; renderPartners(); }
  },
  savecompany: async () => { if (await run(() => api('PATCH', '/company', { name: val('c-name'), vatNumber: val('c-vat'), vatRate: +val('c-rate'), regNumber: val('c-reg'), address: val('c-address'), phone: val('c-phone'), email: val('c-email'), bankDetails: val('c-bank') }), 'Company details saved')) renderSettings(); },
  savelayout: async () => { if (await run(() => api('PUT', '/warehouse', { name: val('w-name'), aisles: +val('w-aisles'), bays: +val('w-bays'), levels: +val('w-levels'), binCapacity: +val('w-cap') }), 'Layout saved. The floor has been rebuilt.')) renderSettings(); },
  saveuser: async d => { if (await run(() => api('PATCH', '/users/' + d.id, { role: val('u-role-' + d.id), active: $('#u-act-' + d.id).checked }), 'Saved')) renderSettings(); },
  adduser: async () => { if (await run(() => api('POST', '/users', { name: val('u-name'), email: val('u-email'), password: val('u-pass'), role: val('u-role') }), 'Person added. Give them their email and temporary password.')) renderSettings(); },
  savepassword: async () => { try { await api('POST', '/auth/password', { current: val('pw-cur'), next: val('pw-new') }); $('#pw-cur').value = $('#pw-new').value = ''; toast('Password changed'); } catch (e) { toast(e.message); } },
};

/* ---------- sign in ---------- */
function showAuth() { $('#app').hidden = true; $('#auth').hidden = false; }
function authMode(m) { $$('[data-auth]').forEach(b => b.setAttribute('aria-pressed', b.dataset.auth === m)); $('#f-login').hidden = m !== 'login'; $('#f-register').hidden = m !== 'register'; $('#auth-err').textContent = ''; }
async function enter() {
  await load(); $('#auth').hidden = true; $('#app').hidden = false;
  if (!enter.once) { enter.once = true; has3d = FLOOR.init($('#gl'), { onPick: selectBin, hintEl: $('#hint'), dpad: $('#dpad') }); $('#nogl').hidden = has3d; }
  showView('floor'); render();
}
function bind() {
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (a && !a.disabled) { if (a.tagName === 'BUTTON') e.preventDefault(); const f = ACT[a.dataset.act]; if (f) f(a.dataset); return; }
    const t = e.target.closest('[data-tab]'); if (t) { showTab(t.dataset.tab); update3d(); return; }
    const o = e.target.closest('[data-of]'); if (o) { ui.of = o.dataset.of; renderOrders(); return; }
    const v = e.target.closest('[data-view]'); if (v) { showView(v.dataset.view); return; }
    const m = e.target.closest('[data-auth]'); if (m) authMode(m.dataset.auth);
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'h-prod') { ui.histProd = e.target.value; renderHistory(); }
    if (e.target.id === 'f-type') { $('#f-courier').value = e.target.value === 'in' ? 'Supplier delivery' : 'The Courier Guy'; ui.draft = []; fillSelects(); renderOrders(); }
  });
  $('#q').addEventListener('input', e => { ui.q = e.target.value; renderStock(); });
  $('#f-scan').addEventListener('submit', e => { e.preventDefault(); const el = $('#scan'); scan(el.value); el.value = ''; });
  $('#m-over').onclick = () => { FLOOR.setMode('over'); $('#m-over').setAttribute('aria-pressed', true); $('#m-walk').setAttribute('aria-pressed', false); };
  $('#m-walk').onclick = () => { FLOOR.setMode('walk'); $('#m-walk').setAttribute('aria-pressed', true); $('#m-over').setAttribute('aria-pressed', false); };
  const auth = (form, url, body) => form.addEventListener('submit', async e => {
    e.preventDefault(); $('#auth-err').textContent = '';
    try { await api('POST', url, body()); await enter(); form.reset(); } catch (err) { $('#auth-err').textContent = err.message; }
  });
  auth($('#f-login'), '/auth/login', () => ({ email: val('l-email'), password: val('l-pass') }));
  auth($('#f-register'), '/auth/register', () => ({ company: val('r-company'), name: val('r-name'), email: val('r-email'), password: val('r-pass'), examples: $('#r-ex').checked }));
  // Pick up other people's changes.
  setInterval(() => { if (S && !$('#app').hidden && document.visibilityState === 'visible') load().catch(() => {}); }, 15000);
}
bind();
enter().catch(() => showAuth());
