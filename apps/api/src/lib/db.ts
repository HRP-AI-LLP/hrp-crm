/**
 * Tenant-scoped Postgres access.
 *
 * Every query that touches tenant data runs inside `tx(scope, fn)`, which opens a transaction and
 * sets app.tenant_id / app.user_id with set_config(..., is_local => true). The settings vanish at
 * COMMIT/ROLLBACK, so a pooled connection (Hyperdrive, Neon pooler, PgBouncer transaction mode)
 * can never carry a tenant context into another request. RLS in Postgres enforces isolation; the
 * data layer additionally filters by tenant_id explicitly (defence in depth).
 *
 * Hyperdrive must be configured with caching DISABLED: its query cache keys on SQL text +
 * parameters and is not aware of session settings, which could serve one tenant's cached rows to
 * another tenant issuing an identical query.
 */
import pg from 'pg';
import type { Env } from '../env';

export interface TxScope {
  tenantId: string;
  userId?: string | null;
  requestId?: string | null;
  readOnly?: boolean;
}

export interface Tx {
  query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  scope: TxScope;
}

export class Db {
  private client: pg.Client | null = null;
  private connecting: Promise<pg.Client> | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly connectionString: string) {}

  static fromEnv(env: Env): Db {
    const cs = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!cs) throw new Error('No database configured: bind HYPERDRIVE or set DATABASE_URL');
    return new Db(cs);
  }

  private async conn(): Promise<pg.Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = new pg.Client({ connectionString: this.connectionString, statement_timeout: 15_000 } as pg.ClientConfig);
        await c.connect();
        this.client = c;
        return c;
      })();
    }
    return this.connecting;
  }

  /** Runs `fn` in a transaction with tenant context. Serialised per Db instance. */
  async tx<T>(scope: TxScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async () => {
      const c = await this.conn();
      await c.query(scope.readOnly ? 'begin read only' : 'begin');
      try {
        await c.query(
          `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.request_id', $3, true)`,
          [scope.tenantId, scope.userId ?? '', scope.requestId ?? ''],
        );
        const tx: Tx = {
          scope,
          query: async (sql, params) => (await c.query(sql, params as unknown[])).rows,
          one: async (sql, params) => (await c.query(sql, params as unknown[])).rows[0] ?? null,
        };
        const result = await fn(tx);
        await c.query('commit');
        return result;
      } catch (err) {
        await c.query('rollback').catch(() => undefined);
        throw err;
      }
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => undefined);
    return p;
  }

  /** Platform-level calls (SECURITY DEFINER functions) that run before a tenant is known. */
  async platform<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const run = async () => {
      const c = await this.conn();
      return (await c.query<T>(sql, params)).rows;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => undefined);
    return p;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.end().catch(() => undefined);
  }
}
