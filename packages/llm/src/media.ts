/**
 * Pluggable media generation (images + speech). Anthropic doesn't generate images/audio, so — exactly
 * like the embeddings layer — a workspace configures a provider (provider + key) and the agent's
 * generate_image / generate_speech tools use it. Keys live in the encrypted secrets vault and are
 * decrypted server-side only. A keyless `mock` provider produces a tiny deterministic asset so the
 * plumbing is testable without any API key (real output requires a configured provider).
 */

export type ImageProviderKind = 'openai' | 'gemini' | 'mock';
export type SpeechProviderKind = 'openai' | 'mock';

export interface ImageConfig {
  provider: ImageProviderKind;
  apiKey?: string;
  /** Model override (e.g. gpt-image-1, dall-e-3, imagen-3.0-generate-002). */
  model?: string;
  /** For OpenAI-compatible image endpoints. */
  baseUrl?: string;
}

export interface SpeechConfig {
  provider: SpeechProviderKind;
  apiKey?: string;
  /** Model override (e.g. tts-1, tts-1-hd). */
  model?: string;
  /** Voice override (e.g. alloy, verse). */
  voice?: string;
  baseUrl?: string;
}

export interface GeneratedAsset {
  data: Buffer;
  contentType: string;
  /** File extension without the dot (png/svg/mp3/wav). */
  ext: string;
}

export interface ImageProvider {
  readonly id: string;
  generate(prompt: string, opts?: { size?: string }): Promise<GeneratedAsset>;
}

export interface SpeechProvider {
  readonly id: string;
  synthesize(text: string): Promise<GeneratedAsset>;
}

async function postForJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`media request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// --------------------------------------------------------------------------------------------- images

/** OpenAI Images (gpt-image-1 default; dall-e-* supported). Returns base64 PNG. */
class OpenAiImageProvider implements ImageProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-image-1',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    this.id = `openai:${model}`;
  }
  async generate(prompt: string, opts?: { size?: string }): Promise<GeneratedAsset> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      n: 1,
      size: opts?.size ?? '1024x1024',
    };
    // dall-e returns a URL unless asked for b64; gpt-image-1 always returns b64 and rejects the param.
    if (this.model.startsWith('dall-e')) body.response_format = 'b64_json';
    const json = (await postForJson(
      `${this.baseUrl.replace(/\/$/, '')}/images/generations`,
      { authorization: `Bearer ${this.apiKey}` },
      body,
    )) as { data?: { b64_json?: string }[] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('image provider returned no image data');
    return { data: Buffer.from(b64, 'base64'), contentType: 'image/png', ext: 'png' };
  }
}

/** Google Imagen (via the Generative Language predict endpoint). Returns base64 PNG. */
class GeminiImageProvider implements ImageProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'imagen-3.0-generate-002',
  ) {
    this.id = `gemini:${model}`;
  }
  async generate(prompt: string): Promise<GeneratedAsset> {
    const json = (await postForJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:predict?key=${this.apiKey}`,
      {},
      { instances: [{ prompt }], parameters: { sampleCount: 1 } },
    )) as { predictions?: { bytesBase64Encoded?: string }[] };
    const b64 = json.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('image provider returned no image data');
    return { data: Buffer.from(b64, 'base64'), contentType: 'image/png', ext: 'png' };
  }
}

/** Keyless mock: a deterministic SVG embedding the prompt — for tests and plumbing, not real art. */
class MockImageProvider implements ImageProvider {
  readonly id = 'mock:image';
  generate(prompt: string): Promise<GeneratedAsset> {
    const safe = prompt.replace(/[&<>]/g, '').slice(0, 80);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1a1a2e"/><text x="256" y="256" fill="#9aa" font-size="18" text-anchor="middle">${safe}</text></svg>`;
    return Promise.resolve({ data: Buffer.from(svg, 'utf8'), contentType: 'image/svg+xml', ext: 'svg' });
  }
}

export function createImageProvider(config: ImageConfig): ImageProvider {
  switch (config.provider) {
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI image generation requires an API key.');
      return new OpenAiImageProvider(config.apiKey, config.model, config.baseUrl);
    case 'gemini':
      if (!config.apiKey) throw new Error('Gemini image generation requires an API key.');
      return new GeminiImageProvider(config.apiKey, config.model);
    case 'mock':
      return new MockImageProvider();
    default:
      throw new Error(`Unknown image provider: ${String(config.provider)}`);
  }
}

// --------------------------------------------------------------------------------------------- speech

/** OpenAI text-to-speech (tts-1 default). Returns MP3 bytes. */
class OpenAiSpeechProvider implements SpeechProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'tts-1',
    private readonly voice = 'alloy',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    this.id = `openai:${model}`;
  }
  async synthesize(text: string): Promise<GeneratedAsset> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text, voice: this.voice }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`speech request failed (${res.status}): ${t.slice(0, 300)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, contentType: 'audio/mpeg', ext: 'mp3' };
  }
}

/** Keyless mock: a minimal valid (silent) WAV — for tests and plumbing, not real speech. */
class MockSpeechProvider implements SpeechProvider {
  readonly id = 'mock:speech';
  synthesize(): Promise<GeneratedAsset> {
    // 44-byte WAV header + a few silent PCM samples (16-bit mono 8kHz).
    const samples = 8;
    const dataLen = samples * 2;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(8000, 24); // sample rate
    buf.writeUInt32LE(16000, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    return Promise.resolve({ data: buf, contentType: 'audio/wav', ext: 'wav' });
  }
}

export function createSpeechProvider(config: SpeechConfig): SpeechProvider {
  switch (config.provider) {
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI speech requires an API key.');
      return new OpenAiSpeechProvider(config.apiKey, config.model, config.voice, config.baseUrl);
    case 'mock':
      return new MockSpeechProvider();
    default:
      throw new Error(`Unknown speech provider: ${String(config.provider)}`);
  }
}
