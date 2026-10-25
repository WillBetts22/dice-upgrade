import pg from 'pg';

export interface Queryable {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

// Tables are prefixed so this game can share a Postgres with Dice Market.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS fc_rooms (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  phase text NOT NULL,
  revision integer NOT NULL,
  state jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS fc_events (
  room_id text NOT NULL REFERENCES fc_rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trade','decision','info')),
  seq integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (room_id, round_number, kind, seq)
);
CREATE TABLE IF NOT EXISTS fc_reviews (
  room_id text NOT NULL REFERENCES fc_rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  player_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (room_id, round_number, player_id)
);
CREATE TABLE IF NOT EXISTS fc_receipts (
  room_id text NOT NULL REFERENCES fc_rooms(id) ON DELETE CASCADE,
  actor_key text NOT NULL,
  request_id text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (room_id, actor_key, request_id)
);
`;

export async function openDb(opts: { url?: string; pgliteDir?: string; memory?: boolean }): Promise<Db> {
  let db: Db;
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 8 });
    const run = (c: { query: pg.Pool['query'] }) => async (sql: string, params?: unknown[]) => {
      const r = await c.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    };
    db = {
      kind: 'postgres',
      query: run(pool) as Db['query'],
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: run(client as any) as Queryable['query'] });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = opts.memory || !opts.pgliteDir ? new PGlite() : new PGlite(opts.pgliteDir);
    await lite.waitReady;
    const run = (c: { query: (s: string, p?: any[]) => Promise<any> }) => async (sql: string, params?: unknown[]) => {
      const r = await c.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    };
    let chain: Promise<unknown> = Promise.resolve();
    db = {
      kind: 'pglite',
      query: run(lite) as Db['query'],
      tx(fn) {
        // PGlite has one connection; queue transactions.
        const next = chain.then(() => lite.transaction((t) => fn({ query: run(t as any) as Queryable['query'] })));
        chain = next.catch(() => {});
        return next as any;
      },
      close: () => lite.close(),
    };
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}
