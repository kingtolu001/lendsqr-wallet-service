import 'dotenv/config';
import pg from 'pg';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,
  lock_timeout: 5000,
  idle_in_transaction_session_timeout: 30000,
  query_timeout: 15000,
});
pool.on('error', (error) => console.error('Database pool error', error.message));
export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Preserve the original failure and never return an unusable session to the pool.
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
