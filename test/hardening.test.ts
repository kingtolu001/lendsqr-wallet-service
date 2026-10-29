import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, transaction } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { moveMoney } from '../src/money.js';

const admin = 'hardening-admin-secret-at-least-32-characters';
const server = createServer(createApp(admin, { rateLimit: 1000 }));
const api = request(server);
test('invalid admin and proxy configuration fail closed', () => {
  assert.throws(() => createApp(''), /ADMIN_API_KEY/);
  assert.throws(() => createApp(admin, { trustProxyHops: -1 }));
});
type Account = { user: { id: string; email: string }; wallet: { id: string }; api_key: string };
before(async () => {
  if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Dedicated _test database required');
  await migrate();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
async function account(): Promise<Account> {
  return (
    await api
      .post('/v1/accounts')
      .send({ email: `${randomUUID()}@example.com`, name: 'Hardening User' })
      .expect(201)
  ).body;
}
async function fund(a: Account, value = '1000') {
  return moveMoney({
    actor: 'admin',
    kind: 'funding',
    key: randomUUID(),
    destination: a.wallet.id,
    amount: value,
  });
}
function input(a: Account, b: Account, value = '100') {
  return {
    actor: a.user.id,
    kind: 'transfer' as const,
    key: randomUUID(),
    source: a.wallet.id,
    destination: b.wallet.id,
    amount: value,
  };
}
async function balance(a: Account) {
  return (await pool.query('SELECT balance_minor FROM wallets WHERE id=$1', [a.wallet.id])).rows[0]
    .balance_minor;
}
async function waitForBlockedAccountLock() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const blocked = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT u.id,u.blocked%'",
    );
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Transfer did not reach account lock');
}
test('money service enforces ownership, valid amounts and self-transfer independently of HTTP', async () => {
  const a = await account(),
    b = await account();
  await fund(a);
  await assert.rejects(moveMoney({ ...input(a, b), actor: b.user.id }), {
    code: 'WALLET_NOT_OWNED',
  });
  await assert.rejects(moveMoney(input(a, a)), { code: 'SELF_TRANSFER' });
  await assert.rejects(moveMoney(input(a, b, '-100')));
  await assert.rejects(moveMoney(input(a, b, '1.5')));
  assert.equal(await balance(a), '1000');
  assert.equal(await balance(b), '0');
});
test('recipient overflow rejects without debiting source or recording a transaction', async () => {
  const a = await account(),
    b = await account();
  await fund(a);
  await fund(b, '9007199254740991');
  const attempt = input(a, b, '1');
  await assert.rejects(moveMoney(attempt), { code: 'BALANCE_LIMIT' });
  assert.equal(await balance(a), '1000');
  assert.equal(await balance(b), '9007199254740991');
  assert.equal(
    (
      await pool.query('SELECT 1 FROM transactions WHERE actor=$1 AND idempotency_key=$2', [
        attempt.actor,
        attempt.key,
      ])
    ).rowCount,
    0,
  );
});
test('a block committed while transfer waits is rechecked under the account lock', async () => {
  const a = await account(),
    b = await account();
  await fund(a);
  const client = await pool.connect();
  let outcome: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET blocked=true WHERE id=$1', [a.user.id]);
    outcome = moveMoney(input(a, b)).then(
      () => null,
      (error) => error,
    );
    await waitForBlockedAccountLock();
    await client.query('COMMIT');
    assert.equal(((await outcome) as { code: string }).code, 'ACCOUNT_BLOCKED');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (outcome) await outcome;
  }
  assert.equal(await balance(a), '1000');
  assert.equal(await balance(b), '0');
});
test('blacklist committed while transfer waits prevents both credit and debit', async () => {
  const a = await account(),
    b = await account();
  await fund(a);
  const client = await pool.connect();
  let outcome: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [b.user.id]);
    await client.query('INSERT INTO blacklist(email,reason) VALUES($1,$2)', [
      b.user.email,
      'Concurrent screening',
    ]);
    outcome = moveMoney(input(a, b)).then(
      () => null,
      (error) => error,
    );
    await waitForBlockedAccountLock();
    await client.query('COMMIT');
    assert.equal(((await outcome) as { code: string }).code, 'BLACKLISTED');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (outcome) await outcome;
  }
  assert.equal(await balance(a), '1000');
  assert.equal(await balance(b), '0');
});
test('same key used by different actors is independent; changed destination conflicts', async () => {
  const a = await account(),
    b = await account(),
    c = await account();
  await fund(a);
  await fund(b);
  const key = randomUUID();
  await moveMoney({ ...input(a, c), key });
  await moveMoney({ ...input(b, c), key });
  await assert.rejects(moveMoney({ ...input(a, b), key }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(await balance(a), '900');
  assert.equal(await balance(b), '900');
  assert.equal(await balance(c), '200');
});
test('failed insufficient-funds request can be retried after funding with its original key', async () => {
  const a = await account(),
    b = await account();
  const attempt = input(a, b);
  await assert.rejects(moveMoney(attempt), { code: 'INSUFFICIENT_FUNDS' });
  await fund(a);
  assert.equal((await moveMoney(attempt)).replayed, false);
  assert.equal((await moveMoney(attempt)).replayed, true);
  assert.equal(await balance(a), '900');
});
test('malformed and oversized JSON have consistent errors, request IDs and no-store headers', async () => {
  for (const [body, status, code] of [
    ['{', 400, 'INVALID_JSON'],
    [JSON.stringify({ name: 'x'.repeat(17000) }), 413, 'BODY_TOO_LARGE'],
  ] as const) {
    const response = await api
      .post('/v1/accounts')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(status);
    assert.equal(response.body.error.code, code);
    assert.match(response.body.error.request_id, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-powered-by'], undefined);
  }
});
test('pagination rejects arrays, empty values and unknown fields; unknown wallets return 404', async () => {
  const a = await account();
  for (const query of ['limit=', 'limit=1&limit=2', 'limit=101', 'offset=-1', 'unexpected=value']) {
    await api.get(`/v1/transactions?${query}`).auth(a.api_key, { type: 'bearer' }).expect(400);
  }
  await api
    .post('/v1/transfers')
    .auth(a.api_key, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ destination_wallet_id: randomUUID(), amount_minor: '1' })
    .expect(404);
});
test('uppercase wallet IDs canonicalize for replay and self-transfer protection', async () => {
  const a = await account(),
    b = await account();
  await fund(a);
  const key = randomUUID();
  for (const [destination, status] of [
    [b.wallet.id.toUpperCase(), 201],
    [b.wallet.id, 200],
  ] as const) {
    await api
      .post('/v1/transfers')
      .auth(a.api_key, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ destination_wallet_id: destination, amount_minor: '100' })
      .expect(status);
  }
  await api
    .post('/v1/transfers')
    .auth(a.api_key, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ destination_wallet_id: a.wallet.id.toUpperCase(), amount_minor: '1' })
    .expect(422);
});
test('SQL constraints reject negative balances and failed transactions release their connections', async () => {
  const a = await account();
  await assert.rejects(
    transaction((client) =>
      client.query('UPDATE wallets SET balance_minor=-1 WHERE id=$1', [a.wallet.id]),
    ),
    { code: '23514' },
  );
  assert.equal(await balance(a), '0');
  await pool.query('SELECT 1');
});
test('one trusted proxy separates client limits while ignoring spoofed addresses farther left', async () => {
  const limited = createServer(createApp(admin, { trustProxyHops: 1, rateLimit: 2 }));
  await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
  try {
    const agent = request(limited);
    await agent.get('/v1/unknown').set('X-Forwarded-For', '198.51.100.1').expect(404);
    await agent.get('/v1/unknown').set('X-Forwarded-For', '198.51.100.1').expect(404);
    const limitedResponse = await agent
      .get('/v1/unknown')
      .set('X-Forwarded-For', '203.0.113.9, 198.51.100.1')
      .expect(429);
    assert.equal(limitedResponse.body.error.code, 'RATE_LIMITED');
    assert.ok(limitedResponse.headers['retry-after']);
    await agent.get('/v1/unknown').set('X-Forwarded-For', '198.51.100.2').expect(404);
  } finally {
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  }
});
test('wallet creation failure rolls back the new user as well', async () => {
  const address = `${randomUUID()}@example.com`;
  // NOT VALID avoids touching existing wallets but rejects every new wallet during this test.
  await pool.query(
    "ALTER TABLE wallets ADD CONSTRAINT test_reject_wallet_creation CHECK (currency <> 'NGN') NOT VALID",
  );
  try {
    await api.post('/v1/accounts').send({ email: address, name: 'Atomic creation' }).expect(500);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE email=$1', [address])).rowCount, 0);
  } finally {
    await pool.query('ALTER TABLE wallets DROP CONSTRAINT test_reject_wallet_creation');
  }
});
test('parallel duplicate registration creates exactly one account and one wallet', async () => {
  const address = `${randomUUID()}@example.com`;
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api.post('/v1/accounts').send({ email: address, name: 'Concurrent registration' }),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === 201).length, 1);
  assert.equal(attempts.filter((result) => result.status === 409).length, 7);
  const accounts = await pool.query(
    'SELECT u.id FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.email=$1',
    [address],
  );
  assert.equal(accounts.rowCount, 1);
});
test('registration waits for concurrent screening and rejects an email added to the blacklist', async () => {
  const address = `${randomUUID()}@example.com`;
  const client = await pool.connect();
  let outcome: Promise<request.Response> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [address]);
    await client.query('INSERT INTO blacklist(email,reason) VALUES($1,$2)', [
      address,
      'Registration screening',
    ]);
    outcome = api
      .post('/v1/accounts')
      .send({ email: address, name: 'Screened registration' })
      .then((result) => result);
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const result = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))%'",
      );
      if (result.rowCount) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'Registration must reach the shared email lock');
    await client.query('COMMIT');
    assert.equal((await outcome).status, 403);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE email=$1', [address])).rowCount, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (outcome) await outcome;
  }
});
test('readiness fails with 503 during database lock contention and recovers afterward', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK wallets IN ACCESS EXCLUSIVE MODE');
    const response = await api.get('/ready').expect(503);
    assert.equal(response.body.error.code, 'NOT_READY');
    assert.equal(response.headers['retry-after'], '1');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  await api.get('/ready').expect(200);
});
