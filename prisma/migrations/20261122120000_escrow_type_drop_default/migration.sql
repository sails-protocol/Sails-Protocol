-- CTO 28 Despacho 030 (D030) - escrows.type has no default.
--
-- Problem: schema.prisma declared `type EscrowType @default(MOCK)`, so an INSERT that forgot the rail silently
-- became a MOCK escrow (no real custody). The rail must be chosen explicitly by every writer; omitting it is now
-- refused by the NOT NULL column (SQLSTATE 23502) instead of defaulting to MOCK.
--
-- Effect: metadata only (pg_attrdef row removed). Existing rows are untouched; no rewrite, no backfill.
-- Every writer in src/ already passes `type` (escrow-repository.ts create(); CreateEscrowData.type is required).
--
-- Reversal (run by hand only, never applied persistently without an order):
--   ALTER TABLE "escrows" ALTER COLUMN "type" SET DEFAULT 'MOCK';

SET lock_timeout = '5s';

ALTER TABLE "escrows" ALTER COLUMN "type" DROP DEFAULT;

RESET lock_timeout;
