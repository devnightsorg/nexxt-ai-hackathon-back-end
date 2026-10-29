-- Agent mandates: an API key issued through the OAuth connect flow carries the signed terms and an expiry.
ALTER TABLE "ApiKey" ADD COLUMN "mandate" JSONB,
ADD COLUMN "expiresAt" TIMESTAMP(3);
