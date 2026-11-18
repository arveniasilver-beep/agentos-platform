import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, tenantRawExec, tenantRawQuery } from '@agentos/db';
import { createEmbeddingsProvider, padEmbedding, EMBEDDING_DIM, type EmbeddingsConfig } from '@agentos/llm';
import { assertAllowedUrl } from '@agentos/tools';
import { SecretsService } from '../secrets/secrets.service';

/** No-key default so knowledge works out of the box (lexical similarity); configure a real provider. */
const DEFAULT_CONFIG: EmbeddingsConfig = { provider: 'local' };

export interface KnowledgeHit {
  id: string;
  content: string;
  score: number;
  ownerType: string;
  title: string | null;
}

export interface KnowledgeDoc {
  title: string;
  ownerType: string;
  chunks: number;
}

/**
 * Knowledge / RAG store over pgvector. Documents are chunked, embedded via the workspace's
 * configured provider, and stored in vector_documents; search is cosine KNN restricted to the
 * workspace AND the embedding model that produced the rows (so different providers, padded to a
 * common dimension, are never compared against each other). All raw SQL binds the tenant GUC.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly secrets: SecretsService) {}

  private async provider(workspaceId: string) {
    const config = (await this.secrets.getEmbeddingsConfig(workspaceId)) ?? DEFAULT_CONFIG;
    // SSRF guard: a custom (OpenAI-compatible) baseUrl must not point at an internal/loopback host —
    // we POST the decrypted key to it.
    if (config.baseUrl) {
      try {
        await assertAllowedUrl(config.baseUrl);
      } catch (err) {
        throw new BadRequestException(
          `Embeddings baseUrl is not allowed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return createEmbeddingsProvider(config);
  }

  private chunk(text: string, size = 1200, overlap = 150): string[] {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length === 0) return [];
    if (clean.length <= size) return [clean];
    const out: string[] = [];
    for (let i = 0; i < clean.length; i += size - overlap) out.push(clean.slice(i, i + size));
    return out;
  }

  private toVectorLiteral(vec: number[]): string {
    return `[${padEmbedding(vec, EMBEDDING_DIM)
      .map((x) => (Number.isFinite(x) ? x : 0))
      .join(',')}]`;
  }

  /** Ingest a document: chunk -> embed -> store. Returns the number of chunks and the model used. */
  async ingest(
    workspaceId: string,
    ownerType: string,
    title: string,
    content: string,
  ): Promise<{ chunks: number; model: string }> {
    const provider = await this.provider(workspaceId);
    const chunks = this.chunk(content);
    if (chunks.length === 0) return { chunks: 0, model: provider.id };
    const vectors = await provider.embed(chunks);
    for (let i = 0; i < chunks.length; i += 1) {
      const metadata = JSON.stringify({ model: provider.id, title, chunk: i });
      const lit = this.toVectorLiteral(vectors[i] ?? []);
      await tenantRawExec(Prisma.sql`
        INSERT INTO vector_documents (id, "workspaceId", "ownerType", "ownerId", content, embedding, metadata, "createdAt")
        VALUES (${randomUUID()}, ${workspaceId}, ${ownerType}, ${null}, ${chunks[i]}, ${lit}::vector, ${metadata}::jsonb, now())
      `);
    }
    return { chunks: chunks.length, model: provider.id };
  }

  /** Cosine KNN, restricted to the workspace and the current provider's model. */
  async search(workspaceId: string, query: string, topK = 5): Promise<KnowledgeHit[]> {
    const provider = await this.provider(workspaceId);
    const [vec] = await provider.embed([query]);
    if (!vec) return [];
    const lit = this.toVectorLiteral(vec);
    const k = Math.max(1, Math.min(20, topK));
    const rows = await tenantRawQuery<{
      id: string;
      content: string;
      score: number;
      ownerType: string;
      title: string | null;
    }>(Prisma.sql`
      SELECT id, content, "ownerType", metadata->>'title' AS title,
             1 - (embedding <=> ${lit}::vector) AS score
      FROM vector_documents
      WHERE "workspaceId" = ${workspaceId} AND metadata->>'model' = ${provider.id}
      ORDER BY embedding <=> ${lit}::vector
      LIMIT ${k}
    `);
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      score: Number(r.score),
      ownerType: r.ownerType,
      title: r.title,
    }));
  }

  /** List ingested documents (grouped by title), for the knowledge UI. */
  async list(workspaceId: string): Promise<KnowledgeDoc[]> {
    const rows = await tenantRawQuery<{ title: string | null; ownertype: string; chunks: bigint }>(Prisma.sql`
      SELECT metadata->>'title' AS title, "ownerType" AS ownertype, count(*) AS chunks
      FROM vector_documents
      WHERE "workspaceId" = ${workspaceId}
      GROUP BY metadata->>'title', "ownerType"
      ORDER BY max("createdAt") DESC
      LIMIT 200
    `);
    return rows.map((r) => ({ title: r.title ?? '(untitled)', ownerType: r.ownertype, chunks: Number(r.chunks) }));
  }

  async deleteByTitle(workspaceId: string, title: string): Promise<number> {
    return tenantRawExec(
      Prisma.sql`DELETE FROM vector_documents WHERE "workspaceId" = ${workspaceId} AND metadata->>'title' = ${title}`,
    );
  }
}
