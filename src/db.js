const fs = require('fs'), path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});

/** Run fn inside one transaction; rolls back on any throw. */
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
}

module.exports = { pool, tx, migrate, q: (text, params) => pool.query(text, params) };
