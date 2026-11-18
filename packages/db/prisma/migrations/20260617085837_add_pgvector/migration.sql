-- Enable pgvector. Must run before any column of type vector(...).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "vector_documents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vector_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vector_documents_workspaceId_ownerType_idx" ON "vector_documents"("workspaceId", "ownerType");

-- HNSW index for approximate cosine-similarity KNN over the embedding column.
CREATE INDEX "vector_documents_embedding_hnsw" ON "vector_documents" USING hnsw ("embedding" vector_cosine_ops);
