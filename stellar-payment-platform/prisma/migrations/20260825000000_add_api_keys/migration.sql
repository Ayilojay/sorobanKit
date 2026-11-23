-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['read', 'write']::TEXT[],
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_owner_id_idx" ON "api_keys"("owner_id");

-- CreateIndex
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys"("key_hash");

-- AlterTable: overlapping API-key rotation metadata (additive, nullable for existing rows)
ALTER TABLE "api_keys" ADD COLUMN "predecessor_id" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "successor_id" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "overlap_expires_at" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN "rotated_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "api_keys_predecessor_id_idx" ON "api_keys"("predecessor_id");

-- CreateIndex
CREATE INDEX "api_keys_successor_id_idx" ON "api_keys"("successor_id");

-- CreateIndex
CREATE INDEX "api_keys_overlap_expires_at_idx" ON "api_keys"("overlap_expires_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_predecessor_id_fkey" FOREIGN KEY ("predecessor_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_successor_id_fkey" FOREIGN KEY ("successor_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: short-lived, single-use step-up verification challenges
CREATE TABLE "step_up_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_up_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "step_up_challenges_nonce_key" ON "step_up_challenges"("nonce");

-- CreateIndex
CREATE INDEX "step_up_challenges_user_id_action_idx" ON "step_up_challenges"("user_id", "action");

-- CreateIndex
CREATE INDEX "step_up_challenges_expires_at_idx" ON "step_up_challenges"("expires_at");

-- CreateTable: policy-based administrative roles
CREATE TABLE "admin_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_name_key" ON "admin_roles"("name");

-- CreateTable: permissions granted to administrative roles
CREATE TABLE "admin_role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_permissions_role_id_permission_key" ON "admin_role_permissions"("role_id", "permission");

-- CreateIndex
CREATE INDEX "admin_role_permissions_permission_idx" ON "admin_role_permissions"("permission");

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: assignment of administrative roles to users
CREATE TABLE "admin_role_assignments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_by" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "admin_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_assignments_user_id_role_id_key" ON "admin_role_assignments"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "admin_role_assignments_user_id_idx" ON "admin_role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "admin_role_assignments_role_id_idx" ON "admin_role_assignments"("role_id");

-- AddForeignKey
ALTER TABLE "admin_role_assignments" ADD CONSTRAINT "admin_role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: audit trail for sensitive administrative decisions
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "payload_hash" TEXT,
    "step_up_challenge_id" TEXT,
    "outcome" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_logs_actor_id_idx" ON "admin_audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_type_target_id_idx" ON "admin_audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_step_up_challenge_id_fkey" FOREIGN KEY ("step_up_challenge_id") REFERENCES "step_up_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default administrative roles and their permissions (idempotent)
INSERT INTO "admin_roles" ("id", "name", "description", "created_at", "updated_at")
VALUES
    ('role_admin_read', 'admin_read', 'Read-only access to administrative resources', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('role_admin_operator', 'admin_operator', 'Operational administrative actions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('role_admin_config', 'admin_config', 'Configuration-changing administrative actions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "admin_role_permissions" ("id", "role_id", "permission", "created_at")
VALUES
    ('perm_admin_read_read', 'role_admin_read', 'admin:read', CURRENT_TIMESTAMP),
    ('perm_admin_operator_read', 'role_admin_operator', 'admin:read', CURRENT_TIMESTAMP),
    ('perm_admin_operator_operate', 'role_admin_operator', 'admin:operate', CURRENT_TIMESTAMP),
    ('perm_admin_config_read', 'role_admin_config', 'admin:read', CURRENT_TIMESTAMP),
    ('perm_admin_config_operate', 'role_admin_config', 'admin:operate', CURRENT_TIMESTAMP),
    ('perm_admin_config_configure', 'role_admin_config', 'admin:configure', CURRENT_TIMESTAMP)
ON CONFLICT ("role_id", "permission") DO NOTHING;