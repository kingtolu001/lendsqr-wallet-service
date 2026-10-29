import { readdir, readFile } from 'node:fs/promises';
import { pool, transaction } from './db.js';
export async function migrate() {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(81739214)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
      await client.query(await readFile(`migrations/${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => console.log('Migrations applied'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
