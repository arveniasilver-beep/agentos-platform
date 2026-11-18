-- Add the embeddings-config secret type (per-workspace embeddings provider + key for knowledge/RAG).
ALTER TYPE "SecretType" ADD VALUE IF NOT EXISTS 'embeddings_config';
