import { z } from 'zod';

export const uuid = z.uuid().transform((value) => value.toLowerCase());
export const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const amount = z
  .string()
  .refine(
    (value) => /^[1-9][0-9]{0,15}$/.test(value) && BigInt(value) <= 9007199254740991n,
    'Amount must be a positive integer string no greater than 9007199254740991',
  );
export const reason = z.string().trim().min(1).max(500);
export const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);

export const moneyRequest = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('transfer'),
      actor: uuid,
      key: keySchema,
      source: uuid,
      destination: uuid,
      amount,
    })
    .strict(),
  z
    .object({
      kind: z.literal('funding'),
      actor: z.literal('admin'),
      key: keySchema,
      destination: uuid,
      amount,
    })
    .strict(),
]);
export type MoneyRequest = z.input<typeof moneyRequest>;
