import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL?.replace(/\/$/, '');
const admin = process.env.ADMIN_API_KEY;
if (!base || !admin)
  throw new Error('Set BASE_URL and ADMIN_API_KEY before running the smoke check');

async function call(path, { method = 'GET', body, token, key, privileged = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(privileged ? { 'X-Admin-Key': admin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  return { status: response.status, data, replayed: response.headers.get('Idempotency-Replayed') };
}

assert.equal((await call('/ready')).status, 200, 'Database readiness');
const accounts = [];
for (const name of ['Alice', 'Bob']) {
  const account = await call('/v1/accounts', {
    method: 'POST',
    body: { email: `smoke-${randomUUID()}@example.com`, name: `Smoke ${name}` },
  });
  assert.equal(account.status, 201, 'Account creation');
  accounts.push(account.data);
}
const [alice, bob] = accounts;
const funding = await call('/v1/admin/funding', {
  method: 'POST',
  privileged: true,
  key: randomUUID(),
  body: { wallet_id: alice.wallet.id, amount_minor: '10000' },
});
assert.equal(funding.status, 201, 'Assessment funding');
const transfer = {
  method: 'POST',
  token: alice.api_key,
  key: randomUUID(),
  body: { destination_wallet_id: bob.wallet.id, amount_minor: '2500' },
};
const first = await call('/v1/transfers', transfer);
const replay = await call('/v1/transfers', transfer);
assert.equal(first.status, 201, 'First transfer');
assert.equal(replay.status, 200, 'Replay');
assert.equal(replay.data.id, first.data.id, 'Replay transaction ID');
assert.equal(replay.replayed, 'true', 'Replay response header');
assert.equal((await call('/v1/me', { token: alice.api_key })).data.balance_minor, '7500');
assert.equal((await call('/v1/me', { token: bob.api_key })).data.balance_minor, '2500');

const block = await call(`/v1/admin/accounts/${bob.user.id}`, {
  method: 'PATCH',
  privileged: true,
  body: { blocked: true, reason: 'Automated assessment smoke check' },
});
assert.equal(block.status, 200, 'Block');
const blocked = await call('/v1/transfers', { ...transfer, key: randomUUID() });
assert.equal(blocked.status, 403, 'Blocked recipient');
assert.equal(blocked.data.error.code, 'ACCOUNT_BLOCKED');
const unblock = await call(`/v1/admin/accounts/${bob.user.id}`, {
  method: 'PATCH',
  privileged: true,
  body: { blocked: false, reason: 'Smoke check complete' },
});
assert.equal(unblock.status, 200, 'Unblock');
console.log(
  'Smoke passed: readiness, creation, funding, transfer, replay, balances, block/unblock.',
);
