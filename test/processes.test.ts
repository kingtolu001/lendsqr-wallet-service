import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const admin = 'multi-process-admin-key-at-least-32-characters';
const processes = new Set<ChildProcessWithoutNullStreams>();
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
  processes.delete(child);
}
async function start() {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, ADMIN_API_KEY: admin, PORT: '0', TRUST_PROXY_HOPS: '0' },
  });
  processes.add(child);
  let output = '';
  let errors = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server startup timed out: ${errors}`));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited (${code}): ${errors}`));
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.event === 'listening') {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${event.port}`);
        }
      }
    });
  });
  return { child, url };
}
type AccountResponse = { wallet: { id: string }; api_key: string };
type TransactionResponse = { id: string };
async function post<T = TransactionResponse>(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}
before(async () => {
  if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Dedicated _test database required');
  await migrate();
});
after(async () => {
  await Promise.all([...processes].map(stop));
  await pool.end();
});

test(
  'separate server processes preserve balances, deduplicate and replay after restart',
  { timeout: 30000 },
  async () => {
    const [one, two] = await Promise.all([start(), start()]);
    const urls = [one.url, two.url];
    const alice = await post<AccountResponse>(one.url, '/v1/accounts', {
      email: `${randomUUID()}@example.com`,
      name: 'Alice',
    });
    const bob = await post<AccountResponse>(two.url, '/v1/accounts', {
      email: `${randomUUID()}@example.com`,
      name: 'Bob',
    });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    const funding = await post(
      one.url,
      '/v1/admin/funding',
      { wallet_id: alice.body.wallet.id, amount_minor: '1000' },
      { 'X-Admin-Key': admin, 'Idempotency-Key': randomUUID() },
    );
    assert.equal(funding.status, 201);
    const body = { destination_wallet_id: bob.body.wallet.id, amount_minor: '100' };
    const auth = { Authorization: `Bearer ${alice.body.api_key}` };
    const attempts = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        post(urls[i % 2]!, '/v1/transfers', body, { ...auth, 'Idempotency-Key': randomUUID() }),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 201).length, 10);
    assert.equal(attempts.filter((r) => r.status === 422).length, 20);
    // Fund again and race one logical transfer across both independent connection pools.
    assert.equal(
      (
        await post(
          two.url,
          '/v1/admin/funding',
          { wallet_id: alice.body.wallet.id, amount_minor: '1000' },
          { 'X-Admin-Key': admin, 'Idempotency-Key': randomUUID() },
        )
      ).status,
      201,
    );
    const key = randomUUID();
    const duplicates = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(urls[i % 2]!, '/v1/transfers', body, { ...auth, 'Idempotency-Key': key }),
      ),
    );
    assert.equal(duplicates.filter((r) => r.status === 201).length, 1);
    assert.equal(duplicates.filter((r) => r.status === 200).length, 11);
    assert.equal(new Set(duplicates.map((r) => r.body.id)).size, 1);
    await stop(one.child);
    const replacement = await start();
    const replay = await post(replacement.url, '/v1/transfers', body, {
      ...auth,
      'Idempotency-Key': key,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, duplicates[0]!.body.id);
    const balances = (
      await pool.query('SELECT id,balance_minor FROM wallets WHERE id=ANY($1::uuid[])', [
        [alice.body.wallet.id, bob.body.wallet.id],
      ])
    ).rows;
    assert.equal(balances.find((w) => w.id === alice.body.wallet.id).balance_minor, '900');
    assert.equal(balances.find((w) => w.id === bob.body.wallet.id).balance_minor, '1100');
    const mismatch = await pool.query(
      'SELECT w.id FROM wallets w LEFT JOIN ledger_entries e ON e.wallet_id=w.id WHERE w.id=ANY($1::uuid[]) GROUP BY w.id HAVING w.balance_minor<>COALESCE(SUM(e.delta_minor),0)',
      [[alice.body.wallet.id, bob.body.wallet.id]],
    );
    assert.equal(mismatch.rowCount, 0);
  },
);
