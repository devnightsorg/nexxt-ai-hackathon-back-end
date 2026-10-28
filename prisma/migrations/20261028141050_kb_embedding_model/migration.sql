-- AlterTable: which embedding model produced the document's chunk vectors (NULL = unknown, re-embed).
ALTER TABLE "KbDocument" ADD COLUMN "embeddingModel" TEXT;
