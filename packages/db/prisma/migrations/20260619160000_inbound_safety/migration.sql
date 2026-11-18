-- Inbound-email safety: per-address task risk ceiling (default 'low' so untrusted email can't
-- auto-run risky tools) + an optional per-task cost ceiling for email-created tasks.
ALTER TABLE "inbound_addresses" ADD COLUMN "taskRiskCeiling" TEXT NOT NULL DEFAULT 'low';
ALTER TABLE "inbound_addresses" ADD COLUMN "taskCostBudgetUsd" DECIMAL(14, 6);
