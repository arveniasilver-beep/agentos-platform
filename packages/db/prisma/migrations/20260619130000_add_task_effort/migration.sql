-- Per-task reasoning effort tier (low|medium|high|max), mapped to the model's effort parameter.
-- Null = the default (high).
ALTER TABLE "tasks" ADD COLUMN "effort" TEXT;
