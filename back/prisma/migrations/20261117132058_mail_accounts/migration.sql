-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "username" TEXT NOT NULL,
    "passwordId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailFolder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "uidValidity" BIGINT,
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_name_key" ON "MailAccount"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_address_key" ON "MailAccount"("address");

-- CreateIndex
CREATE UNIQUE INDEX "MailFolder_accountId_path_key" ON "MailFolder"("accountId", "path");

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_passwordId_fkey" FOREIGN KEY ("passwordId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailFolder" ADD CONSTRAINT "MailFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
