-- Stapel WMS schema. Safe to run repeatedly; the server runs it at start-up.
CREATE TABLE IF NOT EXISTS companies(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  vat_number TEXT NOT NULL DEFAULT '',
  reg_number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 15,
  next_so INT NOT NULL DEFAULT 1001,
  next_po INT NOT NULL DEFAULT 1,
  next_invoice INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','picker')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS warehouses(
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aisles INT NOT NULL, bays INT NOT NULL, levels INT NOT NULL,
  bin_capacity INT NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  barcode TEXT NOT NULL DEFAULT '',
  cost_cents INT NOT NULL DEFAULT 0,
  price_cents INT NOT NULL DEFAULT 0,
  reorder_level INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(company_id, sku)
);
CREATE TABLE IF NOT EXISTS bins(
  id SERIAL PRIMARY KEY,
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  aisle INT NOT NULL, bay INT NOT NULL, level INT NOT NULL,
  product_id INT REFERENCES products(id),
  qty INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  UNIQUE(warehouse_id, code)
);
CREATE TABLE IF NOT EXISTS partners(
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('customer','supplier')),
  name TEXT NOT NULL,
  vat_number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders(
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('out','in')),
  ref TEXT NOT NULL,
  partner_id INT NOT NULL REFERENCES partners(id),
  courier TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('new','picked','dispatched','expected','received','cancelled')),
  waybill TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 15,
  invoice_no TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at TIMESTAMPTZ, dispatched_at TIMESTAMPTZ, received_at TIMESTAMPTZ,
  UNIQUE(company_id, ref)
);
CREATE TABLE IF NOT EXISTS order_lines(
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty INT NOT NULL CHECK (qty > 0),
  unit_cents INT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_allocations(
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  bin_code TEXT NOT NULL,
  qty INT NOT NULL
);
CREATE TABLE IF NOT EXISTS movements(
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  bin_code TEXT NOT NULL,
  delta INT NOT NULL,
  qty_after INT NOT NULL,
  reason TEXT NOT NULL,
  order_id INT REFERENCES orders(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_company_time ON movements(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_company_time ON orders(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bins_wh ON bins(warehouse_id);
