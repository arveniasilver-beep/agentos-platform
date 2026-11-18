import { describe, it, expect } from 'vitest';
import { createImageProvider, createSpeechProvider } from './media';

describe('media providers', () => {
  it('mock image provider returns a deterministic SVG embedding the prompt', async () => {
    const p = createImageProvider({ provider: 'mock' });
    const a = await p.generate('a red cube');
    expect(a.ext).toBe('svg');
    expect(a.contentType).toBe('image/svg+xml');
    expect(a.data.toString('utf8')).toContain('a red cube');
    expect(a.data.toString('utf8').startsWith('<svg')).toBe(true);
  });

  it('mock image provider strips markup-significant chars from the prompt', async () => {
    const p = createImageProvider({ provider: 'mock' });
    const a = await p.generate('<script>&bad');
    const svg = a.data.toString('utf8');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('&bad');
  });

  it('mock speech provider returns a valid WAV', async () => {
    const p = createSpeechProvider({ provider: 'mock' });
    const a = await p.synthesize('hello');
    expect(a.ext).toBe('wav');
    expect(a.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(a.data.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  it('real providers require an API key', () => {
    expect(() => createImageProvider({ provider: 'openai' })).toThrow(/API key/);
    expect(() => createImageProvider({ provider: 'gemini' })).toThrow(/API key/);
    expect(() => createSpeechProvider({ provider: 'openai' })).toThrow(/API key/);
  });

  it('provider ids encode provider + model', () => {
    expect(createImageProvider({ provider: 'openai', apiKey: 'k', model: 'dall-e-3' }).id).toBe('openai:dall-e-3');
    expect(createSpeechProvider({ provider: 'openai', apiKey: 'k', model: 'tts-1-hd' }).id).toBe('openai:tts-1-hd');
  });
});
