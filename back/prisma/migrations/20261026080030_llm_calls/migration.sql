-- CreateEnum
CREATE TYPE "LlmCallStatus" AS ENUM ('Ok', 'Error');

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conversationId" TEXT,
    "parentId" TEXT,
    "status" "LlmCallStatus" NOT NULL,
    "finishReason" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedTokens" INTEGER,
    "costUsd" DECIMAL(65,30),
    "latencyMs" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCall_conversationId_idx" ON "LlmCall"("conversationId");

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LlmCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
