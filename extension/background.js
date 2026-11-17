const OFFSCREEN_URL = "offscreen.html";
const API_ROOT = "https://isolate443.duckdns.org";

const jobs = new Map();

chrome.storage.local
  .get("authPendingCode")
  .then(({ authPendingCode }) => {
    if (authPendingCode) pollAuth(authPendingCode);
  })
  .catch(() => {});

let authPollingCode = null;

async function pollAuth(code) {
  if (!code || authPollingCode === code) return;
  authPollingCode = code;
  const deadline = Date.now() + 10 * 60 * 1000;
  const keepAlive = setInterval(
    () => chrome.runtime.getPlatformInfo(() => {}),
    20000
  );
  try {
    while (Date.now() < deadline && authPollingCode === code) {
      try {
        const res = await fetch(API_ROOT + "/auth/poll?code=" + encodeURIComponent(code));
        const data = await res.json();
        if (data.status === "ok" && data.token) {
          await chrome.storage.local.set({ token: data.token });
          chrome.runtime.sendMessage({ type: "auth-ok" }).catch(() => {});
          return;
        }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    clearInterval(keepAlive);
    if (authPollingCode === code) {
      authPollingCode = null;
      chrome.storage.local.remove("authPendingCode").catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ai-request") {
    handleRequest(msg.videoId, sender.tab?.id).catch((e) =>
      reportError(msg.videoId, String(e && e.message ? e.message : e))
    );
    sendResponse({ ok: true });
  } else if (msg.type === "cache-check") {
    isCached(msg.videoId).then((cached) => sendResponse({ cached }));
    return true;
  } else if (msg.type === "auth-begin") {
    chrome.storage.local.set({ authPendingCode: msg.code }).catch(() => {});
    pollAuth(msg.code);
    sendResponse({ ok: true });
  } else if (
    msg.type === "ai-progress" ||
    msg.type === "ai-segment" ||
    msg.type === "ai-ready" ||
    msg.type === "ai-error"
  ) {
    if (msg.type === "ai-error") console.error("[isolate] job error:", msg.message);
    routeToTab(msg);
    sendResponse({ ok: true });
  }
  return false;
});

const JOB_STALE_MS = 120000;

function jobActive(job) {
  return (
    !!job &&
    job.stage !== "error" &&
    job.stage !== "done" &&
    Date.now() - (job.ts || 0) < JOB_STALE_MS
  );
}

async function routeToTab(msg) {
  const job = jobs.get(msg.videoId);
  if (job) {
    job.ts = Date.now();
    if (msg.type === "ai-progress" && msg.stage === "done") job.stage = "done";
  }
  const tabId = job?.tabId;
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {}
}

function reportError(videoId, message) {
  console.error("[isolate] error:", message);
  jobs.set(videoId, { ...(jobs.get(videoId) || {}), stage: "error" });
  routeToTab({ type: "ai-error", videoId, message });
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!has) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Extract audio and separate stems via the local server.",
    });
  }
}

const cachedProbe = new Map();
const PROBE_TTL_MS = 10 * 60 * 1000;

async function isCached(videoId) {
  if (!videoId) return false;
  const hit = cachedProbe.get(videoId);
  if (hit && Date.now() - hit.ts < PROBE_TTL_MS) return hit.cached;
  let cached = false;
  try {
    const res = await fetch(API_ROOT + "/cached/" + encodeURIComponent(videoId));
    if (res.ok) cached = !!(await res.json()).cached;
  } catch (e) {}
  cachedProbe.set(videoId, { cached, ts: Date.now() });
  return cached;
}

async function handleRequest(videoId, tabId, start) {
  if (!videoId || tabId == null) return;
  if (jobActive(jobs.get(videoId))) return;

  const cached = await isCached(videoId);
  jobs.set(videoId, { tabId, stage: cached ? "processing" : "extracting", ts: Date.now() });
  if (!cached) routeToTab({ type: "ai-progress", videoId, stage: "extracting" });

  await ensureOffscreen();

  let token = null;
  try {
    token = (await chrome.storage.local.get("token")).token || null;
  } catch (e) {}

  jobs.set(videoId, { tabId, stage: "processing", ts: Date.now() });
  chrome.runtime.sendMessage({
    type: "ai-process",
    videoId,
    tabId,
    start,
    token,
  });
}
