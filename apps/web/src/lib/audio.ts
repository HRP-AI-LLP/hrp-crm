/**
 * Cuts a long recording into WAV parts in the browser (any format the browser can play: m4a, mp4,
 * webm, ogg, mp3…), mixed down to mono at 16 kHz — ~19 MB per 10 minutes — so each part fits one
 * speech-to-text request.
 */
export interface WavPart {
  blob: Blob;
  offset: number;
  index: number;
  total: number;
}

const RATE = 16_000;

function wav(samples: Float32Array): Blob {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

/** Decodes the recording once; each part is made only when it is about to be sent. */
export async function prepareWavParts(file: Blob, partSeconds = 600): Promise<{ total: number; seconds: number; part: (p: number) => WavPart }> {
  const Ctx = (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext) as typeof OfflineAudioContext | undefined;
  if (!Ctx) throw new Error('This browser cannot read audio — use Chrome, Edge or Firefox');
  // decoding into a 16 kHz context resamples as it decodes
  const audio = await new Ctx(1, 1, RATE).decodeAudioData(await file.arrayBuffer()).catch(() => {
    throw new Error('The browser could not read this recording — export it as m4a or mp3 and try again');
  });
  const step = Math.round(partSeconds * audio.sampleRate);
  const total = Math.max(1, Math.ceil(audio.length / step));
  const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const part = (p: number): WavPart => {
    const s = p * step;
    const e = Math.min(audio.length, s + step);
    const mono = new Float32Array(e - s);
    for (const ch of chans) for (let i = s; i < e; i++) mono[i - s]! += ch[i]! / chans.length;
    // resample if the browser kept the file's own rate
    let out = mono;
    if (audio.sampleRate !== RATE) {
      const ratio = audio.sampleRate / RATE;
      out = new Float32Array(Math.floor(mono.length / ratio));
      for (let i = 0; i < out.length; i++) out[i] = mono[Math.floor(i * ratio)]!;
    }
    return { blob: wav(out), offset: s / audio.sampleRate, index: p, total };
  };
  return { total, seconds: audio.duration, part };
}
