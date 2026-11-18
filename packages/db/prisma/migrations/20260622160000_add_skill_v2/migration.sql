-- Skills/Playbooks v2 (TICKET-4). FULLY ADDITIVE: four nullable/defaulted columns on skills for typed
-- params, versioning, and capability/effort passthrough. No existing column/index is altered. Inert
-- unless SKILLS_PLAYBOOKS_V2_ENABLED (legacy skill rows + flag-off behavior unchanged).

ALTER TABLE "skills" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "skills" ADD COLUMN "params" JSONB;
ALTER TABLE "skills" ADD COLUMN "capability" TEXT;
ALTER TABLE "skills" ADD COLUMN "effort" TEXT;
