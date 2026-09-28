import 'server-only';
import postgres from 'postgres';

export type Row = Record<string, unknown>;
export interface Query {
  query<T extends object = Row>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface Database { transaction<T>(fn: (tx: Query) => Promise<T>): Promise<T> }
let database: Database | undefined;
export function getDatabase(): Database {
  if (database) return database;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('SERVER_NOT_CONFIGURED');
  // Supavisor transaction mode: no prepared statements; bounded per-process pool.
  const sql = postgres(url, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  database = { transaction: async fn => {
    const result = await sql.begin(async tx => {
      await tx.unsafe('set local role service_role');
      await tx.unsafe("set local statement_timeout='10s'");
      return fn({ query: async <T extends object>(text: string, params: unknown[] = []) =>
        Array.from(await tx.unsafe(text, params as never[])) as T[] });
    });
    return result as Awaited<ReturnType<typeof fn>>;
  } };
  return database;
}
