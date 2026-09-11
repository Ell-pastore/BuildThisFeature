-- CreateTable
CREATE TABLE "ai_host_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "round" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "executed_at" TIMESTAMPTZ,

    CONSTRAINT "ai_host_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_host_executions_user_id_status_created_at_idx" ON "ai_host_executions"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_host_executions_conversation_id_created_at_idx" ON "ai_host_executions"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_host_executions_message_id_idx" ON "ai_host_executions"("message_id");

-- AddForeignKey
ALTER TABLE "ai_host_executions" ADD CONSTRAINT "ai_host_executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_host_executions" ADD CONSTRAINT "ai_host_executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_host_executions" ADD CONSTRAINT "ai_host_executions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- ai_host_executions — SCHEMA.md §6.9
-- ----------------------------------------------------------------------------
-- Closed host-execution state domain. Transitions are application-enforced
-- (pending → executed | expired; §6.9). `executed` is a single-use seal: the
-- host's result is submitted exactly once and the record can never authorize
-- a second execution.
ALTER TABLE "ai_host_executions" ADD CONSTRAINT "ai_host_executions_status_check"
  CHECK ("status" IN ('pending', 'executed', 'expired'));
-- Pending-execution queue by owner ordered by expiry (§6.9): serves both the
-- per-user pending list and the expiry sweep (status = 'pending' AND
-- expires_at <= now()).
CREATE INDEX "ai_host_executions_user_id_pending_idx"
  ON "ai_host_executions" ("user_id", "expires_at") WHERE "status" = 'pending';