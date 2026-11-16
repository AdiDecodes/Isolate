import express from "express";
import { config, segmentFrames } from "./config.js";
import { segmentFrame, doneFrame } from "./pcm.js";
import { createEngine } from "./engine.js";
import { resolveAudio, spawnFfmpegPcm, spawnFfmpegMp3, isValidVideoId } from "./ytdlp.js";
import * as cache from "./cache.js";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: config.spaceModel });
});

app.get("/stems/:id/:file", (req, res) => {
  const id = String(req.params.id || "");
  const m = /^(vocals|bgm)\.m4a$/.exec(String(req.params.file || ""));
  if (!isValidVideoId(id) || !m) {
    res.status(400).json({ error: "invalid request" });
    return;
  }
  if (!cache.hasCached(id)) {
    res.status(404).json({ error: "not cached" });
    return;
  }
  const file = m[1] === "vocals" ? cache.vocalsFile(id) : cache.bgmFile(id);
  res.sendFile(file, { headers: { "Cache-Control": "no-store" } }, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "stem read failed" });
    }
  });
});

app.get("/separate", async (req, res) => {
  const videoId = String(req.query.id || "");
  if (!isValidVideoId(videoId)) {
    res.status(400).json({ error: "invalid video id" });
    return;
  }

  if (cache.hasCached(videoId)) {
    cache.touch(videoId);
    streamCachedSeparation(req, res, videoId);
    return;
  }

  const startAt = Math.max(0, Number(req.query.start) || 0);
  const endReq = Number(req.query.end) || 0;

  let duration = 0;
  let proc: ReturnType<typeof spawnFfmpegPcm>;
  let from = startAt;
  let to = 0;
  try {
    const resolved = await resolveAudio(videoId);
    duration = resolved.duration;
    from = Math.min(startAt, Math.max(0, duration - config.segmentSeconds));
    to = endReq > from ? Math.min(endReq, duration) : duration;
    proc = spawnFfmpegPcm(resolved.url, from, to);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  });

  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
    proc.kill();
  });

  const vocalsChunks: Buffer[] = [];
  const bgmChunks: Buffer[] = [];

  const hooks = {
    onSegment: (start: number, vL: Float32Array, vR: Float32Array, bL: Float32Array, bR: Float32Array) => {
      segmentFrame(res, Math.round(from * config.sampleRate) + start, vL, vR, bL, bR);
      if (!cancelled) {
        vocalsChunks.push(floatsToPcm16(vL, vR));
        bgmChunks.push(floatsToPcm16(bL, bR));
      }
    },
    onProgress: (pct: number | null) => {
      const header = Buffer.alloc(12);
      header.writeUInt32LE(0x50524f43, 0);
      header.writeUInt32LE(pct == null ? 0xffffffff : pct, 4);
      res.write(header);
    },
    onStage: () => {},
    cancelled: () => cancelled || res.writableEnded,
  };

  const engine = createEngine(hooks);
  const span = to - from;
  engine.setEstimate(span > 0 ? Math.ceil((span * config.sampleRate) / segmentFrames) : 0);

  const fail = (e: unknown) => {
    if (cancelled || res.writableEnded) return;
    const body = Buffer.from(String(e instanceof Error ? e.message : e));
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x4552524f, 0);
    header.writeUInt32LE(body.length, 4);
    try {
      res.write(Buffer.concat([header, body]));
      res.end();
    } catch {}
  };

  let carry: Buffer = Buffer.alloc(0);
  let coreBuf: Buffer | null = null;
  const overlapBytesServer = config.overlapSeconds * config.sampleRate * 4;
  const segmentBytesServer = segmentFrames * 4;
  let prevTail = Buffer.alloc(overlapBytesServer);

  const feed = (chunk: Buffer) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    for (;;) {
      if (coreBuf === null) {
        if (carry.length < segmentBytesServer) return;
        coreBuf = carry.subarray(0, segmentBytesServer);
        carry = carry.subarray(segmentBytesServer);
      }
      if (carry.length < overlapBytesServer) return;
      const look = carry.subarray(0, overlapBytesServer);
      // The look-ahead stays at the head of `carry`: those same samples form
      // the start of the next core, so consecutive cores remain contiguous
      // and no audio is skipped between windows.
      const extPcm = Buffer.concat([prevTail, coreBuf, look]);
      engine.enqueue({ ext: pcmToFloat(extPcm), core: pcmToFloat(coreBuf) });
      prevTail = Buffer.from(coreBuf.subarray(segmentBytesServer - overlapBytesServer));
      coreBuf = null;
    }
  };

  const finishStream = async () => {
    let last = coreBuf !== null ? coreBuf : carry;
    if (last.length < segmentBytesServer) {
      last = Buffer.concat([last, Buffer.alloc(segmentBytesServer - last.length)]);
    }
    if (last.length >= 4) {
      const extPcm = Buffer.concat([prevTail, last, Buffer.alloc(overlapBytesServer)]);
      engine.enqueue({ ext: pcmToFloat(extPcm), core: pcmToFloat(last.subarray(0, segmentBytesServer)) });
    }
    await engine.finish();
    if (!cancelled && vocalsChunks.length) {
      try {
        await cache.store(videoId, Buffer.concat(vocalsChunks), Buffer.concat(bgmChunks));
      } catch (e) {
        console.error("[isolate] cache store failed:", e);
      }
    }
    doneFrame(res);
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    try {
      feed(chunk);
      if (engine.backlog() > config.maxBacklog) proc.stdout.pause();
    } catch (e) {
      fail(e);
      proc.kill();
    }
  });
  proc.stdout.on("pause", () => {});
  const drain = setInterval(() => {
    if (engine.backlog() <= config.maxBacklog) proc.stdout.resume();
    if (cancelled) clearInterval(drain);
  }, 200);
  proc.stdout.on("end", () => {
    clearInterval(drain);
    finishStream().catch(fail);
  });
  proc.on("error", (e) => fail(new Error(`ffmpeg failed: ${e.message}`)));
});

app.get("/mp3", async (req, res) => {
  const videoId = String(req.query.id || "");
  if (!isValidVideoId(videoId)) {
    res.status(400).json({ error: "invalid video id" });
    return;
  }
  let resolved: { url: string; duration: number };
  try {
    resolved = await resolveAudio(videoId);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Content-Disposition": `attachment; filename="${videoId}.mp3"`,
    "Cache-Control": "no-store",
  });
  const proc = spawnFfmpegMp3(resolved.url);
  req.on("close", () => proc.kill());
  proc.on("error", (e) => {
    try { res.destroy(new Error(`ffmpeg failed: ${e.message}`)); } catch {}
  });
  proc.stdout.pipe(res);
});

function floatsToPcm16(vL: Float32Array, vR: Float32Array): Buffer {
  const out = Buffer.alloc(vL.length * 4);
  for (let i = 0; i < vL.length; i++) {
    const l = Math.max(-1, Math.min(1, vL[i]));
    const r = Math.max(-1, Math.min(1, vR[i]));
    out.writeInt16LE(l < 0 ? l * 0x8000 : l * 0x7fff, i * 4);
    out.writeInt16LE(r < 0 ? r * 0x8000 : r * 0x7fff, i * 4 + 2);
  }
  return out;
}

function deinterleaveF32(pcm: Buffer, frames: number): [Float32Array, Float32Array] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 8);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = view.getFloat32(i * 8, true);
    r[i] = view.getFloat32(i * 8 + 4, true);
  }
  return [l, r];
}

function streamCachedSeparation(
  req: express.Request,
  res: express.Response,
  videoId: string
): void {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  });

  const vProc = cache.decodePcmStream(cache.vocalsFile(videoId));
  const bProc = cache.decodePcmStream(cache.bgmFile(videoId));
  const kill = () => {
    vProc.kill();
    bProc.kill();
  };
  req.on("close", kill);

  const segBytes = segmentFrames * 8;
  let vBuf: Buffer = Buffer.alloc(0);
  let bBuf: Buffer = Buffer.alloc(0);
  let vDone = false;
  let bDone = false;
  let startFrame = 0;
  let failed = false;
  let finishedSent = false;

  const fail = (e: unknown) => {
    if (failed || res.writableEnded) return;
    failed = true;
    kill();
    const body = Buffer.from(String(e instanceof Error ? e.message : e));
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x4552524f, 0);
    header.writeUInt32LE(body.length, 4);
    try {
      res.write(Buffer.concat([header, body]));
      res.end();
    } catch {}
  };

  const emit = () => {
    for (;;) {
      if (vBuf.length >= segBytes && bBuf.length >= segBytes) {
        const [vL, vR] = deinterleaveF32(vBuf.subarray(0, segBytes), segmentFrames);
        const [bL, bR] = deinterleaveF32(bBuf.subarray(0, segBytes), segmentFrames);
        vBuf = vBuf.subarray(segBytes);
        bBuf = bBuf.subarray(segBytes);
        segmentFrame(res, startFrame, vL, vR, bL, bR);
        startFrame += segmentFrames;
        continue;
      }
      if (vDone && bDone) {
        if (!finishedSent) {
          finishedSent = true;
          const frames = Math.floor(Math.min(vBuf.length, bBuf.length) / 8);
          if (frames > 0) {
            const [vL, vR] = deinterleaveF32(vBuf.subarray(0, frames * 8), frames);
            const [bL, bR] = deinterleaveF32(bBuf.subarray(0, frames * 8), frames);
            segmentFrame(res, startFrame, vL, vR, bL, bR);
          }
          doneFrame(res);
        }
        return;
      }
      return;
    }
  };

  const pump = async () => {
    const vIter = vProc.stdout[Symbol.asyncIterator]();
    const bIter = bProc.stdout[Symbol.asyncIterator]();
    let vOpen = true;
    let bOpen = true;
    for (;;) {
      if (res.writableEnded || req.destroyed) {
        kill();
        return;
      }
      const reads: Promise<{ done: boolean; value: Buffer | null }>[] = [];
      reads.push(
        vOpen
          ? vIter.next().then((r) => ({ done: !!r.done, value: r.value ?? null }))
          : Promise.resolve({ done: true, value: null })
      );
      reads.push(
        bOpen
          ? bIter.next().then((r) => ({ done: !!r.done, value: r.value ?? null }))
          : Promise.resolve({ done: true, value: null })
      );
      const [vr, br] = await Promise.all(reads);
      if (vr.value) vBuf = Buffer.concat([vBuf, vr.value]);
      if (br.value) bBuf = Buffer.concat([bBuf, br.value]);
      if (vr.done) {
        vOpen = false;
        vDone = true;
      }
      if (br.done) {
        bOpen = false;
        bDone = true;
      }
      emit();
      if (res.writableEnded || finishedSent) return;
      if (vDone && bDone) {
        emit();
        return;
      }
    }
  };

  pump().catch(fail);
  vProc.on("error", (e) => fail(new Error(`ffmpeg decode failed: ${e.message}`)));
  bProc.on("error", (e) => fail(new Error(`ffmpeg decode failed: ${e.message}`)));
}

function pcmToFloat(pcm: Buffer): [Float32Array, Float32Array] {
  const frames = pcm.length / 4;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = pcm.readInt16LE(i * 4) / 32768;
    r[i] = pcm.readInt16LE(i * 4 + 2) / 32768;
  }
  return [l, r];
}

app.listen(config.port, "127.0.0.1", () => {
  console.log(`isolate server on http://127.0.0.1:${config.port}`);
});
