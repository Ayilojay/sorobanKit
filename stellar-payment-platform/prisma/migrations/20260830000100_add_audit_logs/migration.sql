-- The AuditLog model is declared in schema.prisma but no migration ever
-- created its table, so every admin audit-log write and the
-- /admin/audit-logs endpoint fail on a database built from migrations alone.
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "user_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "status_code" INTEGER,
    "payload" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- Tamper-evident audit chain: each row stores a keyed digest over its
-- canonicalized content plus the digest of the previous row in the chain
-- (prev_digest), and the id of the signing key used (key_id) so that key
-- rotation can be tracked and old rows can still be verified.
-- Columns are nullable so that rows written before this migration (and
-- legacy/backfilled rows) remain valid; verification tooling treats a NULL
-- digest as "unchained" rather than a failure.
ALTER TABLE "audit_logs" ADD COLUMN "digest" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "prev_digest" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "key_id" TEXT;

CREATE INDEX "audit_logs_key_id_idx" ON "audit_logs"("key_id");