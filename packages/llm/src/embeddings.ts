/**
 * Pluggable text-embeddings abstraction. Anthropic doesn't produce embeddings, so the platform
 * supports several providers; a workspace configures one (provider + key) and the knowledge/RAG
 * layer uses it. All vectors are padded to a common storage dimension (see EMBEDDING_DIM) so a
 * single pgvector HNSW index serves every provider — searches always filter to the SAME model, so
 * different providers are never compared against each other.
 */

/** The fixed pgvector column dimension (vector_documents.embedding). Providers pad up to this. */
export const EMBEDDING_DIM = 1536;

export type EmbeddingsProviderKind = 'openai' | 'voyage' | 'gemini' | 'local';

export interface EmbeddingsConfig {
  provider: EmbeddingsProviderKind;
  apiKey?: string;
  /** Optional model override. */
  model?: string;
  /** For OpenAI-COMPATIBLE servers (DeepSeek, local OpenAI-style, Together, …). */
  baseUrl?: string;
}

export interface EmbeddingsProvider {
  /** Stable identifier (provider:model) stored alongside each vector so we only compare like-for-like. */
  readonly id: string;
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Zero-pad (or truncate) to the storage dimension. Zero-padding preserves cosine similarity
 * within a provider (every one of its vectors gets the same padding), so KNN stays correct. */
export function padEmbedding(vec: number[], dim = EMBEDDING_DIM): number[] {
  if (vec.length === dim) return vec;
  if (vec.length > dim) return vec.slice(0, dim);
  return [...vec, ...new Array<number>(dim - vec.length).fill(0)];
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`embeddings request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** OpenAI and OpenAI-compatible (DeepSeek, local servers via baseUrl). */
class OpenAiEmbeddings implements EmbeddingsProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'text-embedding-3-small',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    this.id = `openai:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const json = (await postJson(
      `${this.baseUrl.replace(/\/$/, '')}/embeddings`,
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, input: texts, dimensions: EMBEDDING_DIM },
    )) as { data?: { embedding: number[] }[] };
    return (json.data ?? []).map((d) => d.embedding);
  }
}

/** Voyage AI (Anthropic-recommended). OpenAI-shaped response. */
class VoyageEmbeddings implements EmbeddingsProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'voyage-3',
  ) {
    this.id = `voyage:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const json = (await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, input: texts },
    )) as { data?: { embedding: number[] }[] };
    return (json.data ?? []).map((d) => d.embedding);
  }
}

/** Google Gemini embeddings. */
class GeminiEmbeddings implements EmbeddingsProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'text-embedding-004',
  ) {
    this.id = `gemini:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const json = (await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {},
      {
        requests: texts.map((t) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text: t }] },
        })),
      },
    )) as { embeddings?: { values: number[] }[] };
    return (json.embeddings ?? []).map((e) => e.values);
  }
}

/**
 * Keyless local fallback: a deterministic hashed bag-of-words embedding. NOT semantic — it captures
 * lexical (shared-term) similarity only — but needs no API key and no model download, so knowledge
 * search works out of the box and in tests. Configure a real provider for semantic quality.
 */
class LocalEmbeddings implements EmbeddingsProvider {
  readonly id = 'local:hash';
  private readonly dim = 512;
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.hashEmbed(t)));
  }
  private hashEmbed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i += 1) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** Build an embeddings provider from a workspace's configuration. */
export function createEmbeddingsProvider(config: EmbeddingsConfig): EmbeddingsProvider {
  switch (config.provider) {
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI embeddings require an API key.');
      return new OpenAiEmbeddings(config.apiKey, config.model, config.baseUrl);
    case 'voyage':
      if (!config.apiKey) throw new Error('Voyage embeddings require an API key.');
      return new VoyageEmbeddings(config.apiKey, config.model);
    case 'gemini':
      if (!config.apiKey) throw new Error('Gemini embeddings require an API key.');
      return new GeminiEmbeddings(config.apiKey, config.model);
    case 'local':
      return new LocalEmbeddings();
    default:
      throw new Error(`Unknown embeddings provider: ${String(config.provider)}`);
  }
}
