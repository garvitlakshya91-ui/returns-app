-- Unfinished-label recovery: attempts so far and when the sweep may try again
-- (exponential backoff), so one failing label is retried less and less often
-- and never crowds out labels that have not been tried yet.
ALTER TABLE "ReturnLabel"
  ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextRecoveryAt"   TIMESTAMP(3);

CREATE INDEX "ReturnLabel_status_nextRecoveryAt_idx" ON "ReturnLabel"("status", "nextRecoveryAt");
