/*
  Warnings:

  - The values [tool] on the enum `MessageRole` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `toolCallId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `toolCalls` on the `Message` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "MessageRole_new" AS ENUM ('user', 'assistant', 'system');
ALTER TABLE "Message" ALTER COLUMN "role" TYPE "MessageRole_new" USING ("role"::text::"MessageRole_new");
ALTER TYPE "MessageRole" RENAME TO "MessageRole_old";
ALTER TYPE "MessageRole_new" RENAME TO "MessageRole";
DROP TYPE "public"."MessageRole_old";
COMMIT;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "toolCallId",
DROP COLUMN "toolCalls";

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "apiId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "arguments" TEXT NOT NULL,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
