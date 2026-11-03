-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied');

-- DropForeignKey
ALTER TABLE "LlmCall" DROP CONSTRAINT "LlmCall_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "ToolCall" DROP CONSTRAINT "ToolCall_messageId_fkey";

-- AlterTable
ALTER TABLE "ToolCall" ADD COLUMN     "approval" "ApprovalStatus",
ADD COLUMN     "decidedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
