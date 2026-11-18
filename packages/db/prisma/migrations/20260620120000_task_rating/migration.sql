-- User's 1-5 star rating of a task result (Manus-style feedback). Null = unrated.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "rating" INTEGER;
