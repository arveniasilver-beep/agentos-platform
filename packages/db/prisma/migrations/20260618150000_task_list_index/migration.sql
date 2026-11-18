-- Back the default/archived task-list read path: filter on (workspaceId, archivedAt) and sort by
-- (favorite desc, createdAt desc) without a workspace scan + in-memory sort.
CREATE INDEX "tasks_workspaceId_archivedAt_favorite_createdAt_idx"
  ON "tasks"("workspaceId", "archivedAt", "favorite", "createdAt");
