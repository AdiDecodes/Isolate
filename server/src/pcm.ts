import { config, bytesPerFrame } from "./config.js";

export function pcmToFloat(pcm: Uint8Array): [Float32Array, Float32Array] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = pcm.length / bytesPerFrame;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = view.getInt16(i * 4, true) / 32768;
    r[i] = view.getInt16(i * 4 + 2, true) / 32768;
  }
  return [l, r];
}

export function encodeWav(chL: Float32Array, chR: Float32Array, sampleRate: number): Buffer {
  const frames = chL.length;
  const blockAlign = 4;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, chL[i]));
    const r = Math.max(-1, Math.min(1, chR[i]));
    buffer.writeInt16LE(l < 0 ? l * 0x8000 : l * 0x7fff, off);
    off += 2;
    buffer.writeInt16LE(r < 0 ? r * 0x8000 : r * 0x7fff, off);
    off += 2;
  }
  return buffer;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const magicSeg = 0x53454731;
export const magicDone = 0x444f4e45;

export function segmentFrame(
  res: import("express").Response,
  startFrame: number,
  vocalsL: Float32Array,
  vocalsR: Float32Array,
  bgmL: Float32Array,
  bgmR: Float32Array
): boolean {
  const frames = vocalsL.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(magicSeg, 0);
  header.writeUInt32LE(startFrame, 4);
  header.writeUInt32LE(frames, 8);
  const payload = Buffer.alloc(frames * 4 * 4);
  let off = 0;
  for (let i = 0; i < frames; i++) {
    payload.writeFloatLE(vocalsL[i], off); off += 4;
    payload.writeFloatLE(vocalsR[i], off); off += 4;
    payload.writeFloatLE(bgmL[i], off); off += 4;
    payload.writeFloatLE(bgmR[i], off); off += 4;
  }
  return res.write(Buffer.concat([header, payload]));
}

export function doneFrame(res: import("express").Response): void {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(magicDone, 0);
  res.write(header);
  res.end();
}

export const sampleRate = config.sampleRate;
