// Service worker: takes the videoId from the tab and hands it to the
// offscreen document, which streams audio through the local separation
// server and routes the resulting stems back to the tab.

const OFFSCREEN_URL = "offscreen.html";
const API_ROOT = "https://isolate443.duckdns.org";

const jobs = new Map(); // videoId -> { tabId, stage, ts }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[isolate] message:", msg.type, msg.videoId || "");
  if (msg.type === "ai-request") {
    handleRequest(msg.videoId, sender.tab?.id).catch((e) =>
      reportError(msg.videoId, String(e && e.message ? e.message : e))
    );
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
  if (job) job.ts = Date.now();
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

async function handleRequest(videoId, tabId, start) {
  if (!videoId || tabId == null) return;
  if (jobActive(jobs.get(videoId))) return;
  jobs.set(videoId, { tabId, stage: "extracting", ts: Date.now() });
  routeToTab({ type: "ai-progress", videoId, stage: "extracting" });

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
