-- Capability mode: primes a task's agent for a specific deliverable type
-- (slides/website/document/spreadsheet/chart/image/chat). Null = general autonomous agent.
ALTER TABLE "tasks" ADD COLUMN "capability" TEXT;
