/* PDF documents: tax invoice, delivery note, pick slip and barcode labels. */
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { money } = require('./util');

const day = d => new Date(d).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: 'long', day: 'numeric' }).replace(/[^\x20-\x7e]/g, ' ');
const barcode = text => bwipjs.toBuffer({ bcid: 'code128', text: String(text), scale: 2, height: 11, includetext: false });

function open(res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: filename, Creator: 'Stapel WMS' } });
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}
const W = 515, X = 40;

function header(doc, co, title) {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text(co.name, X, 40, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  for (const l of [co.address, co.phone && 'Tel: ' + co.phone, co.email, co.vat_number && 'VAT no: ' + co.vat_number, co.reg_number && 'Reg no: ' + co.reg_number].filter(Boolean)) doc.text(l, { width: 300 });
  const bottom = doc.y;
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1d4f9c').text(title, X + 300, 40, { width: W - 300, align: 'right' });
  doc.y = Math.max(bottom, 80) + 14; doc.x = X;
  doc.moveTo(X, doc.y).lineTo(X + W, doc.y).strokeColor('#1d4f9c').lineWidth(1.5).stroke();
  doc.y += 12;
}

function twoCols(doc, leftTitle, leftLines, pairs) {
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555').text(leftTitle.toUpperCase(), X, y0);
  doc.font('Helvetica').fontSize(10).fillColor('#111');
  for (const l of leftLines.filter(Boolean)) doc.text(l, X, doc.y, { width: 250 });
  const yl = doc.y; let y = y0;
  for (const [k, v] of pairs.filter(p => p[1])) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555').text(k.toUpperCase(), X + 300, y + 1.5, { width: 90 });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(String(v), X + 390, y, { width: W - 390, align: 'right' });
    y += 15;
  }
  doc.y = Math.max(yl, y) + 16; doc.x = X;
}

function table(doc, cols, rows) {
  let y = doc.y;
  const head = () => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555'); let x = X;
    for (const c of cols) { doc.text(c.label.toUpperCase(), x + 3, y, { width: c.w - 6, align: c.align || 'left' }); x += c.w; }
    y += 14; doc.moveTo(X, y).lineTo(X + W, y).strokeColor('#888').lineWidth(0.8).stroke(); y += 6;
    doc.font('Helvetica').fontSize(10).fillColor('#111');
  };
  head();
  for (const r of rows) {
    const hgt = Math.max(...cols.map((c, i) => doc.heightOfString(String(r[i]), { width: c.w - 6 }))) + 8;
    if (y + hgt > doc.page.height - 80) { doc.addPage(); y = 40; head(); }
    let x = X;
    cols.forEach((c, i) => { doc.text(String(r[i]), x + 3, y, { width: c.w - 6, align: c.align || 'left' }); x += c.w; });
    y += hgt; doc.moveTo(X, y - 4).lineTo(X + W, y - 4).strokeColor('#ddd').lineWidth(0.5).stroke();
  }
  doc.y = y + 4; doc.x = X;
}
function room(doc, h) { if (doc.y + h > doc.page.height - 50) { doc.addPage(); doc.y = 40; } }
function footer(doc, text) { doc.font('Helvetica').fontSize(8).fillColor('#777').text(text, X, doc.page.height - 60, { width: W, align: 'center', lineBreak: false }); }

function invoice(res, o) {
  const co = o.company, vatReg = !!co.vat_number, rate = o.vat_rate;
  const doc = open(res, `${o.invoice_no}.pdf`);
  header(doc, co, vatReg ? 'TAX INVOICE' : 'INVOICE');
  twoCols(doc, 'Invoice to', [o.partner.name, o.partner.address, o.partner.city, o.partner.vat_number && 'VAT no: ' + o.partner.vat_number],
    [['Invoice no', o.invoice_no], ['Date', day(o.dispatched_at)], ['Order', o.ref], ['Courier', o.courier], ['Waybill', o.waybill]]);
  table(doc, [{ label: 'SKU', w: 70 }, { label: 'Description', w: 215 }, { label: 'Qty', w: 50, align: 'right' }, { label: 'Unit price excl.', w: 90, align: 'right' }, { label: 'Amount excl.', w: 90, align: 'right' }],
    o.lines.map(l => [l.sku, l.name, l.qty, money(l.unit_cents), money(l.qty * l.unit_cents)]));
  const sub = o.lines.reduce((s, l) => s + l.qty * l.unit_cents, 0), vat = Math.round(sub * rate / 100);
  room(doc, 130);
  let y = doc.y + 4;
  const tot = (k, v, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111').text(k, X + 300, y, { width: 110 }).text(v, X + 410, y, { width: 105, align: 'right' }); y += bold ? 20 : 16; };
  if (rate > 0) { tot('Subtotal excl. VAT', money(sub)); tot(`VAT at ${rate}%`, money(vat)); }
  doc.moveTo(X + 300, y).lineTo(X + W, y).strokeColor('#111').lineWidth(1).stroke(); y += 6;
  tot('Total due', money(sub + vat), true);
  doc.y = y + 10; doc.x = X;
  if (co.bank_details) { doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555').text('BANKING DETAILS', X); doc.font('Helvetica').fontSize(10).fillColor('#111').text(co.bank_details, { width: 300 }); }
  if (o.notes) { doc.moveDown(0.6).font('Helvetica').fontSize(9).fillColor('#444').text(o.notes, { width: W }); }
  footer(doc, `${co.name}  -  ${o.invoice_no}  -  All amounts in South African rand (ZAR)`);
  doc.end();
}

function deliveryNote(res, o) {
  const doc = open(res, `${o.ref}-delivery-note.pdf`);
  header(doc, o.company, 'DELIVERY NOTE');
  twoCols(doc, 'Deliver to', [o.partner.name, o.partner.address, o.partner.city, o.partner.phone && 'Tel: ' + o.partner.phone],
    [['Order', o.ref], ['Date', day(o.dispatched_at || o.picked_at || new Date())], ['Invoice no', o.invoice_no], ['Courier', o.courier], ['Waybill', o.waybill]]);
  table(doc, [{ label: 'SKU', w: 80 }, { label: 'Description', w: 285 }, { label: 'Qty ordered', w: 75, align: 'right' }, { label: 'Qty received', w: 75, align: 'right' }],
    o.lines.map(l => [l.sku, l.name, l.qty, '']));
  const units = o.lines.reduce((s, l) => s + l.qty, 0);
  doc.font('Helvetica-Bold').fontSize(10).text(`Total units: ${units}`, X);
  room(doc, 120); doc.moveDown(2);
  doc.font('Helvetica').fontSize(10).text('Received in good order and condition:', X); doc.moveDown(1.8);
  const y = doc.y;
  for (const [i, label] of ['Name', 'Signature', 'Date'].entries()) {
    const x = X + i * 175; doc.moveTo(x, y).lineTo(x + 155, y).strokeColor('#111').lineWidth(0.7).stroke();
    doc.fontSize(8.5).fillColor('#555').text(label, x, y + 4);
  }
  footer(doc, `${o.company.name}  -  ${o.ref}`);
  doc.end();
}

async function pickSlip(res, o, plan) {
  const doc = open(res, `${o.ref}-pick-slip.pdf`);
  header(doc, o.company, 'PICK SLIP');
  const y0 = doc.y;
  doc.image(await barcode(o.ref), X + W - 150, y0, { width: 150, height: 34 });
  twoCols(doc, 'Order', [o.ref, o.partner.name, o.partner.city, 'Courier: ' + (o.courier || 'not set')], []);
  doc.y = Math.max(doc.y, y0 + 50);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text(o.status === 'new' ? 'Suggested bins, based on stock at the time of printing. Lowest levels first.' : 'Bins this order was picked from.', X);
  doc.moveDown(0.6);
  table(doc, [{ label: 'Bin', w: 80 }, { label: 'SKU', w: 80 }, { label: 'Product', w: 235 }, { label: 'Qty', w: 60, align: 'right' }, { label: 'Picked', w: 60, align: 'right' }],
    plan.map(p => [p.bin, p.sku, p.name, p.qty, '[    ]']));
  footer(doc, `${o.company.name}  -  ${o.ref}  -  printed ${day(new Date())}`);
  doc.end();
}

async function labels(res, filename, items) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: filename, Creator: 'Stapel WMS' } });
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  const cols = 3, rows = 8, m = 24, cw = (595.28 - 2 * m) / cols, ch = (841.89 - 2 * m) / rows;
  for (let i = 0; i < items.length; i++) {
    const k = i % (cols * rows);
    if (i && k === 0) doc.addPage();
    const x = m + (k % cols) * cw, y = m + Math.floor(k / cols) * ch, it = items[i];
    doc.rect(x + 3, y + 3, cw - 6, ch - 6).strokeColor('#bbb').lineWidth(0.5).dash(2, { space: 2 }).stroke().undash();
    doc.image(await barcode(it.code), x + 16, y + 12, { width: cw - 32, height: 38 });
    doc.font('Helvetica-Bold').fontSize(it.sub ? 13 : 18).fillColor('#111').text(it.title, x + 8, y + 56, { width: cw - 16, align: 'center', lineBreak: false });
    if (it.sub) doc.font('Helvetica').fontSize(8.5).fillColor('#333').text(it.sub, x + 8, y + 74, { width: cw - 16, align: 'center', height: 12, ellipsis: true });
  }
  if (!items.length) doc.font('Helvetica').fontSize(12).text('Nothing to print yet.', 40, 40);
  doc.end();
}

module.exports = { invoice, deliveryNote, pickSlip, labels };
