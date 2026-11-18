-- Device Sync Foundation (TICKET-5). FULLY ADDITIVE: one new table for long-lived Bearer device
-- credentials (user-scoped, like sessions). No existing table is altered. Inert unless DEVICE_SYNC_ENABLED.

CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'desktop',
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "devices_tokenHash_key" ON "devices"("tokenHash");
CREATE INDEX "devices_userId_revokedAt_idx" ON "devices"("userId", "revokedAt");

ALTER TABLE "devices"
    ADD CONSTRAINT "devices_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
