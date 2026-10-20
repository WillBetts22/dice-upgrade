import pg from 'pg';

export interface Queryable {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  host_hash text NOT NULL,
  config jsonb NOT NULL,
  phase text NOT NULL,
  round_number integer NOT NULL,
  phase_deadline bigint,
  paused_remaining_ms bigint,
  revision integer NOT NULL,
  roster_frozen boolean NOT NULL,
  completed_rounds jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,
  session_hash text NOT NULL,
  is_host boolean NOT NULL,
  is_bot boolean NOT NULL,
  role text NOT NULL,
  ready boolean NOT NULL,
  deal_history jsonb NOT NULL,
  joined_at bigint NOT NULL,
  UNIQUE (room_id, name_key),
  UNIQUE (room_id, session_hash)
);
CREATE TABLE IF NOT EXISTS rounds (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  number integer NOT NULL,
  pool jsonb NOT NULL,
  deal_seed bigint NOT NULL,
  UNIQUE (room_id, number)
);
CREATE TABLE IF NOT EXISTS round_accounts (
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  cash integer NOT NULL,
  short_deductions integer NOT NULL,
  starting_upgrade text NOT NULL,
  positions jsonb NOT NULL,
  equipment jsonb NOT NULL,
  equipment_submitted boolean NOT NULL,
  revision integer NOT NULL,
  PRIMARY KEY (round_id, player_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  type text NOT NULL,
  side text NOT NULL CHECK (side IN ('bid','ask')),
  price integer NOT NULL CHECK (price BETWEEN 1 AND 50),
  original_qty integer NOT NULL CHECK (original_qty BETWEEN 1 AND 2),
  remaining integer NOT NULL CHECK (remaining >= 0 AND remaining <= original_qty),
  seq integer NOT NULL,
  status text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (round_id, seq)
);
CREATE TABLE IF NOT EXISTS trades (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  type text NOT NULL,
  buyer_id text NOT NULL,
  seller_id text NOT NULL CHECK (seller_id <> buyer_id),
  resting_order_id text NOT NULL,
  incoming_order_id text,
  price integer NOT NULL CHECK (price BETWEEN 1 AND 50),
  qty integer NOT NULL CHECK (qty > 0),
  seq integer NOT NULL,
  kind text NOT NULL,
  raised_high boolean NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (round_id, seq)
);
CREATE TABLE IF NOT EXISTS upgrade_round_state (
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  type text NOT NULL,
  last_price integer,
  high_price integer,
  volume integer NOT NULL,
  initial_supply integer NOT NULL,
  short_closeouts integer NOT NULL,
  PRIMARY KEY (round_id, type)
);
CREATE TABLE IF NOT EXISTS settlements (
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  type text NOT NULL,
  units integer NOT NULL,
  closeout_price integer NOT NULL,
  deduction integer NOT NULL,
  bank_units integer NOT NULL,
  fallback_price boolean NOT NULL,
  PRIMARY KEY (round_id, player_id, type)
);
CREATE TABLE IF NOT EXISTS dice_results (
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  equipment jsonb NOT NULL,
  resolution jsonb NOT NULL,
  trading_cash integer NOT NULL,
  short_deductions integer NOT NULL,
  score integer NOT NULL,
  PRIMARY KEY (round_id, player_id)
);
CREATE TABLE IF NOT EXISTS command_receipts (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  outcome jsonb NOT NULL,
  committed_revision integer NOT NULL,
  PRIMARY KEY (room_id, actor_id, request_id)
);
CREATE TABLE IF NOT EXISTS ledger (
  id bigserial PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_id text,
  player_id text,
  kind text NOT NULL,
  cash_delta integer NOT NULL,
  type text,
  position_delta integer NOT NULL,
  score_delta integer NOT NULL,
  ref text,
  revision integer NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_room_idx ON ledger (room_id, revision);
`;

class PgDb implements Db {
  kind = 'postgres' as const;
  constructor(private pool: pg.Pool) {}
  async query(sql: string, params?: unknown[]) {
    const r = await this.pool.query(sql, params as any[]);
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: async (sql, params) => {
          const r = await client.query(sql, params as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

class PgliteDb implements Db {
  kind = 'pglite' as const;
  constructor(private db: any) {}
  async query(sql: string, params?: unknown[]) {
    const r = await this.db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async exec(sql: string) {
    await this.db.exec(sql);
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t: any) =>
      fn({
        query: async (sql, params) => {
          const r = await t.query(sql, params);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
      }),
    );
  }
  async close() {
    await this.db.close();
  }
}

/** DATABASE_URL selects Postgres; otherwise an embedded PGlite database (dir or in-memory). */
export async function openDb(opts: { url?: string; pgliteDir?: string } = {}): Promise<Db> {
  let db: Db;
  if (opts.url) {
    const ssl = /sslmode=require/.test(opts.url) ? { rejectUnauthorized: false } : undefined;
    db = new PgDb(new pg.Pool({ connectionString: opts.url, max: 10, ssl }));
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const inst = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
    await inst.waitReady;
    db = new PgliteDb(inst);
  }
  await db.exec(SCHEMA);
  return db;
}
