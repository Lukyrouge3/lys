/*
  Warnings:

  - A unique constraint covering the columns `[platform,externalId]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('discord');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "platform" "Platform";

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_platform_externalId_key" ON "Conversation"("platform", "externalId");
