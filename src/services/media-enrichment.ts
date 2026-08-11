import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { MessageMediaAttachment } from '../types.js';

const execFileAsync = promisify(execFile);

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/mpga', 'audio/m4a', 'audio/wav', 'audio/webm', 'audio/ogg',
  'video/mp4', 'video/mpeg', 'video/webm'
]);

export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  reason?: 'not_configured' | 'unsupported_type' | 'too_large' | 'transport_error' | 'endpoint_error';
}

async function convertTelegramVoice(bytes: Uint8Array): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'threatlens-audio-'));
  const source = join(directory, 'voice.ogg');
  const output = join(directory, 'voice.webm');
  try {
    await writeFile(source, bytes);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
      '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '32k', output
    ], { timeout: config.AI_TIMEOUT_MS, maxBuffer: 256_000 });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Transcribes a bounded Telegram voice/audio attachment through the OpenAI-compatible audio API.
 * This output is advisory model input only; callers must never feed it to the deterministic live
 * classifier. Telegram voice notes arrive as OGG/Opus, so they are converted to the documented
 * WebM input format before upload.
 */
export async function transcribeAudio(
  media: MessageMediaAttachment,
  fetchImpl: typeof fetch = fetch,
  convertOgg: (bytes: Uint8Array) => Promise<Uint8Array> = convertTelegramVoice
): Promise<TranscriptionResult> {
  if (!config.AI_BASE_URL || !config.AI_API_KEY || !config.AI_TRANSCRIPTION_MODEL) {
    return { ok: false, reason: 'not_configured' };
  }
  if (media.kind !== 'audio' || !AUDIO_TYPES.has(media.mimeType)) {
    return { ok: false, reason: 'unsupported_type' };
  }
  if (media.bytes.byteLength > config.SHADOW_AUDIO_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  let uploadBytes = media.bytes;
  let uploadType = media.mimeType;
  let uploadName = media.fileName ?? 'telegram-audio.webm';
  if (media.mimeType === 'audio/ogg') {
    try {
      uploadBytes = await convertOgg(media.bytes);
      uploadType = 'audio/webm';
      uploadName = 'telegram-voice.webm';
    } catch {
      return { ok: false, reason: 'transport_error' };
    }
    if (uploadBytes.byteLength > config.SHADOW_AUDIO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  }

  const form = new FormData();
  form.append('model', config.AI_TRANSCRIPTION_MODEL);
  form.append('language', 'uk');
  form.append('prompt', 'Повітряні загрози в Україні: БпЛА, шахед, ракета, балістика, курс, напрямок, область.');
  const ownedBytes = new Uint8Array(uploadBytes.byteLength);
  ownedBytes.set(uploadBytes);
  form.append('file', new Blob([ownedBytes.buffer], { type: uploadType }), uploadName);
  let response: Response;
  try {
    response = await fetchImpl(`${config.AI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.AI_API_KEY}` }, body: form,
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS)
    });
  } catch {
    return { ok: false, reason: 'transport_error' };
  }
  if (!response.ok) return { ok: false, reason: 'endpoint_error' };
  try {
    const body = await response.json() as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    return text ? { ok: true, text } : { ok: false, reason: 'endpoint_error' };
  } catch {
    return { ok: false, reason: 'endpoint_error' };
  }
}

export function imageDataUrl(media: MessageMediaAttachment): string | null {
  if (media.kind !== 'image' || !/^image\/(?:jpeg|png|webp|gif)$/u.test(media.mimeType)) return null;
  if (media.bytes.byteLength > config.SHADOW_IMAGE_MAX_BYTES) return null;
  return `data:${media.mimeType};base64,${Buffer.from(media.bytes).toString('base64')}`;
}
