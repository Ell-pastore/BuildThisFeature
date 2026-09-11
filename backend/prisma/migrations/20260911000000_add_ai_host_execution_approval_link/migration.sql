-- AlterTable: link a host execution to the approving tool approval (§6.9).
-- `approval_id` is set ONLY for APPROVED WRITES that run on the desktop host
-- (today: move_file). The submit path seals the execution AND consumes the
-- approval together, so a single approved operation can never run twice.
ALTER TABLE "ai_host_executions" ADD COLUMN "approval_id" UUID;

-- AddForeignKey
ALTER TABLE "ai_host_executions" ADD CONSTRAINT "ai_host_executions_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "ai_tool_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex: per-conversation approval-linked pending lookup (§6.9).
CREATE INDEX "ai_host_executions_approval_id_idx" ON "ai_host_executions"("approval_id");

-- ----------------------------------------------------------------------------
-- ai_host_executions.approval_id — SCHEMA.md §6.9 (single-use enforcement)
-- ----------------------------------------------------------------------------
-- At most ONE PENDING execable execution per approval. Combined with the
-- application-level consume-the-approval-on-seal rule (§6.9), this makes the
-- "approve once, runs exactly once" guarantee robust even across racing resume
-- attempts: a second resume cannot create a second pending execution, and the
-- approval is consumed the moment any of them seals.
CREATE UNIQUE INDEX "ai_host_executions_approval_id_pending_unique"
  ON "ai_host_executions" ("approval_id") WHERE "approval_id" IS NOT NULL AND "status" = 'pending';