// Offscreen document: asks the local separation server to extract and
// separate the video, parses the binary stem frames from its response, and
// streams finished segments back to the tab via the service worker.

const API_ROOT = "https://isolate443.duckdns.org";
const SR = 44100;

const MAGIC_SEG = 0x53454731;
const MAGIC_PROG = 0x50524f43;
const MAGIC_ERR = 0x4552524f;
const MAGIC_DONE = 0x444f4e45;

let currentJob = null;
let authToken = null;

function authHeaders() {
  return authToken ? { Authorization: "Bearer " + authToken } : {};
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ai-process") {
    authToken = msg.token || null;
    runJob(msg.videoId).catch((e) => {
      chrome.runtime.sendMessage({
        type: "ai-error",
        videoId: msg.videoId,
        message: String(e && e.message ? e.message : e),
      });
    });
  }
  return false;
});

function report(videoId, payload) {
  chrome.runtime.sendMessage({ videoId, ...payload });
}

async function runJob(videoId) {
  if (currentJob && currentJob.videoId === videoId && !currentJob.done) return;
  if (currentJob) currentJob.cancelled = true;
  currentJob = { videoId, cancelled: false, done: false };
  const job = currentJob;

  try {
    const cached = await fetchCachedStems(videoId);
    if (cached) {
      await deliverCached(job, videoId, cached);
      if (!job.cancelled) {
        report(videoId, { type: "ai-progress", stage: "done", pct: 100 });
      }
      return;
    }
    let api;
    try {
      api = await fetch(API_ROOT + "/separate?id=" + encodeURIComponent(videoId), {
        headers: authHeaders(),
      });
    } catch (e) {
      console.error("[isolate] separate fetch failed:", e);
      throw new Error(
        "separation API failed: " + (e.cause?.code || e.cause?.message || e.message)
      );
    }
    if (!api.ok) {
      let detail = api.status;
      try {
        const data = await api.json();
        if (data.error) detail = data.error;
      } catch (e) {}
      throw new Error("separation API failed: " + detail);
    }
    await readFrames(job, videoId, api);
    if (!job.cancelled) {
      report(videoId, { type: "ai-progress", stage: "done", pct: 100 });
    }
  } finally {
    if (currentJob === job) {
      job.done = true;
      currentJob = null;
    }
  }
}

// Cached songs skip the raw-PCM /separate stream entirely: the server hands
// over the small AAC stems and we decode them locally, which starts playback
// in a second or two instead of after a ~100 MB transfer.
async function fetchCachedStems(videoId) {
  try {
    const [vRes, bRes] = await Promise.all([
      fetch(API_ROOT + "/stems/" + videoId + "/vocals.m4a", { headers: authHeaders() }),
      fetch(API_ROOT + "/stems/" + videoId + "/bgm.m4a", { headers: authHeaders() }),
    ]);
    if (!vRes.ok || !bRes.ok) return null;
    return [await vRes.arrayBuffer(), await bRes.arrayBuffer()];
  } catch (e) {
    return null;
  }
}

async function deliverCached(job, videoId, [vBuf, bBuf]) {
  report(videoId, { type: "ai-progress", stage: "decoding", pct: null });
  const ctx = new OfflineAudioContext(2, 1, SR);
  const [vocals, bgm] = await Promise.all([
    ctx.decodeAudioData(vBuf),
    ctx.decodeAudioData(bBuf),
  ]);
  if (job.cancelled || currentJob !== job) return;

  const frames = Math.min(vocals.length, bgm.length);
  const segFrames = 10 * SR;
  // Playback can start once this much audio has been handed to the tab; the
  // rest keeps arriving while the video plays.
  const readyAt = Math.min(frames, 30 * SR);
  let readySent = false;
  const vL = vocals.getChannelData(0);
  const vR = vocals.getChannelData(1);
  const bL = bgm.getChannelData(0);
  const bR = bgm.getChannelData(1);
  for (let s = 0; s < frames; s += segFrames) {
    if (job.cancelled || currentJob !== job) return;
    const e = Math.min(s + segFrames, frames);
    report(videoId, {
      type: "ai-segment",
      startFrame: s,
      sampleRate: SR,
      vocalsL: vL.slice(s, e),
      vocalsR: vR.slice(s, e),
      bgmL: bL.slice(s, e),
      bgmR: bR.slice(s, e),
    });
    if (!readySent && e >= readyAt) {
      readySent = true;
      report(videoId, { type: "ai-ready" });
    }
    report(videoId, {
      type: "ai-progress",
      stage: "cached",
      pct: Math.min(99, Math.round((e / frames) * 100)),
    });
  }
}

// Collect segments for the whole track and deliver them only once the
// separation is complete — playback resumes in sync afterwards.
async function readFrames(job, videoId, res) {
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  const dec = new TextDecoder();
  const collected = [];

  for (;;) {
    if (job.cancelled || currentJob !== job) {
      reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf = buf.length ? concatBytes(buf, value) : value;

    for (;;) {
      if (buf.length < 12) break;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const magic = view.getUint32(0, true);

      if (magic === MAGIC_PROG) {
        const pctRaw = view.getUint32(4, true);
        report(videoId, {
          type: "ai-progress",
          stage: "separating",
          pct: pctRaw === 0xffffffff ? null : pctRaw,
        });
        buf = buf.slice(12);
        continue;
      }
      if (magic === MAGIC_ERR) {
        const len = view.getUint32(4, true);
        if (buf.length < 12 + len) break;
        throw new Error(dec.decode(buf.slice(12, 12 + len)) || "separation failed");
      }
      if (magic === MAGIC_DONE) {
        for (const seg of collected) {
          if (job.cancelled || currentJob !== job) return;
          report(videoId, { type: "ai-segment", ...seg });
        }
        return;
      }
      if (magic !== MAGIC_SEG) throw new Error("bad frame from separation API");

      const startFrame = view.getUint32(4, true);
      const frames = view.getUint32(8, true);
      const need = 12 + frames * 16;
      if (buf.length < need) break;

      const payload = new DataView(buf.buffer, buf.byteOffset + 12, frames * 16);
      const vocalsL = new Float32Array(frames);
      const vocalsR = new Float32Array(frames);
      const bgmL = new Float32Array(frames);
      const bgmR = new Float32Array(frames);
      let off = 0;
      for (let i = 0; i < frames; i++) {
        vocalsL[i] = payload.getFloat32(off, true); off += 4;
        vocalsR[i] = payload.getFloat32(off, true); off += 4;
        bgmL[i] = payload.getFloat32(off, true); off += 4;
        bgmR[i] = payload.getFloat32(off, true); off += 4;
      }
      collected.push({
        startFrame,
        sampleRate: SR,
        vocalsL: Array.from(vocalsL),
        vocalsR: Array.from(vocalsR),
        bgmL: Array.from(bgmL),
        bgmR: Array.from(bgmR),
      });
      buf = buf.slice(need);
    }
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
