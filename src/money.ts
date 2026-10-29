import { createHash, randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { ApiError } from './errors.js';
import { moneyRequest, type MoneyRequest } from './validation.js';
export async function moveMoney(request: MoneyRequest) {
  const input = moneyRequest.parse(request);
  const sourceId = input.kind === 'transfer' ? input.source : undefined;
  if (sourceId === input.destination)
    throw new ApiError(422, 'SELF_TRANSFER', 'Source and destination must differ');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.kind, sourceId ?? null, input.destination, input.amount]))
    .digest('hex');
  return transaction(async (client) => {
    if (sourceId) {
      const owned = await client.query('SELECT 1 FROM wallets WHERE id=$1 AND user_id=$2', [
        sourceId,
        input.actor,
      ]);
      if (!owned.rowCount)
        throw new ApiError(
          403,
          'WALLET_NOT_OWNED',
          'Source wallet must belong to the authenticated account',
        );
    }
    // Durable uniqueness provides replay protection; this lock serializes duplicate callers before checking.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify([input.actor, input.key]),
    ]);
    const existing = (
      await client.query('SELECT * FROM transactions WHERE actor=$1 AND idempotency_key=$2', [
        input.actor,
        input.key,
      ])
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== fingerprint)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key was already used with a different request',
        );
      return { transaction: existing, replayed: true };
    }
    const ids = [sourceId, input.destination].filter((id): id is string => !!id).sort();
    // Account locks are shared with blocking and blacklist changes. Always acquire them before wallet locks.
    const accounts = (
      await client.query(
        'SELECT u.id,u.blocked,u.email FROM users u JOIN wallets w ON w.user_id=u.id WHERE w.id=ANY($1::uuid[]) ORDER BY u.id FOR UPDATE OF u',
        [ids],
      )
    ).rows;
    const wallets = (
      await client.query('SELECT * FROM wallets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        ids,
      ])
    ).rows;
    if (wallets.length !== ids.length)
      throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    if (accounts.some((u) => u.blocked))
      throw new ApiError(403, 'ACCOUNT_BLOCKED', 'A participating account is blocked');
    const listed = await client.query('SELECT 1 FROM blacklist WHERE email=ANY($1::text[])', [
      accounts.map((u) => u.email),
    ]);
    if (listed.rowCount)
      throw new ApiError(403, 'BLACKLISTED', 'A participating account is blacklisted');
    const source = wallets.find((w) => w.id === sourceId);
    if (
      input.kind === 'transfer' &&
      (!source || BigInt(source.balance_minor) < BigInt(input.amount))
    )
      throw new ApiError(422, 'INSUFFICIENT_FUNDS', 'Insufficient wallet balance');
    const destination = wallets.find((w) => w.id === input.destination)!;
    if (BigInt(destination.balance_minor) + BigInt(input.amount) > 9007199254740991n)
      throw new ApiError(422, 'BALANCE_LIMIT', 'Destination balance limit exceeded');
    const id = randomUUID();
    const record = (
      await client.query(
        'INSERT INTO transactions(id,actor,idempotency_key,request_hash,kind,source_wallet_id,destination_wallet_id,amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [
          id,
          input.actor,
          input.key,
          fingerprint,
          input.kind,
          sourceId ?? null,
          input.destination,
          input.amount,
        ],
      )
    ).rows[0];
    if (source) {
      await client.query('UPDATE wallets SET balance_minor=balance_minor-$1 WHERE id=$2', [
        input.amount,
        sourceId,
      ]);
      await client.query(
        'INSERT INTO ledger_entries(transaction_id,wallet_id,delta_minor) VALUES($1,$2,-$3::bigint)',
        [id, sourceId, input.amount],
      );
    }
    await client.query('UPDATE wallets SET balance_minor=balance_minor+$1 WHERE id=$2', [
      input.amount,
      input.destination,
    ]);
    await client.query(
      'INSERT INTO ledger_entries(transaction_id,wallet_id,delta_minor) VALUES($1,$2,$3)',
      [id, input.destination, input.amount],
    );
    return { transaction: record, replayed: false };
  });
}
