(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let tabId = null;

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
    $("aiToggle").checked = !!state.aiEnabled;
    $("autoToggle").checked = state.autoSeparate !== false;
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
      $("bar").classList.toggle("hidden", pct === null || s.stage === "done");
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

  $("aiToggle").addEventListener("change", async (e) => {
    await send({ type: "popup-toggle-ai", enable: e.target.checked });
    refresh();
  });

  $("autoToggle").addEventListener("change", async (e) => {
    await send({ type: "popup-set-auto", value: e.target.checked });
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

  setInterval(refresh, 600);
  refresh();
})();
