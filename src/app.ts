import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { pool, transaction } from './db.js';
import { ApiError } from './errors.js';
import { moveMoney } from './money.js';
import { uuid, email, amount, reason, keySchema } from './validation.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicTransaction = (t: Record<string, unknown>) => ({
  id: t.id,
  kind: t.kind,
  source_wallet_id: t.source_wallet_id,
  destination_wallet_id: t.destination_wallet_id,
  amount_minor: t.amount_minor,
  currency: 'NGN',
  created_at: t.created_at,
});
export function createApp(
  adminKey: string,
  options: { trustProxyHops?: number; rateLimit?: number } = {},
) {
  if (adminKey.length < 32) throw new Error('ADMIN_API_KEY must contain at least 32 characters');
  const proxyHops = z
    .number()
    .int()
    .min(0)
    .max(5)
    .parse(options.trustProxyHops ?? 0);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', proxyHops);
  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1 FROM wallets LIMIT 0');
    } catch {
      throw new ApiError(503, 'NOT_READY', 'Database is unavailable');
    }
    res.json({ status: 'ready' });
  });
  app.get('/', (_req, res) =>
    res.json({
      service: 'Lendsqr Wallet API',
      version: '1.0.0',
      health: '/health',
      readiness: '/ready',
      documentation: 'See repository README.md',
    }),
  );
  app.use(
    '/v1',
    rateLimit({
      windowMs: 60000,
      limit: options.rateLimit ?? 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(
          new ApiError(429, 'RATE_LIMITED', 'Too many requests; retry after the indicated delay'),
        ),
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    const supplied = hash(req.get('X-Admin-Key') ?? '');
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(hash(adminKey))))
      throw new ApiError(401, 'UNAUTHORIZED', 'Valid admin key required');
    next();
  };
  const auth = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.get('Authorization')?.match(/^Bearer (wlt_[a-f0-9]{64})$/)?.[1];
    if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Valid bearer API key required');
    const user = (
      await pool.query('SELECT id,blocked FROM users WHERE api_key_hash=$1', [hash(token)])
    ).rows[0];
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Valid bearer API key required');
    if (user.blocked) throw new ApiError(403, 'ACCOUNT_BLOCKED', 'Account is blocked');
    res.locals.userId = user.id;
    next();
  };
  app.post('/v1/accounts', async (req, res) => {
    const body = z
      .object({ email, name: z.string().trim().min(1).max(120) })
      .strict()
      .parse(req.body);
    const apiKey = `wlt_${randomBytes(32).toString('hex')}`;
    const result = await transaction(async (client) => {
      // Serializes account creation against blacklist changes, including when no user exists yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [body.email]);
      if ((await client.query('SELECT 1 FROM blacklist WHERE email=$1', [body.email])).rowCount)
        throw new ApiError(403, 'BLACKLISTED', 'Account cannot be created');
      const user = (
        await client.query(
          'INSERT INTO users(id,email,name,api_key_hash) VALUES($1,$2,$3,$4) RETURNING id,email,name,blocked,created_at',
          [randomUUID(), body.email, body.name, hash(apiKey)],
        )
      ).rows[0];
      const wallet = (
        await client.query('INSERT INTO wallets(id,user_id) VALUES($1,$2) RETURNING *', [
          randomUUID(),
          user.id,
        ])
      ).rows[0];
      return { user, wallet, api_key: apiKey };
    });
    res.status(201).json(result);
  });
  app.get('/v1/me', auth, async (_req, res) => {
    const result = await pool.query(
      'SELECT u.id,u.email,u.name,u.blocked,u.created_at,w.id AS wallet_id,w.currency,w.balance_minor FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=$1',
      [res.locals.userId],
    );
    res.json(result.rows[0]);
  });
  app.post('/v1/transfers', auth, async (req, res) => {
    const body = z
      .object({ destination_wallet_id: uuid, amount_minor: amount })
      .strict()
      .parse(req.body);
    const key = keySchema.parse(req.get('Idempotency-Key'));
    const wallet = (
      await pool.query('SELECT id FROM wallets WHERE user_id=$1', [res.locals.userId])
    ).rows[0];
    if (!wallet) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    const source = wallet.id as string;
    if (source === body.destination_wallet_id)
      throw new ApiError(422, 'SELF_TRANSFER', 'Source and destination must differ');
    const result = await moveMoney({
      actor: res.locals.userId,
      key,
      kind: 'transfer',
      source,
      destination: body.destination_wallet_id,
      amount: body.amount_minor,
    });
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    res.status(result.replayed ? 200 : 201).json(publicTransaction(result.transaction));
  });
  app.get('/v1/transactions', auth, async (req, res) => {
    const query = z
      .object({
        limit: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.number().int().min(1).max(100))
          .default(20),
        offset: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.number().int().min(0).max(10000))
          .default(0),
      })
      .strict()
      .parse(req.query);
    const result = await pool.query(
      'SELECT t.* FROM transactions t JOIN wallets w ON (w.id=t.source_wallet_id OR w.id=t.destination_wallet_id) WHERE w.user_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT $2 OFFSET $3',
      [res.locals.userId, query.limit, query.offset],
    );
    res.json({ data: result.rows.map(publicTransaction), ...query });
  });
  app.post('/v1/admin/funding', admin, async (req, res) => {
    const body = z.object({ wallet_id: uuid, amount_minor: amount }).strict().parse(req.body);
    const result = await moveMoney({
      actor: 'admin',
      key: keySchema.parse(req.get('Idempotency-Key')),
      kind: 'funding',
      destination: body.wallet_id,
      amount: body.amount_minor,
    });
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    res.status(result.replayed ? 200 : 201).json(publicTransaction(result.transaction));
  });
  app.patch('/v1/admin/accounts/:id', admin, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const body = z.object({ blocked: z.boolean(), reason }).strict().parse(req.body);
    const user = await transaction(async (client) => {
      const user = (
        await client.query('UPDATE users SET blocked=$1 WHERE id=$2 RETURNING id,email,blocked', [
          body.blocked,
          id,
        ])
      ).rows[0];
      if (!user) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      await client.query('INSERT INTO account_events(user_id,blocked,reason) VALUES($1,$2,$3)', [
        id,
        body.blocked,
        body.reason,
      ]);
      return user;
    });
    res.json(user);
  });
  app.put('/v1/admin/blacklist', admin, async (req, res) => {
    const body = z.object({ email, reason }).strict().parse(req.body);
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [body.email]);
      await client.query('SELECT id FROM users WHERE email=$1 FOR UPDATE', [body.email]);
      await client.query(
        'INSERT INTO blacklist(email,reason) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason',
        [body.email, body.reason],
      );
    });
    res.status(200).json({ email: body.email, blacklisted: true });
  });
  app.get('/v1/admin/blacklist', admin, async (req, res) => {
    const address = email.parse(req.query.email);
    const result = await pool.query(
      'SELECT email,reason,created_at FROM blacklist WHERE email=$1',
      [address],
    );
    res.json({ email: address, blacklisted: !!result.rowCount, entry: result.rows[0] ?? null });
  });
  app.delete('/v1/admin/blacklist', admin, async (req, res) => {
    const body = z.object({ email }).strict().parse(req.body);
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [body.email]);
      await client.query('SELECT id FROM users WHERE email=$1 FOR UPDATE', [body.email]);
      await client.query('DELETE FROM blacklist WHERE email=$1', [body.email]);
    });
    res.status(204).end();
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = 'An unexpected error occurred';
    if (error instanceof ApiError) ({ status, code, message } = error);
    else if (error instanceof z.ZodError) {
      status = 400;
      code = 'VALIDATION_ERROR';
      message = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(';');
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      status = 409;
      code = 'ALREADY_EXISTS';
      message = 'Account already exists';
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.parse.failed'
    ) {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Invalid JSON body';
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message = 'Request body exceeds 16kb';
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 415
    ) {
      status = 415;
      code = 'UNSUPPORTED_ENCODING';
      message = 'Unsupported request encoding';
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['55P03', '57014', '40P01', '53300', '57P01', 'ECONNREFUSED'].includes(String(error.code))
    ) {
      status = 503;
      code = 'TEMPORARILY_UNAVAILABLE';
      message = 'Please retry with the same idempotency key';
    }
    if (status === 500)
      console.error(
        'Request failed',
        res.getHeader('X-Request-Id'),
        error instanceof Error ? error.message : 'Unknown error',
      );
    if (status === 503) res.setHeader('Retry-After', '1');
    res
      .status(status)
      .json({ error: { code, message, request_id: res.getHeader('X-Request-Id') } });
  });
  return app;
}
