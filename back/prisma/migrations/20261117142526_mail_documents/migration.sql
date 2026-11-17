-- CreateTable
CREATE TABLE "MailDocument" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailDocument_sha256_key" ON "MailDocument"("sha256");

-- CreateIndex
CREATE INDEX "MailDocument_receivedAt_idx" ON "MailDocument"("receivedAt");

-- CreateIndex
CREATE INDEX "MailDocument_accountId_folder_uid_idx" ON "MailDocument"("accountId", "folder", "uid");

-- AddForeignKey
ALTER TABLE "MailDocument" ADD CONSTRAINT "MailDocument_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
