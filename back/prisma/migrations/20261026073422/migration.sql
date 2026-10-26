/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Secret` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Provider_name_key" ON "Provider"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_name_key" ON "Secret"("name");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
