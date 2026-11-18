-- Policy Engine + Approval hardening (TICKET-POLICY). FULLY ADDITIVE: two new columns on
-- `approvals`. No existing table/column/index/policy/event-type is altered. Inert unless
-- POLICY_ENGINE_ENABLED=true (elevated stays false / policyReason null for legacy approvals).

ALTER TABLE "approvals" ADD COLUMN "elevated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "approvals" ADD COLUMN "policyReason" TEXT;
