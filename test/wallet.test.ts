import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { moveMoney } from '../src/money.js';

const admin = 'test-admin-secret-with-at-least-32-characters';
const app = createApp(admin, { rateLimit: 1000 });
const server = createServer(app);
const api = request(server);
before(async () => {
  if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Tests require a dedicated DATABASE_URL whose database name ends in _test');
  await migrate();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
type Account = {
  user: { id: string; email: string };
  wallet: { id: string; balance_minor: string };
  api_key: string;
};
async function account(): Promise<Account> {
  const response = await api
    .post('/v1/accounts')
    .send({ email: `${randomUUID()}@example.com`, name: 'Test User' })
    .expect(201);
  return response.body;
}
async function fund(wallet: string, value = '10000', key = randomUUID()) {
  return api
    .post('/v1/admin/funding')
    .set('X-Admin-Key', admin)
    .set('Idempotency-Key', key)
    .send({ wallet_id: wallet, amount_minor: value });
}
async function transfer(a: Account, b: Account, value: unknown, key = randomUUID()) {
  return api
    .post('/v1/transfers')
    .auth(a.api_key, { type: 'bearer' })
    .set('Idempotency-Key', key)
    .send({ destination_wallet_id: b.wallet.id, amount_minor: value });
}
test('account and wallet creation are atomic, keys are hashed, duplicate email rejected', async () => {
  const a = await account();
  assert.equal(a.wallet.balance_minor, '0');
  const stored = (await pool.query('SELECT api_key_hash FROM users WHERE id=$1', [a.user.id]))
    .rows[0];
  assert.notEqual(stored.api_key_hash, a.api_key);
  await api
    .post('/v1/accounts')
    .send({ email: a.user.email.toUpperCase(), name: 'Duplicate' })
    .expect(409);
  await api.get('/v1/me').auth(a.api_key, { type: 'bearer' }).expect(200);
  await api.get('/v1/me').expect(401);
});
test('blacklist rejects onboarding and prevents existing users moving money', async () => {
  const a = await account(),
    b = await account();
  assert.equal((await fund(a.wallet.id)).status, 201);
  await api
    .put('/v1/admin/blacklist')
    .set('X-Admin-Key', admin)
    .send({ email: a.user.email, reason: 'Assessment test' })
    .expect(200);
  await api
    .get('/v1/admin/blacklist')
    .set('X-Admin-Key', admin)
    .query({ email: a.user.email })
    .expect(200)
    .expect((r) => assert.equal(r.body.blacklisted, true));
  assert.equal((await transfer(a, b, '100')).status, 403);
  await api.post('/v1/accounts').send({ email: a.user.email, name: 'Listed' }).expect(403);
  await api
    .delete('/v1/admin/blacklist')
    .set('X-Admin-Key', admin)
    .send({ email: a.user.email })
    .expect(204);
  assert.equal((await transfer(a, b, '100')).status, 201);
});
test('blocking affects sender and recipient; admin can unblock', async () => {
  const a = await account(),
    b = await account();
  await fund(a.wallet.id);
  await api
    .patch(`/v1/admin/accounts/${b.user.id}`)
    .set('X-Admin-Key', admin)
    .send({ blocked: true, reason: 'Review' })
    .expect(200);
  assert.equal((await transfer(a, b, '100')).status, 403);
  await api.get('/v1/me').auth(b.api_key, { type: 'bearer' }).expect(403);
  await api
    .patch(`/v1/admin/accounts/${b.user.id}`)
    .set('X-Admin-Key', admin)
    .send({ blocked: false, reason: 'Cleared' })
    .expect(200);
  assert.equal((await transfer(a, b, '100')).status, 201);
});
test('parallel overspending preserves balances and reconciles ledger', async () => {
  const a = await account(),
    b = await account();
  await fund(a.wallet.id, '1000');
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      moveMoney({
        actor: a.user.id,
        key: randomUUID(),
        kind: 'transfer',
        source: a.wallet.id,
        destination: b.wallet.id,
        amount: '100',
      }).then(
        () => 201,
        (e) => e.status,
      ),
    ),
  );
  assert.equal(results.filter((s) => s === 201).length, 10);
  assert.equal(results.filter((s) => s === 422).length, 20);
  const balances = (
    await pool.query('SELECT id,balance_minor FROM wallets WHERE id=ANY($1::uuid[])', [
      [a.wallet.id, b.wallet.id],
    ])
  ).rows;
  assert.equal(balances.find((w) => w.id === a.wallet.id).balance_minor, '0');
  assert.equal(balances.find((w) => w.id === b.wallet.id).balance_minor, '1000');
  const mismatch = await pool.query(
    'SELECT w.id FROM wallets w LEFT JOIN ledger_entries e ON e.wallet_id=w.id WHERE w.id=ANY($1::uuid[]) GROUP BY w.id HAVING w.balance_minor<>COALESCE(SUM(e.delta_minor),0)',
    [[a.wallet.id, b.wallet.id]],
  );
  assert.equal(mismatch.rowCount, 0);
});
test('simultaneous duplicate requests commit once and changed payload conflicts', async () => {
  const a = await account(),
    b = await account();
  await fund(a.wallet.id);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 12 }, () => transfer(a, b, '100', key)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 11);
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await transfer(a, b, '200', key)).status, 409);
  assert.equal(
    (await pool.query('SELECT balance_minor FROM wallets WHERE id=$1', [a.wallet.id])).rows[0]
      .balance_minor,
    '9900',
  );
});
test('opposite direction transfers complete without deadlocks or money creation', async () => {
  const a = await account(),
    b = await account();
  await fund(a.wallet.id);
  await fund(b.wallet.id);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      moveMoney({
        actor: i % 2 ? a.user.id : b.user.id,
        key: randomUUID(),
        kind: 'transfer',
        source: i % 2 ? a.wallet.id : b.wallet.id,
        destination: i % 2 ? b.wallet.id : a.wallet.id,
        amount: '100',
      }),
    ),
  );
  const rows = (
    await pool.query('SELECT balance_minor FROM wallets WHERE id=ANY($1::uuid[])', [
      [a.wallet.id, b.wallet.id],
    ])
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.balance_minor),
    ['10000', '10000'],
  );
});
test('invalid amounts, impersonation, missing keys and self transfer are rejected', async () => {
  const a = await account(),
    b = await account();
  for (const value of ['0', '-1', '1.5', '9007199254740992', 100]) {
    assert.equal((await transfer(a, b, value)).status, 400);
  }
  assert.equal((await transfer(a, a, '100')).status, 422);
  await api
    .post('/v1/transfers')
    .auth(a.api_key, { type: 'bearer' })
    .send({ destination_wallet_id: b.wallet.id, amount_minor: '100' })
    .expect(400);
  await api
    .post('/v1/transfers')
    .auth(a.api_key, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({
      source_wallet_id: b.wallet.id,
      destination_wallet_id: a.wallet.id,
      amount_minor: '100',
    })
    .expect(400);
  await api
    .post('/v1/admin/funding')
    .send({ wallet_id: a.wallet.id, amount_minor: '100' })
    .expect(401);
});
test('database failure after debit rolls the entire transaction back', async () => {
  const a = await account(),
    b = await account();
  await fund(a.wallet.id, '1000');
  const constraint = `test_reject_${randomUUID().replaceAll('-', '')}`;
  await pool.query(
    `ALTER TABLE ledger_entries ADD CONSTRAINT ${constraint} CHECK (wallet_id <> '${b.wallet.id}'::uuid)`,
  );
  const key = randomUUID();
  try {
    await assert.rejects(
      moveMoney({
        actor: a.user.id,
        key,
        kind: 'transfer',
        source: a.wallet.id,
        destination: b.wallet.id,
        amount: '100',
      }),
    );
  } finally {
    await pool.query(`ALTER TABLE ledger_entries DROP CONSTRAINT ${constraint}`);
  }
  assert.equal(
    (await pool.query('SELECT balance_minor FROM wallets WHERE id=$1', [a.wallet.id])).rows[0]
      .balance_minor,
    '1000',
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM transactions WHERE actor=$1 AND idempotency_key=$2', [
        a.user.id,
        key,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await transfer(a, b, '100', key)).status, 201);
});
test('funding replays once and transaction history is scoped to caller', async () => {
  const a = await account(),
    b = await account();
  const key = randomUUID();
  assert.equal((await fund(a.wallet.id, '1000', key)).status, 201);
  assert.equal((await fund(a.wallet.id, '1000', key)).status, 200);
  const history = await api.get('/v1/transactions').auth(b.api_key, { type: 'bearer' }).expect(200);
  assert.equal(history.body.data.length, 0);
});
