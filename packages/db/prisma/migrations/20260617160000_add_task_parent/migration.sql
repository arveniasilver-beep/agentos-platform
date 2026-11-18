-- Wide Research: link sub-agent tasks to the parent task that spawned them.
ALTER TABLE "tasks" ADD COLUMN "parentTaskId" TEXT;

CREATE INDEX "tasks_parentTaskId_idx" ON "tasks"("parentTaskId");

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_parentTaskId_fkey"
  FOREIGN KEY ("parentTaskId") REFERENCES "tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
