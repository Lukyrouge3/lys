-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'preparing', 'ready', 'applied', 'interview', 'rejected', 'dropped');

-- CreateEnum
CREATE TYPE "JobRank" AS ENUM ('apply', 'maybe', 'skip');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "rank" "JobRank",
    "rankReason" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "notifiedAt" TIMESTAMP(3),
    "inboxWrittenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_rank_idx" ON "Job"("status", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "Job_source_externalId_key" ON "Job"("source", "externalId");
