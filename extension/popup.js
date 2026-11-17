(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let lastState = null;

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function send(msg) {
    return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
  }

  function stageText(s) {
    switch (s.stage) {
      case "requested": return "Requested…";
      case "standby": return "Ready — press Separate now";
      case "blocked": return s.message || "Skipped";
      case "extracting": return s.label || "Resolving stream…";
      case "downloading": return s.pct != null ? `Audio ${s.pct}%` : "Downloading audio…";
      case "uploading": return s.pct != null ? `Uploading ${s.pct}%` : "Uploading…";
      case "cloud": return s.sec != null ? `Separating… ${s.sec}s` : "Separating…";
      case "decoding": return "Decoding…";
      case "cached-ready": return "Song cached — stems ready";
      case "cached": return s.pct != null ? `Cached stems ${s.pct}%` : "Loading cached stems…";
      case "separating": return s.pct != null ? `Stems ${s.pct}%` : "Delivering stems…";
      default: return s.stage;
    }
  }

  async function refresh() {
    const tab = await activeTab();
    if (!tab || tab.id == null) return;
    tabId = tab.id;

    let state = null;
    let stale = false;
    try {
      state = await chrome.tabs.sendMessage(tab.id, { type: "popup-get-state" });
    } catch (e) {
      stale = true;
    }

    const onVideo = !!(state && state.videoId);
    $("novideo").classList.toggle("hidden", onVideo);
    $("main").classList.toggle("hidden", !onVideo);
    if (!onVideo) {
      const isYt = /youtube\.com\/watch|music\.youtube\.com/.test(tab.url || "");
      $("novideoText").textContent = stale && isYt
        ? "Reload this tab to connect"
        : "Open a YouTube video";
      $("reloadTab").classList.toggle("hidden", !isYt);
      return;
    }
    $("reloadTab").classList.add("hidden");

    $("title").textContent = state.title || "Unknown title";
    $("vid").textContent = state.videoId;
    $("thumb").src = "https://i.ytimg.com/vi/" + state.videoId + "/mqdefault.jpg";

    for (const btn of document.querySelectorAll("#modes button")) {
      btn.classList.toggle("active", btn.dataset.mode === state.mode);
    }
    lastState = state;
    $("aiBtn").classList.toggle("active", !!state.aiEnabled);
    $("autoBtn").classList.toggle("active", state.autoSeparate !== false);
    $("sepNow").classList.toggle(
      "hidden",
      !(state.aiEnabled && state.autoSeparate === false)
    );

    const s = state.status || {};
    const statusBox = $("status");
    const errBox = $("errtext");
    if (s.stage === "error" || s.stage === "blocked") {
      statusBox.classList.add("hidden");
      errBox.classList.remove("hidden");
      errBox.textContent = s.message || (s.stage === "error" ? "Separation failed" : "Skipped");
      return;
    }
    errBox.classList.add("hidden");

    if (s.stage && s.stage !== "off") {
      statusBox.classList.remove("hidden");
      $("statusText").textContent = s.stage === "done" ? "Stems ready" : stageText(s);
      $("statusText").classList.remove("err");
      const pct = typeof s.pct === "number" ? s.pct : null;
      document.querySelector("#status .bar").classList.toggle(
        "hidden",
        pct === null || s.stage === "done"
      );
      if (pct !== null) $("fill").style.width = pct + "%";
    } else {
      statusBox.classList.add("hidden");
    }
  }

  for (const btn of document.querySelectorAll("#modes button")) {
    btn.addEventListener("click", async () => {
      await send({ type: "popup-set-mode", mode: btn.dataset.mode });
      refresh();
    });
  }

  $("aiBtn").addEventListener("click", async () => {
    await send({ type: "popup-toggle-ai", enable: !(lastState && lastState.aiEnabled) });
    refresh();
  });

  $("autoBtn").addEventListener("click", async () => {
    await send({ type: "popup-set-auto", value: !(lastState && lastState.autoSeparate !== false) });
    refresh();
  });

  $("sepNow").addEventListener("click", async () => {
    await send({ type: "popup-separate-now" });
    refresh();
  });

  $("reloadTab").addEventListener("click", async () => {
    if (tabId == null) return;
    await chrome.tabs.reload(tabId);
    setTimeout(refresh, 1200);
  });

  /* ---------------- account ---------------- */

  const SERVER = "https://isolate443.duckdns.org";

  function getToken() {
    return chrome.storage.local.get("token").then((d) => d.token || null);
  }

  async function refreshAccount() {
    const token = await getToken();
    if (!token) {
      $("acctOut").classList.remove("hidden");
      $("acctIn").classList.add("hidden");
      $("signin").classList.remove("hidden");
      $("signout").classList.add("hidden");
      // The sign-in may have completed while the service worker was dead —
      // nudge it to resume polling the parked token.
      const { authPendingCode } = await chrome.storage.local
        .get("authPendingCode")
        .catch(() => ({}));
      if (authPendingCode) {
        chrome.runtime
          .sendMessage({ type: "auth-begin", code: authPendingCode })
          .catch(() => {});
      }
      return;
    }
    let me = null;
    try {
      const res = await fetch(SERVER + "/me", {
        headers: { Authorization: "Bearer " + token },
      });
      console.log("[isolate] /me:", res.status);
      if (res.ok) me = await res.json();
      else if (res.status === 401) await chrome.storage.local.remove("token");
      else if (res.status === 403)
        me = {
          email: "Account blocked",
          blocked: true,
          limits: { dailyAudioMinutes: 0 },
          usage: { audioSeconds: 0 },
        };
    } catch (e) {}
    if (!me) {
      $("acctOut").classList.remove("hidden");
      $("acctIn").classList.add("hidden");
      $("signin").classList.remove("hidden");
      $("signout").classList.add("hidden");
      return;
    }
    $("acctOut").classList.add("hidden");
    $("signin").classList.add("hidden");
    $("acctIn").classList.remove("hidden");
    $("signout").classList.remove("hidden");
    $("acctEmail").textContent = me.blocked
      ? "Account blocked"
      : me.enabled === false
        ? "Account disabled"
        : me.email;
    const minsLeft = me.blocked
      ? null
      : Math.max(
          0,
          Math.round(me.limits.dailyAudioMinutes - me.usage.audioSeconds / 60)
        );
    $("acctUsageIn").textContent = me.blocked
      ? "—"
      : `${minsLeft} of ${me.limits.dailyAudioMinutes} min left today`;
  }

  $("signin").addEventListener("click", async () => {
    const code = crypto.randomUUID();
    // Persist before opening the tab: this popup dies when the tab takes
    // focus, and the stored code lets the service worker resume the poll
    // even if the auth-begin message is lost with it.
    await chrome.storage.local.set({ authPendingCode: code }).catch(() => {});
    try {
      await chrome.tabs.create({
        url: SERVER + "/auth?code=" + encodeURIComponent(code),
      });
    } catch (e) {}
    // Opening the tab closes this popup; the background service worker
    // owns the polling and stores the token, then broadcasts auth-ok.
    chrome.runtime.sendMessage({ type: "auth-begin", code }).catch(() => {});
    const btn = $("signin");
    btn.disabled = true;
    btn.textContent = "Waiting…";
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }, 5000);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "auth-ok") refreshAccount();
  });

  $("signout").addEventListener("click", async () => {
    const token = await getToken();
    if (token) {
      try {
        await fetch(SERVER + "/auth/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
        });
      } catch (e) {}
    }
    await chrome.storage.local.remove("token");
    await refreshAccount();
  });

  setInterval(refresh, 600);
  refresh();
  refreshAccount();
})();
