import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { imageDataUrl, transcribeAudio } from './media-enrichment.js';

const mutable = config as unknown as Record<string, unknown>;
const saved = {
  AI_BASE_URL: config.AI_BASE_URL, AI_API_KEY: config.AI_API_KEY,
  AI_TRANSCRIPTION_MODEL: config.AI_TRANSCRIPTION_MODEL, SHADOW_AUDIO_MAX_BYTES: config.SHADOW_AUDIO_MAX_BYTES
};

beforeEach(() => Object.assign(mutable, saved));
afterEach(() => Object.assign(mutable, saved));

describe('audio transcription', () => {
  it('uses the dedicated multipart transcription endpoint', async () => {
    Object.assign(mutable, {
      AI_BASE_URL: 'https://api.openai.test/v1', AI_API_KEY: 'secret',
      AI_TRANSCRIPTION_MODEL: 'gpt-transcribe', SHADOW_AUDIO_MAX_BYTES: 25_000_000
    });
    let url = '';
    let init: RequestInit | undefined;
    const result = await transcribeAudio(
      { kind: 'audio', mimeType: 'audio/ogg', bytes: new Uint8Array([1, 2, 3]) },
      async (input, request) => {
        url = String(input); init = request;
        return new Response(JSON.stringify({ text: 'БпЛА курсом на Київ' }), { status: 200 });
      },
      async (bytes) => bytes
    );
    expect(result).toEqual({ ok: true, text: 'БпЛА курсом на Київ' });
    expect(url).toBe('https://api.openai.test/v1/audio/transcriptions');
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('rejects oversized audio before making a request', async () => {
    Object.assign(mutable, {
      AI_BASE_URL: 'https://api.openai.test/v1', AI_API_KEY: 'secret',
      AI_TRANSCRIPTION_MODEL: 'gpt-transcribe', SHADOW_AUDIO_MAX_BYTES: 2
    });
    let called = false;
    const result = await transcribeAudio(
      { kind: 'audio', mimeType: 'audio/ogg', bytes: new Uint8Array([1, 2, 3]) },
      async () => { called = true; return new Response('{}'); },
      async (bytes) => bytes
    );
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(called).toBe(false);
  });
});

describe('image input', () => {
  it('accepts supported bounded images as data URLs', () => {
    expect(imageDataUrl({ kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([1, 2]) }))
      .toBe('data:image/png;base64,AQI=');
  });
});
