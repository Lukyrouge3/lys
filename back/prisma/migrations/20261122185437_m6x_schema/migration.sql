-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'review';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "prepAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prepFolder" TEXT,
ADD COLUMN     "prepNote" TEXT,
ADD COLUMN     "preparedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MailNote" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "topic" TEXT NOT NULL DEFAULT '',
    "importance" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDraft" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "draftedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailProposal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "moves" JSONB NOT NULL,
    "summary" TEXT NOT NULL,

    CONSTRAINT "MailProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailNote_receivedAt_idx" ON "MailNote"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailNote_accountId_folder_uid_key" ON "MailNote"("accountId", "folder", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "MailDraft_accountId_folder_uid_key" ON "MailDraft"("accountId", "folder", "uid");

-- AddForeignKey
ALTER TABLE "MailNote" ADD CONSTRAINT "MailNote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDraft" ADD CONSTRAINT "MailDraft_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
