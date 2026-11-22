-- CreateTable
CREATE TABLE "ScheduledRun" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledRun_pkey" PRIMARY KEY ("name")
);
