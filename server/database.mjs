import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// The same schema is used locally and in PostgreSQL. No customer data is held
// only in process memory: a process restart must preserve state and sessions.
const schema = [
  `CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1), owner_hash TEXT, staff_hash TEXT,
    state_json TEXT, revision INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT INTO app_config (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'staff')), expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS mutation_receipts (
    id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
    revision INTEGER NOT NULL, expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS mutation_receipts_expiry ON mutation_receipts (expires_at)`
];

export async function openDatabase({ databaseUrl, sqlitePath, production = false }) {
  if (production && (!databaseUrl || sqlitePath)) throw new Error('Production requires DATABASE_URL and does not support SQLite.');
  if (databaseUrl && sqlitePath) throw new Error('Configure only DATABASE_URL or SQLITE_PATH.');
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    // pg opts in to SCRAM channel binding separately from the URL. TLS and
    // certificate verification still follow the supplied connection string.
    const pool = new pg.Pool({ connectionString: databaseUrl, enableChannelBinding: true, max: 10, connectionTimeoutMillis: 10000 });
    pool.on('error', () => {}); // Requests report availability without logging credentials.
    const transact = async (fn) => {
      const client = await pool.connect();
      const query = (sql, values = []) => {
        let n = 0;
        return client.query(sql.replace(/\?/g, () => `$${++n}`), values);
      };
      const tx = {
        get: async (sql, values) => (await query(sql, values)).rows[0],
        run: async (sql, values) => ({ changes: (await query(sql, values)).rowCount }),
        lockConfig: () => query('SELECT id FROM app_config WHERE id = 1 FOR UPDATE')
      };
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    };
    try { await transact(async tx => { for (const sql of schema) await tx.run(sql); }); }
    catch (error) { await pool.end(); throw error; }
    return { transact, close: () => pool.end(), kind: 'postgres' };
  }
  if (!sqlitePath) throw new Error('Set DATABASE_URL, or explicitly set SQLITE_PATH for local development.');
  const { DatabaseSync } = await import('node:sqlite');
  if (sqlitePath !== ':memory:') await mkdir(dirname(resolve(sqlitePath)), { recursive: true });
  const database = new DatabaseSync(sqlitePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  for (const sql of schema) database.exec(sql);
  // SQLite uses one connection. Serialize whole async transactions, including
  // reads, so no request can see another request's uncommitted changes.
  let tail = Promise.resolve();
  const transact = fn => {
    const result = tail.then(async () => {
      database.exec('BEGIN IMMEDIATE');
      const tx = {
        get: async (sql, values = []) => database.prepare(sql).get(...values),
        run: async (sql, values = []) => database.prepare(sql).run(...values),
        lockConfig: async () => {}
      };
      try { const value = await fn(tx); database.exec('COMMIT'); return value; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    });
    tail = result.catch(() => {});
    return result;
  };
  return { transact, close: async () => { await tail; database.close(); }, kind: 'sqlite' };
}
