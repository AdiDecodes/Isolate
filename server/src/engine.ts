import {
  segmentFrames,
  overlapFrames,
  segmentBytes,
  overlapBytes,
  bytesPerFrame,
  config,
} from "./config.js";
import { pcmToFloat, encodeWav, concatBytes } from "./pcm.js";
import { uploadWav, separateOnSpace, pickVocals, fetchVocalsWav } from "./hf.js";

interface CoreEntry {
  core: [Float32Array, Float32Array];
  ext: [Float32Array, Float32Array];
}

export interface EngineHooks {
  onSegment(startFrame: number, vocalsL: Float32Array, vocalsR: Float32Array, bgmL: Float32Array, bgmR: Float32Array): void;
  onProgress(pct: number | null): void;
  onStage(stage: string): void;
  cancelled(): boolean;
}

export function createEngine(hooks: EngineHooks) {
  const mixPending = new Map<number, CoreEntry>();
  const uploadPaths = new Map<number, string>();
  let uploadChain: Promise<void> = Promise.resolve();
  let gpuChain: Promise<void> = Promise.resolve();
  let chainError: Error | null = null;
  let queued = 0;
  let delivered = 0;
  let estimatedTotal = 0;
  let pendingPrev: { idx: number; vExt: [Float32Array, Float32Array] } | null = null;
  let pendingCur: { idx: number; vExt: [Float32Array, Float32Array] } | null = null;

  const onChainError = (e: Error) => {
    chainError = chainError || e;
    throw e;
  };

  function enqueue(entry: CoreEntry) {
    const idx = queued++;
    mixPending.set(idx, entry);
    const coreLen = entry.core[0].length;
    const expectedLen = coreLen + 2 * overlapFrames;

    uploadChain = uploadChain
      .then(async () => {
        if (hooks.cancelled()) throw new Error("cancelled");
        const e = mixPending.get(idx);
        if (!e) return;
        const wav = encodeWav(e.ext[0], e.ext[1], config.sampleRate);
        hooks.onStage("uploading");
        const path = await uploadWav(wav);
        uploadPaths.set(idx, path);
      })
      .catch(onChainError);
    uploadChain.catch(() => {});

    gpuChain = gpuChain
    .then(() => uploadChain)
    .then(async () => {
      if (hooks.cancelled()) throw new Error("cancelled");
      const outputs = await separateOnSpace(uploadPaths.get(idx)!);
      const vExt = await fetchAlignedVocals(idx, outputs, expectedLen);

      if (pendingCur) {
        deliverCore(pendingCur.idx, pendingPrev?.vExt ?? null, pendingCur.vExt, vExt);
        pendingPrev = pendingCur;
        pendingCur = null;
        delivered++;
        const pct = estimatedTotal
          ? Math.min(99, Math.round((delivered / estimatedTotal) * 100))
          : null;
        hooks.onProgress(pct);
      }
      pendingCur = { idx, vExt };
    })
    .catch(onChainError);
    gpuChain.catch(() => {});
  }

  function deliverCore(
    idx: number,
    prevVExt: [Float32Array, Float32Array] | null,
    curVExt: [Float32Array, Float32Array],
    nextVExt: [Float32Array, Float32Array] | null
  ) {
    const entry = mixPending.get(idx);
    if (!entry) return;
    mixPending.delete(idx);
    const core = entry.core;
    const C = core[0].length;
    const O = Math.min(overlapFrames, Math.floor(C / 2));

    // Each window's vocals estimate covers this core plus overlap on both
    // sides, so adjacent windows agree on a 2*overlap-wide shared region.
    // Blend the two estimates across that whole region with one linear
    // weight per absolute frame: the same weight applies from either side
    // of a boundary, which makes every seam sample-continuous instead of
    // hard-switching between edge-region estimates.
    const vL = new Float32Array(C);
    const vR = new Float32Array(C);
    for (let i = 0; i < C; i++) {
      vL[i] = curVExt[0][overlapFrames + i];
      vR[i] = curVExt[1][overlapFrames + i];
    }
    if (prevVExt) {
      // Seam before this core: weight of the previous estimate falls 0.5 -> 0
      // across the first `overlap` frames (it already carried 0.5 at the seam
      // from the previous segment's tail blend).
      for (let i = 0; i < O; i++) {
        const t = 0.5 + (0.5 * i) / O;
        const p = segmentFrames + overlapFrames + i;
        vL[i] = prevVExt[0][p] * (1 - t) + curVExt[0][overlapFrames + i] * t;
        vR[i] = prevVExt[1][p] * (1 - t) + curVExt[1][overlapFrames + i] * t;
      }
    }
    if (nextVExt) {
      // Seam after this core: weight of the current estimate falls 1 -> 0.5
      // across the last `overlap` frames; the next segment's head blend
      // continues 0.5 -> 0 with the same per-frame weight.
      for (let i = C - O; i < C; i++) {
        const u = (i - (C - O)) / (2 * O);
        const n = i - (C - O);
        vL[i] = curVExt[0][overlapFrames + i] * (1 - u) + nextVExt[0][n] * u;
        vR[i] = curVExt[1][overlapFrames + i] * (1 - u) + nextVExt[1][n] * u;
      }
    }

    const bgmL = new Float32Array(C);
    const bgmR = new Float32Array(C);
    for (let s = 0; s < C; s++) {
      bgmL[s] = core[0][s] - vL[s];
      bgmR[s] = core[1][s] - vR[s];
    }
    hooks.onSegment(idx * segmentFrames, vL, vR, bgmL, bgmR);
  }

  async function fetchAlignedVocals(
    idx: number,
    outputs: unknown,
    expectedLen: number
  ): Promise<[Float32Array, Float32Array]> {
    const vocalsUrl = pickVocals(outputs);
    if (!vocalsUrl) throw new Error("space returned no vocals stem");
    const wav = await fetchVocalsWav(vocalsUrl);
    const v = await decodeWavToStereo(wav);
    const out: [Float32Array, Float32Array] = [
      new Float32Array(expectedLen),
      new Float32Array(expectedLen),
    ];
    for (let ch = 0; ch < 2; ch++) {
      const n = Math.min(expectedLen, v[ch].length);
      out[ch].set(v[ch].subarray(0, n));
    }
    return out;
  }

  return {
    enqueue,
    setEstimate(n: number) {
      estimatedTotal = n;
    },
    backlog() {
      return queued - delivered;
    },
    async finish(): Promise<void> {
      await Promise.all([uploadChain, gpuChain]).catch((e) => {
        throw chainError || e;
      });
      if (chainError) throw chainError;
      if (pendingCur) {
        deliverCore(pendingCur.idx, pendingPrev?.vExt ?? null, pendingCur.vExt, null);
        pendingCur = null;
        pendingPrev = null;
        delivered++;
      }
    },
  };
}

async function decodeWavToStereo(wav: Buffer): Promise<[Float32Array, Float32Array]> {
  const dataOffset = findDataChunk(wav);
  const frames = (wav.length - dataOffset) / 4;
  const pcm = new Uint8Array(wav.subarray(dataOffset));
  const [l, r] = pcmToFloat(pcm);
  if (l.length === frames) return [l, r];
  return [l.subarray(0, frames), r.subarray(0, frames)];
}

function findDataChunk(wav: Buffer): number {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return off + 8;
    off += 8 + size + (size % 2);
  }
  return 44;
}

export function extendedMix(
  mix: [Float32Array, Float32Array],
  s: number,
  e: number,
  total: number
): [Float32Array, Float32Array] {
  const start = Math.max(0, s - overlapFrames);
  const end = Math.min(total, e + overlapFrames);
  const len = overlapFrames * 2 + (e - s);
  const ext: [Float32Array, Float32Array] = [
    new Float32Array(len),
    new Float32Array(len),
  ];
  for (let ch = 0; ch < 2; ch++) {
    ext[ch].set(mix[ch].subarray(start, end), s - start);
  }
  return ext;
}

export async function separateWholeMix(
  mix: [Float32Array, Float32Array],
  hooks: EngineHooks
): Promise<void> {
  const engine = createEngine(hooks);
  const total = mix[0].length;
  const segCount = Math.ceil(total / segmentFrames);
  engine.setEstimate(segCount);

  for (let k = 0; k < segCount; k++) {
    if (hooks.cancelled()) return;
    const s = k * segmentFrames;
    const e = Math.min(s + segmentFrames, total);
    engine.enqueue({
      ext: extendedMix(mix, s, e, total),
      core: [mix[0].slice(s, e), mix[1].slice(s, e)],
    });
  }
  await engine.finish();
}

export { segmentBytes, overlapBytes, bytesPerFrame, segmentFrames, overlapFrames };
