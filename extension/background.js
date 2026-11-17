// Service worker: takes the videoId from the tab and hands it to the
// offscreen document, which streams audio through the local separation
// server and routes the resulting stems back to the tab.

const OFFSCREEN_URL = "offscreen.html";
const API_ROOT = "https://isolate443.duckdns.org";

const jobs = new Map(); // videoId -> { tabId, stage, ts }

// Resume a sign-in poll if the service worker restarted mid-flow.
chrome.storage.local
  .get("authPendingCode")
  .then(({ authPendingCode }) => {
    if (authPendingCode) {
      console.log("[isolate] auth: resuming pending poll");
      pollAuth(authPendingCode);
    }
  })
  .catch(() => {});

// Login polling runs here (not in the popup): opening the login tab closes
// the popup, so its own poll loop would die before the user finishes
// signing in. The service worker keeps polling and stores the token.
let authPollingCode = null;

async function pollAuth(code) {
  if (!code || authPollingCode === code) return;
  authPollingCode = code;
  console.log("[isolate] auth: polling", code.slice(0, 8) + "…");
  const deadline = Date.now() + 10 * 60 * 1000;
  // MV3 kills the service worker after ~30s of inactivity, and a timer
  // sleep doesn't count as activity — ping an extension API so the poll
  // loop survives the whole sign-in window.
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
          console.log("[isolate] auth: token stored");
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
  console.log("[isolate] message:", msg.type, msg.videoId || "");
  if (msg.type === "ai-request") {
    handleRequest(msg.videoId, sender.tab?.id).catch((e) =>
      reportError(msg.videoId, String(e && e.message ? e.message : e))
    );
    sendResponse({ ok: true });
  } else if (msg.type === "cache-check") {
    isCached(msg.videoId).then((cached) => sendResponse({ cached }));
    return true; // async sendResponse
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

// A job that hasn't reported progress for this long is considered dead
// and a new request may replace it instead of being silently ignored.
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
    // Track terminal states so jobActive() stops blocking re-requests.
    if (msg.type === "ai-progress" && msg.stage === "done") job.stage = "done";
  }
  const tabId = job?.tabId;
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    /* tab gone */
  }
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

// Does the server already hold separated stems for this video? Memoized so
// repeated probes (video-change ticks, job starts) don't hit the network.
const cachedProbe = new Map(); // videoId -> { cached, ts }
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
  // Cached songs skip straight to stem fetch — no "Resolving stream…" stage.
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
