-- Task management (Manus-style): favorite/pin a task and archive it (hide from the default list).
ALTER TABLE "tasks" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "archivedAt" TIMESTAMP(3);
