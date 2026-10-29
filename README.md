# Lendsqr Wallet Service

A wallet API built with Node.js, TypeScript, Express and PostgreSQL. Supports account creation, wallet transfers, blacklist screening and account blocking.

**[Live API](https://lendsqr-wallet-service-t524.onrender.com)** · **[Health check](https://lendsqr-wallet-service-t524.onrender.com/ready)**

## Getting started

Requires Node.js 22 and PostgreSQL 17. Docker Compose is included for running PostgreSQL locally.

```bash
git clone https://github.com/kingtolu001/lendsqr-wallet-service.git
cd lendsqr-wallet-service

npm ci
docker compose up -d
cp .env.example .env
```

Generate an admin key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Add the generated value to `.env`:

```env
DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet
ADMIN_API_KEY=YOUR_GENERATED_KEY
PORT=3000
TRUST_PROXY_HOPS=0
```

Start the development server:

```bash
npm run dev
```

Migrations run automatically at startup. They can also be applied separately with `npm run migrate`.

## API

User endpoints require `Authorization: Bearer <api_key>`. Admin endpoints require `X-Admin-Key`.

| Method | Endpoint                        | Description                          | Access |
| ------ | ------------------------------- | ------------------------------------ | ------ |
| POST   | `/v1/accounts`                  | Create an account and wallet         | Public |
| GET    | `/v1/me`                        | Retrieve account details and balance | User   |
| POST   | `/v1/transfers`                 | Transfer funds to another wallet     | User   |
| GET    | `/v1/transactions`              | Retrieve transaction history         | User   |
| POST   | `/v1/admin/funding`             | Add test funds to a wallet           | Admin  |
| PATCH  | `/v1/admin/accounts/:id`        | Block or unblock an account          | Admin  |
| PUT    | `/v1/admin/blacklist`           | Add an email to the blacklist        | Admin  |
| GET    | `/v1/admin/blacklist?email=...` | Check blacklist status               | Admin  |
| DELETE | `/v1/admin/blacklist`           | Remove an email from the blacklist   | Admin  |
| GET    | `/health`                       | Process health                       | Public |
| GET    | `/ready`                        | Database readiness                   | Public |

### Create an account

```bash
curl -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","name":"Alice"}'
```

The response includes the account, wallet and a user API key. The key is returned once; only its hash is stored.

Each account has one NGN wallet with an initial balance of zero.

### Fund a wallet

The admin funding endpoint provides test balances for exercising transfers.

```bash
curl -X POST http://localhost:3000/v1/admin/funding \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Idempotency-Key: funding-alice-001" \
  -d '{"wallet_id":"ALICE_WALLET_ID","amount_minor":"10000"}'
```

Amounts are integer strings in minor units: `"10000"` represents NGN 100.00.

### Transfer funds

Create a second account, then use its wallet ID as the destination:

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ALICE_API_KEY" \
  -H "Idempotency-Key: alice-to-bob-001" \
  -d '{"destination_wallet_id":"BOB_WALLET_ID","amount_minor":"2500"}'
```

The source wallet is derived from the authenticated account.

Transfer and funding requests require an `Idempotency-Key` containing 8–128 letters, digits, underscores or hyphens.

- First execution returns `201`.
- Repeating a successful request returns the original transaction with `200` and `Idempotency-Replayed: true`.
- Reusing the key with different parameters returns `409`.
- Failed operations roll back and can be retried with the same key.

### Block an account

```bash
curl -X PATCH http://localhost:3000/v1/admin/accounts/USER_ID \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"blocked":true,"reason":"Account review"}'
```

Set `blocked` to `false` to unblock the account. Blocked accounts cannot access user endpoints or participate in transfers.

Blacklist entries prevent registration and money movement. Blacklist membership and account blocking are managed independently.

## Design decisions

**Money representation.** Balances use PostgreSQL `bigint`, with JavaScript `BigInt` for application-side comparisons. Amounts remain strings in API requests and responses to avoid floating-point rounding.

**Atomic transfers.** The debit, credit, transaction record and journal entries commit in one database transaction. SQL constraints prevent negative balances.

**Concurrency.** Participating account rows and wallet rows are locked in a consistent order. Balance and account restrictions are checked under those locks, preventing parallel requests from spending the same funds.

**Replay protection.** Idempotency records persist in PostgreSQL. Keys are scoped to the caller and bound to a request fingerprint. Advisory locks serialize duplicate requests, backed by a unique database constraint.

**Account controls.** Blocking and blacklist updates coordinate with transfers through account locks. Block changes record a reason and timestamp.

**Security.** User keys are randomly generated and hashed before storage. Requests use parameterized SQL, strict validation, rate limiting, security headers and bounded database timeouts.

## Testing

Create a dedicated test database:

```bash
docker compose exec -T postgres createdb -U wallet wallet_test
```

Run the checks:

```bash
DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet_test npm test
npm run typecheck
npm run format:check
```

The suite contains 26 tests covering concurrent spending, duplicate requests, rollback, account controls, ownership, balance limits and replay across separate server processes and a restart.

Hosted checks also verified concurrent transfers, replay protection, blacklist restrictions and exact balances.

## Deployment

The service is hosted on Render. `render.yaml` defines the web service and PostgreSQL database.

**Build command**

```bash
npm ci --include=dev && npm run build && npm prune --omit=dev
```

**Start command**

```bash
npm start
```

Required environment variables are `DATABASE_URL` and `ADMIN_API_KEY`. Set `NODE_ENV=production` and configure `TRUST_PROXY_HOPS` for the ingress proxy. Render supplies `PORT`.

## Scope

The service supports NGN wallets. Blacklist screening uses an admin-managed SQL registry. Funding is a test utility; external payment collection is outside the implementation.

Rate limiting is local to each server process. Multiple public instances would require a shared rate-limit store.
