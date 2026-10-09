# Stapel WMS

Warehouse management for South African distribution businesses. A walkable 3D warehouse floor on top of a real stock system: multi-company logins, picking, dispatch, receiving, VAT invoices, barcode labels, movement history and reports. Amounts are in rand; VAT defaults to 15%.

**Stack:** Node.js + Express, PostgreSQL, vanilla JavaScript front end with three.js (no build step).

## Run it

### Option A: Docker (database included)

```bash
docker compose up --build
```

Open http://localhost:3000 and choose **Create a company**.

### Option B: your own PostgreSQL

```bash
createdb stapel                      # or create a database on your host
cp .env.example .env                 # then set DATABASE_URL and JWT_SECRET
npm install
npm start
```

The server creates its tables at start-up (`db/schema.sql`, safe to re-run). `npm run dev` restarts on file changes.

### Test

```bash
DATABASE_URL=postgres://... npm test
```

Runs an end-to-end check against a real database: register, company isolation, pick, dispatch, documents, receive, bin moves, layout change, roles, reports. Use a disposable database; it creates test companies.

## What it does

| Area | Details |
| --- | --- |
| Companies and logins | Each company has its own warehouse, products, partners, orders and users. Every query is scoped to the signed-in user's company. |
| Roles | **Admin**: everything, including people, company details and layout. **Manager**: products, orders, customers and suppliers, reports. **Picker**: pick, dispatch, receive, count, move. |
| 3D floor | Racks are built from the warehouse layout. Overview or walk mode, click a pallet position to open its bin. Selecting a product or order highlights its bins. |
| Stock | Products with cost, selling price, reorder level and barcode. Bin counts, moves and put-away. Bin capacity is enforced. |
| Outbound | Sales order, pick (lowest levels first; refuses if stock is short), dispatch with waybill number. Dispatch issues the next invoice number. |
| Inbound | Purchase order, receive and put away (tops up bins of the same product, then uses empty bins). |
| Documents | Pick slip, delivery note and invoice as PDFs. Bin and product barcode labels (Code 128, 24 per A4 page). |
| Scanning | The scan box accepts a bin code, product barcode, SKU or order number. USB and Bluetooth scanners work as keyboards. |
| History | Every bin change is recorded with user, reason, order and time. |
| Reports | Sales per day, stock value by category, low stock, best sellers. CSV exports for valuation and movements. |
| Layout editor | 1 to 8 aisles, 1 to 20 bays, 1 to 5 levels, units per bin. Bins that would be removed must be empty. |

### VAT and invoices

- Orders only carry VAT when the company has a VAT number in Settings. With a VAT number the PDF is titled "Tax Invoice" and shows the supplier and customer VAT numbers, a sequential invoice number, date, descriptions, quantities, the VAT amount and the total. Without one it is a plain "Invoice" with no VAT.
- The VAT rate is saved on each order when it is created, so changing the rate later does not alter old invoices.
- Have your accountant confirm the invoice layout meets SARS requirements for your business before you send invoices to customers.

## Project layout

```
db/schema.sql          tables and indexes
src/server.js          Express app, security headers, static files
src/auth.js            session cookie (JWT, httpOnly) and requireAuth
src/domain.js          stock rules: pick, receive, bin changes, order creation
src/seed.js            optional example data for a new company
src/pdf.js             invoice, delivery note, pick slip, labels
src/routes/auth.js     register, login, logout, change password
src/routes/api.js      state, products, partners, bins, layout, orders, users, company
src/routes/reports.js  summary, movements, CSV exports
src/routes/docs.js     PDF endpoints
public/                index.html, app.css, app.js (UI), floor.js (3D)
test/smoke.js          end-to-end test
```

All money is stored as integer cents. Every stock change runs in one database transaction with the warehouse's bins locked, so two people picking at once cannot oversell a bin.

## Deploying

Any host that runs Node and offers PostgreSQL works (Render, Railway, Fly.io, a VPS).

1. Set `DATABASE_URL`, a long random `JWT_SECRET`, and `NODE_ENV=production`. Set `PGSSL=1` if the database host requires SSL.
2. Serve it over HTTPS. In production the session cookie is marked `Secure`, so sign-in will not work over plain HTTP.
3. Start with `npm start`.

## Security notes

- Passwords are hashed with bcrypt. Sessions are httpOnly, SameSite=Lax cookies that last 7 days.
- Sign-in and registration are rate limited (30 attempts per 15 minutes per IP).
- Changes must be sent as JSON, which blocks cross-site form posts.
- Deactivating a user locks them out on their next request.

## Not built yet

- "Forgot password" by email. An admin can set a new password for a user through the API (`PATCH /api/users/:id` with `password`); there is no screen for it yet.
- Subscription billing for selling this as a SaaS (PayFast, Paystack or Stripe).
- Several warehouses per company. The schema allows it; the screens use the first one.
- Camera barcode scanning on phones. Hardware scanners work today.
- Courier bookings and tracking. Courier names are a plain list.
- Editing an order after it is created. Cancel it and create a new one.
- Batch numbers, expiry dates and serial numbers.
