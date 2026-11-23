/**
 * Speech-to-text for call recordings, on Workers AI.
 *
 * - Speakers: Deepgram Nova-3 (`@cf/deepgram/nova-3`, diarize) labels who spoke ("Speaker 1",
 *   "Speaker 2" …). It takes the audio as a stream, so long recordings can go in one request.
 * - Fallback: Whisper (`@cf/openai/whisper-large-v3-turbo`) — no speakers, ~25 MB per request.
 * - Long recordings Whisper cannot take in one go are split: MP3 at frame boundaries and WAV with a
 *   fresh header, here on the server; any other format is decoded in the browser and sent back as
 *   WAV parts (see `call_transcript_parts`), each transcribed with its time offset.
 */
import type { Env } from '../env';

export const NOVA = '@cf/deepgram/nova-3';
export const WHISPER = '@cf/openai/whisper-large-v3-turbo';
/** Whisper on Workers AI takes up to ~25 MB of audio in one request. */
export const WHISPER_MAX = 25 * 1024 * 1024;
/** Size of the parts long recordings are cut into. */
export const PART_BYTES = 20 * 1024 * 1024;

export interface Segment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}
export interface SpeechResult {
  segments: Segment[] | null;
  engine: 'nova-3' | 'whisper' | null;
  reason: string | null;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Deepgram's response → segments: utterances when given, else words grouped by speaker. */
export function novaSegments(out: any, offset = 0, prefix = ''): Segment[] {
  const r = out?.result ?? out?.results ?? out;
  const label = (n: unknown) => (n === undefined || n === null ? null : `${prefix}Speaker ${Number(n) + 1}`);
  const utts = r?.utterances as { start: number; end: number; speaker?: number; transcript: string }[] | undefined;
  if (utts?.length) return utts.filter((u) => clean(u.transcript)).map((u) => ({ start: u.start + offset, end: u.end + offset, speaker: label(u.speaker), text: clean(u.transcript) }));
  const alt = r?.channels?.[0]?.alternatives?.[0];
  const words = (alt?.words ?? []) as { start: number; end: number; speaker?: number; word: string; punctuated_word?: string }[];
  if (!words.length) return alt?.transcript ? [{ start: offset, end: offset, speaker: null, text: clean(alt.transcript) }] : [];
  const segs: Segment[] = [];
  for (const w of words) {
    const sp = label(w.speaker);
    const last = segs[segs.length - 1];
    const gap = last ? w.start + offset - last.end : 0;
    if (last && last.speaker === sp && gap < 2 && last.text.length < 600) {
      last.text += ` ${w.punctuated_word ?? w.word}`;
      last.end = w.end + offset;
    } else segs.push({ start: w.start + offset, end: w.end + offset, speaker: sp, text: w.punctuated_word ?? w.word });
  }
  return segs;
}

export function whisperSegments(out: any, offset = 0): Segment[] {
  const segs = (out?.segments ?? []) as { start: number; end: number; text: string }[];
  if (segs.length) return segs.filter((s) => clean(s.text)).map((s) => ({ start: s.start + offset, end: s.end + offset, speaker: null, text: clean(s.text) }));
  return out?.text ? [{ start: offset, end: offset, speaker: null, text: clean(out.text) }] : [];
}

const hms = (s: number) => new Date(Math.max(0, Math.floor(s)) * 1000).toISOString().slice(11, 19);

/** "[00:01:02] Speaker 1: …" lines, consecutive lines from one speaker merged. */
export function formatSegments(segs: Segment[]): string {
  const merged: Segment[] = [];
  for (const s of segs.slice().sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && last.speaker && last.speaker === s.speaker && s.start - last.end < 3 && last.text.length < 900) {
      last.text += ` ${s.text}`;
      last.end = s.end;
    } else merged.push({ ...s });
  }
  return merged.map((s) => `[${hms(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
}

function toBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function runNova(env: Env, audio: Uint8Array | ReadableStream, contentType: string, offset: number, prefix: string): Promise<Segment[]> {
  const run = async (language?: string) => {
    // a stream can be read only once: a retry without the language needs the bytes
    const body = audio instanceof Uint8Array ? new Response(audio).body! : audio;
    return env.AI!.run(NOVA as never, { audio: { body, contentType }, diarize: true, punctuate: true, smart_format: true, utterances: true, ...(language ? { language } : {}) } as never);
  };
  // Indian calls switch between Hindi and English: Nova-3's multilingual mode follows both
  const lang = env.AI_SPEECH_LANGUAGE ?? 'multi';
  let out: unknown;
  try {
    out = await run(lang || undefined);
  } catch (e) {
    if (!lang || !(audio instanceof Uint8Array)) throw e;
    out = await run();
  }
  return novaSegments(out, offset, prefix);
}

/** Whisper often names Hindi speech "Urdu" and writes it in Arabic script; Indian chats speak Hindi. */
export const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

async function runWhisper(env: Env, bytes: Uint8Array, offset: number): Promise<Segment[]> {
  const model = (env.AI_MODEL_WHISPER || WHISPER) as never;
  const prompt = 'Hindi, English and Hinglish business conversation. नमस्ते, ठीक है, please check the invoice.';
  let out = (await env.AI!.run(model, { audio: toBase64(bytes), task: 'transcribe', vad_filter: true, initial_prompt: prompt } as never)) as any;
  if (ARABIC_SCRIPT.test(String(out?.text ?? '')) || out?.transcription_info?.language === 'ur') {
    out = await env.AI!.run(model, { audio: toBase64(bytes), task: 'transcribe', vad_filter: true, language: 'hi', initial_prompt: prompt } as never).catch(() => out);
  }
  return whisperSegments(out, offset);
}

/** One piece of audio (≤ 25 MB, or a stream for Nova) → segments; Nova first when speakers are wanted. */
export async function transcribePiece(env: Env, bytes: Uint8Array, contentType: string, opts: { speakers: boolean; offset?: number; prefix?: string }): Promise<SpeechResult> {
  if (!env.AI) return { segments: null, engine: null, reason: 'Speech-to-text is not available on this server' };
  const offset = opts.offset ?? 0;
  let novaError: string | null = null;
  if (opts.speakers) {
    try {
      const segs = await runNova(env, bytes, contentType, offset, opts.prefix ?? '');
      if (segs.length) return { segments: segs, engine: 'nova-3', reason: null };
    } catch (e) {
      novaError = (e as Error).message.slice(0, 200);
    }
  }
  if (bytes.length > WHISPER_MAX) return { segments: null, engine: null, reason: novaError ? `Speech-to-text failed: ${novaError}` : 'too_large' };
  try {
    const segs = await runWhisper(env, bytes, offset);
    return segs.length ? { segments: segs, engine: 'whisper', reason: null } : { segments: null, engine: null, reason: 'No speech was recognised in the recording' };
  } catch (e) {
    return { segments: null, engine: null, reason: `Speech-to-text failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

/* ───────────── splitting on the server: MP3 (frame-aligned) and PCM WAV ───────────── */

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_RATES = [44100, 48000, 32000];

/** A valid MPEG-1/2 layer III frame header at i → its length in bytes (else 0). */
function mp3Frame(b: Uint8Array, i: number): { len: number; kbps: number } | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1]! >> 1) & 3; // 1 = layer III
  const br = (b[i + 2]! >> 4) & 15;
  const sr = (b[i + 2]! >> 2) & 3;
  const pad = (b[i + 2]! >> 1) & 1;
  if (layer !== 1 || version === 1 || br === 0 || br === 15 || sr === 3) return null;
  const kbps = version === 3 ? MP3_BITRATES[br]! : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][br]!;
  const rate = MP3_RATES[sr]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const len = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
  return len > 4 ? { len, kbps } : null;
}

/** The first real frame at or after `from` (two frames in a row confirm it). */
function nextMp3Frame(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length - 4; i++) {
    const f = mp3Frame(b, i);
    if (f && (i + f.len >= b.length || mp3Frame(b, i + f.len))) return i;
  }
  return -1;
}

export interface AudioPart {
  bytes: Uint8Array;
  offset: number;
  contentType: string;
}

export function splitMp3(b: Uint8Array, partBytes = PART_BYTES): AudioPart[] | null {
  const first = nextMp3Frame(b, 0);
  if (first < 0) return null;
  const kbps = mp3Frame(b, first)!.kbps;
  const parts: AudioPart[] = [];
  let start = first;
  while (start < b.length) {
    let end = start + partBytes >= b.length ? b.length : nextMp3Frame(b, start + partBytes);
    if (end < 0) end = b.length;
    // offsets from the bitrate of the first frame (exact for CBR, close for VBR)
    parts.push({ bytes: b.subarray(start, end), offset: ((start - first) * 8) / (kbps * 1000), contentType: 'audio/mpeg' });
    start = end;
  }
  return parts;
}

export function splitWav(b: Uint8Array, partBytes = PART_BYTES): AudioPart[] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  let fmt: Uint8Array | null = null;
  let byteRate = 0;
  let align = 0;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = b.subarray(o, o + 8 + size);
      byteRate = dv.getUint32(o + 16, true);
      align = dv.getUint16(o + 20, true);
    }
    if (id === 'data') {
      if (!fmt || !byteRate || !align) return null;
      const data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
      const step = Math.max(align, partBytes - (partBytes % align));
      const parts: AudioPart[] = [];
      for (let s = 0; s < data.length; s += step) {
        const chunk = data.subarray(s, Math.min(data.length, s + step));
        const out = new Uint8Array(12 + fmt.length + 8 + chunk.length);
        const ov = new DataView(out.buffer);
        out.set([82, 73, 70, 70], 0);
        ov.setUint32(4, out.length - 8, true);
        out.set([87, 65, 86, 69], 8);
        out.set(fmt, 12);
        out.set([100, 97, 116, 97], 12 + fmt.length);
        ov.setUint32(16 + fmt.length, chunk.length, true);
        out.set(chunk, 20 + fmt.length);
        parts.push({ bytes: out, offset: s / byteRate, contentType: 'audio/wav' });
      }
      return parts;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/** Parts the server can make itself, or null when the browser has to do it. */
export function splitAudio(bytes: Uint8Array, type: string, partBytes = PART_BYTES): AudioPart[] | null {
  if (type === 'audio/mpeg') return splitMp3(bytes, partBytes);
  if (type === 'audio/wav') return splitWav(bytes, partBytes);
  return null;
}

/**
 * A whole recording → transcript text. Nova (speakers) on the whole file first; then Whisper,
 * splitting MP3 / WAV here when it is too big. `needsParts` means the browser has to cut it.
 */
export async function transcribeAll(env: Env, bytes: Uint8Array, type: string, opts: { speakers: boolean }): Promise<{ text: string | null; engine: SpeechResult['engine']; reason: string | null; needsParts: boolean }> {
  const whole = await transcribePiece(env, bytes, type, { speakers: opts.speakers });
  if (whole.segments) return { text: formatSegments(whole.segments), engine: whole.engine, reason: null, needsParts: false };
  if (whole.reason !== 'too_large' && bytes.length <= WHISPER_MAX) return { text: null, engine: null, reason: whole.reason, needsParts: false };
  const parts = splitAudio(bytes, type);
  if (!parts) return { text: null, engine: null, reason: 'The recording is long — SanchalanOS will cut it into parts in your browser and transcribe each one', needsParts: true };
  const all: Segment[] = [];
  let engine: SpeechResult['engine'] = null;
  for (const [i, p] of parts.entries()) {
    // speaker numbers are only matched within one part, so each part's speakers are kept apart
    const r = await transcribePiece(env, p.bytes, p.contentType, { speakers: opts.speakers, offset: p.offset, prefix: parts.length > 1 ? `P${i + 1} ` : '' });
    if (!r.segments) return { text: null, engine: null, reason: `Part ${i + 1} of ${parts.length}: ${r.reason}`, needsParts: false };
    engine = r.engine;
    all.push(...r.segments);
  }
  return { text: formatSegments(all), engine, reason: null, needsParts: false };
}

/** Speaker labels used in a transcript ("[00:00:05] Name: text" lines), with how often each speaks. */
export function speakersIn(transcript: string | null): { label: string; lines: number }[] {
  const m = new Map<string, number>();
  for (const line of String(transcript ?? '').split('\n')) {
    const x = /^\s*(?:\[[\d:.]+\]\s*)?([^:\[\]]{1,60}?):\s/.exec(line);
    if (x && !/^https?$/i.test(x[1]!.trim())) m.set(x[1]!.trim(), (m.get(x[1]!.trim()) ?? 0) + 1);
  }
  return [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([label, lines]) => ({ label, lines }));
}

/** Renames speakers ("Speaker 1" → "Ravi") at the start of each line. */
export function renameSpeakers(transcript: string, names: Record<string, string>): string {
  const keys = Object.keys(names).filter((k) => names[k] && names[k] !== k);
  if (!keys.length) return transcript;
  return transcript
    .split('\n')
    .map((line) => {
      const x = /^(\s*(?:\[[\d:.]+\]\s*)?)([^:\[\]]{1,60}?)(:\s)/.exec(line);
      if (!x) return line;
      const to = names[x[2]!.trim()];
      return to ? `${x[1]}${to}${x[3]}${line.slice(x[0].length)}` : line;
    })
    .join('\n');
}
