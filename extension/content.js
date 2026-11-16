(() => {
  "use strict";

  const MSG = "cc-isolate";
  const MODES = ["vocals", "whole", "bgm"];
  const FLOAT_ID = "cc-isolate-float";
  const FLOAT_LABEL_ID = "cc-isolate-float-label";

  let mode = "whole";
  let aiEnabled = false;
  let autoSeparate = true;
  let lastVideoId = null;
  let lastRequestedVideoId = null;
  let lastCacheCheck = null;
  let songCached = false;
  let lastIsMusic = false;

  /* ---------------- mode + AI plumbing ---------------- */

  function post(payload) {
    window.postMessage({ type: MSG, ...payload }, window.location.origin);
  }

  function sendMode(m) {
    post({ kind: "mode", mode: m });
  }

  function pushAiState() {
    const vid = currentVideoId();
    const waiting = aiEnabled && vid != null && lastRequestedVideoId === vid;
    post({ kind: "ai-state", aiEnabled, waiting, videoId: vid });
  }

  function applyMode(next, immediate = false) {
    mode = next;
    persist({ isolateMode: next });
    updateFloatingButton();
    if (!immediate) floatLabel(MODE_META[next].label);
    sendMode(next);
  }

  function persist(obj) {
    try {
      chrome.storage?.sync.set(obj);
    } catch (e) {
      /* storage unavailable */
    }
  }

  try {
    chrome.storage?.sync.get(["isolateMode", "aiEnabled", "autoSeparate"], (data) => {
      if (data && MODES.includes(data.isolateMode)) applyMode(data.isolateMode, true);
      if (data && typeof data.autoSeparate === "boolean") autoSeparate = data.autoSeparate;
      if (data && typeof data.aiEnabled === "boolean") {
        aiEnabled = data.aiEnabled;
        updateFloatingButton();
        pushAiState();
        requestIfNeeded();
      }
    });
  } catch (e) {
    /* ignore */
  }

  // Answer the main-world engine whenever it asks for the current state.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.type !== MSG) return;
    if (e.data.kind === "ready") {
      sendMode(mode);
      pushAiState();
      post({ kind: "get-meta" });
    } else if (e.data.kind === "meta") {
      lastIsMusic = !!e.data.isMusic;
      if (aiEnabled && !lastRequestedVideoId && currentVideoId()) requestIfNeeded();
      // Meta may arrive after the cache probe — retry the autofetch then.
      if (songCached && aiEnabled && lastIsMusic) requestIfNeeded(true);
    }
  });

  /* ---------------- results from the service worker ---------------- */

  // Last known AI job state, surfaced to the popup.
  let aiStatus = { stage: null, pct: null, sec: null, message: null };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type && msg.type.startsWith("popup-")) {
      handlePopup(msg, sendResponse);
      return false;
    }
    if (!msg || !msg.videoId || msg.videoId !== currentVideoId()) return;
    if (msg.type === "ai-progress") {
      aiStatus = { stage: msg.stage, pct: msg.pct ?? null, sec: msg.sec ?? null, label: msg.label ?? null, message: null };
      updateAiStatus(msg.stage, msg.pct, null, msg.sec);
      if (msg.stage === "done") {
        lastRequestedVideoId = msg.videoId;
        post({ kind: "ai-done" });
      }
    } else if (msg.type === "ai-segment") {
      const { type, ...rest } = msg;
      post({ kind: "ai-segment", ...rest });
    } else if (msg.type === "ai-ready") {
      // Enough cached stems are relayed to start playback; the job keeps
      // finishing in the background.
      lastRequestedVideoId = msg.videoId;
      post({ kind: "ai-ready" });
    } else if (msg.type === "ai-error") {
      lastRequestedVideoId = null;
      aiStatus = { stage: "error", pct: null, sec: null, message: msg.message };
      updateAiStatus("error", null, msg.message);
    }
  });

  function handlePopup(msg, sendResponse) {
    if (msg.type === "popup-get-state") {
      sendResponse({
        videoId: currentVideoId(),
        title: getVideoTitle(),
        mode,
        aiEnabled,
        autoSeparate,
        status: aiStatus,
      });
    } else if (msg.type === "popup-set-mode" && MODES.includes(msg.mode)) {
      applyMode(msg.mode);
      sendResponse({ ok: true });
    } else if (msg.type === "popup-toggle-ai") {
      if (msg.enable) {
        aiEnabled = true;
        persist({ aiEnabled });
        lastRequestedVideoId = null;
        updateFloatingButton();
        pushAiState();
        requestIfNeeded();
      } else {
        aiEnabled = false;
        persist({ aiEnabled: false });
        updateFloatingButton();
        pushAiState();
        updateAiStatus("off");
      }
      sendResponse({ ok: true });
    } else if (msg.type === "popup-set-auto") {
      autoSeparate = !!msg.value;
      persist({ autoSeparate });
      if (autoSeparate) requestIfNeeded();
      sendResponse({ ok: true });
    } else if (msg.type === "popup-separate-now") {
      lastRequestedVideoId = null;
      requestIfNeeded(true);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  }

  function getVideoTitle() {
    const h =
      document.querySelector("#title h1") ||
      document.querySelector("h1.ytd-watch-metadata") ||
      document.querySelector("ytmusic-player-page .title");
    return (h && h.textContent.trim()) || document.title.replace(/ - YouTube( Music)?$/, "");
  }

  function currentVideoId() {
    try {
      return new URLSearchParams(location.search).get("v") || null;
    } catch (e) {
      return null;
    }
  }

  function requestIfNeeded(force = false) {
    const videoId = currentVideoId();
    if (!videoId || !aiEnabled) return;
    if (videoId === lastRequestedVideoId) return;

    const video = document.querySelector("video");
    const duration = video && isFinite(video.duration) ? video.duration : null;
    if (!lastIsMusic) {
      aiStatus = { stage: "blocked", pct: null, sec: null, message: "Not a music video — skipped" };
      updateAiStatus("blocked", null, aiStatus.message);
      return;
    }
    if (duration == null) return; // metadata not loaded yet — retry on the next tick
    if (duration > 600) {
      aiStatus = { stage: "blocked", pct: null, sec: null, message: "Longer than 10 min — skipped" };
      updateAiStatus("blocked", null, aiStatus.message);
      return;
    }
    if (!autoSeparate && !force) {
      aiStatus = { stage: "standby", pct: null, sec: null, message: null };
      updateAiStatus("standby");
      return;
    }

    lastRequestedVideoId = videoId;
    try {
      chrome.runtime.sendMessage({ type: "ai-request", videoId });
    } catch (e) {
      lastRequestedVideoId = null;
    }
    aiStatus = { stage: "requested", pct: null, sec: null, message: null };
    updateAiStatus("requested");
  }

  // SPA navigation: new video -> reset engine state, wait for fresh meta.
  setInterval(() => {
    const videoId = currentVideoId();
    post({ kind: "get-meta" });
    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      lastRequestedVideoId = null;
      lastCacheCheck = null;
      songCached = false;
      aiStatus = { stage: null, pct: null, sec: null, message: null };
      pushAiState();
    }
    // Passive probe: is this song already separated on the server? If so,
    // light the FAB green and (when AI is on) fetch the stems right away.
    // requestIfNeeded is idempotent (lastRequestedVideoId guard), so calling
    // it every tick safely retries until the video metadata is ready.
    if (videoId && videoId !== lastCacheCheck) {
      lastCacheCheck = videoId;
      try {
        chrome.runtime.sendMessage({ type: "cache-check", videoId }, (res) => {
          if (chrome.runtime.lastError || !res || !res.cached) return;
          if (currentVideoId() !== videoId) return;
          songCached = true;
          indicateCached();
        });
      } catch (e) {}
    }
    if (songCached && aiEnabled && lastIsMusic) requestIfNeeded(true);
  }, 800);

  // Only surface the cached hint when nothing else is going on — never
  // overwrite an in-flight job, error, or done state.
  function indicateCached() {
    const idle =
      !aiStatus.stage || aiStatus.stage === "off" || aiStatus.stage === "standby";
    if (!idle) return;
    aiStatus = { stage: "cached-ready", pct: 100, sec: null, message: null };
    updateAiStatus("cached-ready", 100);
  }

  /* ---------------- floating mode button ---------------- */

  const MODE_META = {
    vocals: {
      label: "Vocals",
      color: "#ff4d6d",
      icon: '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>',
    },
    whole: {
      label: "Original",
      color: "#4da3ff",
      icon: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    },
    bgm: {
      label: "BGM",
      color: "#00d4a0",
      icon: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
    },
  };

  const RING_CIRC = 2 * Math.PI * 27;

  function ensureFloatingButton() {
    if (document.getElementById(FLOAT_ID)) return;
    const btn = document.createElement("button");
    btn.id = FLOAT_ID;
    btn.innerHTML =
      '<svg class="cc-ring" viewBox="0 0 62 62">' +
      '<circle class="cc-ring-track" cx="31" cy="31" r="27"/>' +
      '<circle class="cc-ring-bar" cx="31" cy="31" r="27"/>' +
      "</svg>" +
      '<span class="cc-float-icon"></span>';
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      applyMode(next);
    });
    const label = document.createElement("div");
    label.id = FLOAT_LABEL_ID;
    document.body.append(label, btn);
    updateFloatingButton();
  }

  function updateFloatingButton() {
    const btn = document.getElementById(FLOAT_ID);
    if (!btn) return;
    const meta = MODE_META[mode];
    btn.style.setProperty("--cc-accent", meta.color);
    const icon = btn.querySelector(".cc-float-icon");
    if (icon.dataset.mode !== mode) {
      icon.dataset.mode = mode;
      icon.innerHTML = meta.icon;
      icon.animate(
        [
          { transform: "scale(.3) rotate(-120deg)", opacity: 0 },
          { transform: "scale(1.15) rotate(10deg)", opacity: 1, offset: 0.7 },
          { transform: "scale(1) rotate(0deg)", opacity: 1 },
        ],
        { duration: 420, easing: "cubic-bezier(.2,.9,.25,1.15)" }
      );
    }
    btn.title = "Isolate: " + meta.label;
  }

  let labelTimer = null;
  function floatLabel(text, sticky = false) {
    const el = document.getElementById(FLOAT_LABEL_ID);
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(labelTimer);
    if (!sticky) labelTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  function updateRing(stage, pct) {
    const btn = document.getElementById(FLOAT_ID);
    if (!btn) return;
    const bar = btn.querySelector(".cc-ring-bar");
    if (!bar) return;
    btn.classList.remove("cc-ring-red", "cc-ring-orange", "cc-ring-green", "cc-ring-spin");
    let off = RING_CIRC;
    if (
      stage === "requested" ||
      stage === "extracting" ||
      stage === "downloading" ||
      stage === "uploading"
    ) {
      btn.classList.add("cc-ring-red");
      if (typeof pct === "number") off = RING_CIRC * (1 - pct / 100);
      else btn.classList.add("cc-ring-spin");
    } else if (stage === "cloud" || stage === "separating") {
      btn.classList.add("cc-ring-orange");
      if (typeof pct === "number") off = RING_CIRC * (1 - pct / 100);
      else btn.classList.add("cc-ring-spin");
    } else if (stage === "done") {
      btn.classList.add("cc-ring-green");
      off = 0;
    } else if (stage === "cached-ready") {
      // Song is already separated on the server: full green ring.
      btn.classList.add("cc-ring-green");
      off = 0;
    } else if (stage === "cached") {
      btn.classList.add("cc-ring-green");
      if (typeof pct === "number") off = RING_CIRC * (1 - pct / 100);
    }
    bar.style.strokeDashoffset = off;
  }

  function updateAiStatus(stage, pct, message, sec) {
    updateRing(stage, pct);
    let text = null;
    if (stage === "requested") text = "AI requested…";
    else if (stage === "extracting") text = "Resolving stream…";
    else if (stage === "downloading") text = pct != null ? `Fetching audio ${pct}%` : "Fetching audio…";
    else if (stage === "uploading") text = `Uploading ${pct ?? 0}%`;
    else if (stage === "cloud") text = sec != null ? `Separating… ${sec}s` : "Separating…";
    else if (stage === "decoding") text = "Decoding…";
    else if (stage === "cached-ready") text = "Cached — ready to isolate";
    else if (stage === "cached") text = pct != null ? `Cached stems ${pct}%` : "Loading cached stems…";
    else if (stage === "separating") text = pct != null ? `Separating ${pct}%` : "Separating…";
    else if (stage === "done") text = "AI stems ready";
    else if (stage === "off") text = "AI off";
    else if (stage === "error") text = "AI: " + (message || "failed");
    if (text) floatLabel(text, stage === "error");
  }

  /* ---------------- lifecycle ---------------- */

  function watchDOM() {
    const obs = new MutationObserver(() => ensureFloatingButton());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => ensureFloatingButton(), 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureFloatingButton();
      watchDOM();
    });
  } else {
    ensureFloatingButton();
    watchDOM();
  }
})();
