-- Tool Execution Hardening (TICKET-2). FULLY ADDITIVE: one nullable column on tool_calls to record the
-- tool implementation version at call time. No existing column/index/constraint is altered. Inert until
-- the engine emits a version (existing rows + flag-off behavior are unaffected).

ALTER TABLE "tool_calls" ADD COLUMN "toolVersion" TEXT;
