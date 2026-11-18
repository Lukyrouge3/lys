-- The agent claims a pending approval before running the tool, so a crash
-- between the claim and the result stays visible instead of looking decided.
ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'executing';

-- A run that started and did not finish is reported, not silently forgotten.
ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'failed';
