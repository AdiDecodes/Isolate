(() => {
  "use strict";

  // Runs in the page's MAIN world. Owns AI stem playback (cloud Demucs),
  // synced to the video element. No local separation: until stems cover the
  // current position, the video's native audio plays untouched.

  const MSG = "cc-isolate";
  const MODES = ["vocals", "whole", "bgm"];
  const GRANULE_SECONDS = 0.5;
  const LOOKAHEAD_SECONDS = 1.2;
  const DRIFT_LIMIT = 0.12;

  let mode = "whole";
  let ctx = null;
  let hookedCount = 0;
  const hooked = new WeakSet();
  const videos = new Set();

  function hookVideos() {
    if (!ctx || ctx.state !== "running") return;
    for (const video of document.querySelectorAll("video")) {
      if (hooked.has(video)) continue;
      try {
        hooked.add(video);
        hookedCount++;
        attachVideoEvents(video);
        videos.add(video);
        if (stemsActive) useStems(true);
      } catch (e) {
        /* unexpected */
      }
    }
  }

  function ensureAudio() {
    if (!ctx) {
      // Playback context for AI stem buffers only; the video's own audio
      // plays natively unless stems take over.
      ctx = new AudioContext({ latencyHint: "playback" });
    }
    if (ctx.state === "suspended") {
      ctx.resume().then(hookVideos).catch(() => {});
      return;
    }
    hookVideos();
  }

  document.addEventListener("pointerdown", ensureAudio, true);
  document.addEventListener("keydown", ensureAudio, true);

  /* ---------------- AI stems ---------------- */

  const ai = {
    enabled: false,
    videoId: null,
    waiting: false,
    segments: [], // { startFrame, frames, sr, vocalsL, vocalsR, bgmL, bgmR, vocalsBuf, bgmBuf }
    sources: [],
    sched: null, // { untilFrame, nextWhen, anchorFrame, anchorWhen }
  };

  function getVideo() {
    for (const v of videos) if (!v.paused || v.currentTime > 0) return v;
    return videos.values().next().value || null;
  }

  function parkVideo(video) {
    try {
      video.pause();
      video.currentTime = 0;
    } catch (e) {}
  }

  function stemsCover(frame) {
    return ai.segments.some((s) => frame >= s.startFrame && frame < s.startFrame + s.frames);
  }

  function segmentAt(frame) {
    return ai.segments.find((s) => frame >= s.startFrame && frame < s.startFrame + s.frames) || null;
  }

  function stopStems() {
    for (const src of ai.sources) {
      try {
        src.stop();
      } catch (e) {
        /* already stopped */
      }
    }
    ai.sources = [];
    ai.sched = null;
  }

  // While stems play, the video's native audio is muted; restored exactly
  // as the user left it when stems stop.
  let stemsActive = false;
  const nativeMuted = new WeakMap();

  function useStems(active) {
    stemsActive = active;
    for (const video of videos) {
      if (active) {
        if (!nativeMuted.has(video)) nativeMuted.set(video, video.muted);
        video.muted = true;
      } else if (nativeMuted.has(video)) {
        video.muted = nativeMuted.get(video);
        nativeMuted.delete(video);
      }
    }
  }

  function rescheduleStems(video) {
    stopStems();
    if (!ctx || ctx.state !== "running" || video.paused) return;
    const sr = ai.segments[0]?.sr || 44100;
    const nowFrame = video.currentTime * sr;
    if (!stemsCover(nowFrame)) return;

    ai.sched = {
      untilFrame: nowFrame,
      nextWhen: ctx.currentTime + 0.06,
      anchorFrame: nowFrame,
      anchorWhen: ctx.currentTime + 0.06,
    };
    ai.sources = [];
    scheduleAhead(video);
  }

  function scheduleAhead(video) {
    const sched = ai.sched;
    if (!sched) return;
    const sr = ai.segments[0]?.sr || 44100;
    const rate = video.playbackRate || 1;

    // Skip over any granule time that has already passed.
    const now = ctx.currentTime;
    if (sched.nextWhen < now) {
      const skipped = Math.round((now - sched.nextWhen) * rate * sr);
      sched.untilFrame += skipped;
      sched.nextWhen = now;
      sched.anchorFrame += skipped;
      sched.anchorWhen = now;
    }

    while (sched.untilFrame < (video.currentTime + LOOKAHEAD_SECONDS) * sr) {
      const seg = segmentAt(sched.untilFrame);
      if (!seg) return; // stems not ready this far ahead -> fallback on next tick

      const segOff = sched.untilFrame - seg.startFrame;
      const granule = Math.min(
        Math.round(GRANULE_SECONDS * sr),
        seg.startFrame + seg.frames - sched.untilFrame
      );

      const stem = mode === "bgm" ? getStemBuffer(seg, "bgm") : getStemBuffer(seg, "vocals");
      if (!stem) return;

      const src = ctx.createBufferSource();
      src.buffer = stem;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      src.start(sched.nextWhen, segOff / seg.sr, granule / seg.sr);
      ai.sources.push(src);

      sched.nextWhen += granule / seg.sr / rate;
      sched.untilFrame += granule;
    }
  }

  function getStemBuffer(seg, kind) {
    if (kind === "vocals") {
      if (!seg.vocalsBuf && ctx) {
        seg.vocalsBuf = ctx.createBuffer(2, seg.frames, seg.sr);
        seg.vocalsBuf.copyToChannel(seg.vocalsL, 0);
        seg.vocalsBuf.copyToChannel(seg.vocalsR, 1);
        seg.vocalsL = null;
        seg.vocalsR = null;
      }
      return seg.vocalsBuf;
    }
    if (!seg.bgmBuf && ctx) {
      seg.bgmBuf = ctx.createBuffer(2, seg.frames, seg.sr);
      seg.bgmBuf.copyToChannel(seg.bgmL, 0);
      seg.bgmBuf.copyToChannel(seg.bgmR, 1);
      seg.bgmL = null;
      seg.bgmR = null;
    }
    return seg.bgmBuf;
  }

  function aiTick() {
    const video = getVideo();
    if (!ai.enabled || !video || !ctx || ctx.state !== "running" || mode === "whole") {
      if (ai.sources.length) stopStems();
      useStems(false);
      return;
    }

    // Waiting for full separation: keep the video parked at 0:00.
    if (ai.waiting) {
      if (!video.paused) video.pause();
      if (video.currentTime > 0.05) parkVideo(video);
      useStems(false);
      return;
    }

    if (video.paused) {
      if (ai.sources.length) stopStems();
      useStems(false);
      return;
    }

    const sr = ai.segments[0]?.sr || 44100;
    const videoFrame = video.currentTime * sr;
    const sched = ai.sched;

    if (!sched) {
      if (!stemsCover(videoFrame)) {
        useStems(false);
        return;
      }
      rescheduleStems(video);
      useStems(true);
      return;
    }

    // drift check
    const rate = video.playbackRate || 1;
    const stemNow = sched.anchorFrame + Math.max(0, ctx.currentTime - sched.anchorWhen) * rate * sr;
    if (Math.abs(stemNow - videoFrame) > DRIFT_LIMIT * sr) {
      rescheduleStems(video);
      useStems(true);
      scheduleAhead(video);
      return;
    }

    if (!stemsCover(sched.untilFrame)) {
      // ran to the edge of ready stems — fall back until more arrive
      stopStems();
      useStems(false);
      return;
    }

    useStems(true);
    scheduleAhead(video);
  }
  setInterval(aiTick, 200);

  function attachVideoEvents(video) {
    const onDisturb = () => {
      if (ai.enabled && mode !== "whole") rescheduleStems(video);
    };
    video.addEventListener("seeking", onDisturb);
    video.addEventListener("ratechange", onDisturb);
    video.addEventListener("play", onDisturb);
    video.addEventListener("pause", () => {
      stopStems();
      useStems(false);
    });
  }

  function resetAi(videoId) {
    stopStems();
    ai.segments = [];
    ai.videoId = videoId;
    ai.waiting = ai.enabled;
    const video = getVideo();
    if (video && ai.waiting) parkVideo(video);
    useStems(false);
  }

  /* ---------------- messages from the extension ---------------- */

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.type !== MSG) return;
    const d = e.data;

    if (d.kind === "mode" && MODES.includes(d.mode)) {
      mode = d.mode;
      if (mode === "whole") {
        stopStems();
        useStems(false);
      } else {
        const video = getVideo();
        if (video) rescheduleStems(video);
      }
    } else if (d.kind === "ai-state") {
      if (d.videoId !== ai.videoId) resetAi(d.videoId);
      ai.enabled = !!d.aiEnabled;
      const wasWaiting = ai.waiting;
      ai.waiting = ai.enabled && !!d.waiting;
      if (!ai.waiting) {
        stopStems();
        useStems(false);
      } else if (!wasWaiting) {
        const video = getVideo();
        if (video) parkVideo(video);
      }
    } else if (d.kind === "ai-done") {
      ai.waiting = false;
      const video = getVideo();
      if (video && ai.enabled) {
        try {
          video.currentTime = 0;
          video.play().catch(() => {});
        } catch (e) {}
      }
    } else if (d.kind === "ai-segment") {
      ai.segments.push({
        startFrame: d.startFrame,
        frames: d.vocalsL.length,
        sr: d.sampleRate,
        vocalsL: new Float32Array(d.vocalsL),
        vocalsR: new Float32Array(d.vocalsR),
        bgmL: new Float32Array(d.bgmL),
        bgmR: new Float32Array(d.bgmR),
        vocalsBuf: null,
        bgmBuf: null,
      });
      const video = getVideo();
      if (ai.enabled && video && !video.paused && !ai.sched && mode !== "whole") {
        rescheduleStems(video);
      }
    } else if (d.kind === "get-meta") {
      pushMeta();
    }
  });

  new MutationObserver(hookVideos).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(hookVideos, 2000);

  function pushMeta() {
    let pr = null;
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        pr = player.getPlayerResponse();
      }
    } catch (e) {}
    if (!pr || !pr.microformat) {
      pr = window.ytInitialPlayerResponse;
    }
    const micro = pr?.microformat?.playerMicroformatRenderer;
    window.postMessage(
      {
        type: MSG,
        kind: "meta",
        isMusic: location.hostname === "music.youtube.com" || micro?.category === "Music",
      },
      window.location.origin
    );
  }
  document.addEventListener("yt-navigate-finish", pushMeta);
  pushMeta();

  window.postMessage({ type: MSG, kind: "ready" }, window.location.origin);

  // Diagnostics for support/debugging.
  Object.defineProperty(window, "__ccIsolate", {
    value: {
      status: () => {
        const video = getVideo();
        const s0 = ai.segments[0];
        return {
          mode,
          ctxState: ctx ? ctx.state : "none",
          hooked: hookedCount,
          aiEnabled: ai.enabled,
          aiVideoId: ai.videoId,
          aiSegments: ai.segments.length,
          aiStemsPlaying: ai.sources.length,
          aiCoveredSeconds: ai.segments.reduce((a, s) => a + s.frames, 0) / (s0?.sr || 44100),
          videoTime: video ? video.currentTime : null,
          videoPaused: video ? video.paused : null,
          firstSegment: s0
            ? {
                startFrame: s0.startFrame,
                frames: s0.frames,
                sr: s0.sr,
                hasVocalsL: !!s0.vocalsL,
              }
            : null,
        };
      },
      ctx: () => ctx,
    },
  });
})();
