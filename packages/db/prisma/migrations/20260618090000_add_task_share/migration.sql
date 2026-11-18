-- Public read-only share: an opaque token that lets anyone replay a run without auth.
ALTER TABLE "tasks" ADD COLUMN "shareId" TEXT;

CREATE UNIQUE INDEX "tasks_shareId_key" ON "tasks"("shareId");
