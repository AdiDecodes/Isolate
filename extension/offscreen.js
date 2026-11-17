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
    const local = await idbGet(videoId);
    if (local && local.vocals && local.bgm) {
      idbPut(videoId, { vocals: local.vocals, bgm: local.bgm, ts: Date.now() });
      await deliverCached(job, videoId, [local.vocals, local.bgm]);
      if (!job.cancelled) {
        report(videoId, { type: "ai-progress", stage: "done", pct: 100 });
      }
      return;
    }
    const cached = await fetchCachedStems(videoId);
    if (cached) {
      await idbPut(videoId, { vocals: cached[0], bgm: cached[1], ts: Date.now() });
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
    ctx.decodeAudioData(vBuf.slice(0)),
    ctx.decodeAudioData(bBuf.slice(0)),
  ]);
  if (job.cancelled || currentJob !== job) return;

  const frames = Math.min(vocals.length, bgm.length);
  const segFrames = 10 * SR;
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
      vocalsL: Array.from(vL.subarray(s, e)),
      vocalsR: Array.from(vR.subarray(s, e)),
      bgmL: Array.from(bL.subarray(s, e)),
      bgmR: Array.from(bR.subarray(s, e)),
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

const IDB_NAME = "isolate-stems";
const IDB_STORE = "songs";
const IDB_MAX_SONGS = 50;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE).createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRun(mode, fn) {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const result = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : null);
        tx.onerror = () => reject(tx.error);
      })
  );
}

async function idbGet(videoId) {
  try {
    return await idbRun("readonly", (store) => store.get(videoId));
  } catch (e) {
    return null;
  }
}

async function idbPut(videoId, record) {
  try {
    await idbRun("readwrite", (store) => store.put(record, videoId));
    await idbEvict();
  } catch (e) {}
}

async function idbEvict() {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - IDB_MAX_SONGS;
        if (excess <= 0) return;
        const cursorReq = store.index("ts").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess--;
          cursor.continue();
        };
      };
      tx.oncomplete = resolve;
      tx.onerror = () => resolve();
    });
  } catch (e) {}
}
