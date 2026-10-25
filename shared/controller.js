// Runs in Instagram's page: injected by the agent-reels window on every load, and by
// `reels start` in browser mode. Exposes window.__reels to play, pause and set options.
(() => {
  if (window.top !== window || window.__reels) return;

  const opts = Object.assign({ autoAdvance: true, sound: true, autoplay: true }, window.__REELS_OPTS || {});

  const visibleVideo = () => {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      if (h * w > bestArea) {
        bestArea = h * w;
        best = v;
      }
    }
    return best;
  };

  const scroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  };

  // Scroll to the next reel's video: a reel is usually shorter than the window, so
  // scrolling by a fixed distance can skip one.
  const scrollToNext = (v) => {
    const videos = [...document.querySelectorAll("video")];
    const next = videos.slice(videos.indexOf(v) + 1).find((n) => n.getBoundingClientRect().top > v.getBoundingClientRect().top);
    if (next) {
      next.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      const s = scroller(v);
      if (s) s.scrollBy({ top: v.getBoundingClientRect().height, behavior: "smooth" });
    }
  };

  const ctl = {
    opts,
    play() {
      const v = visibleVideo();
      if (!v) return false;
      if (ctl.opts.sound) v.muted = false;
      v.play().catch(() => {
        // autoplay with sound was refused; play muted instead
        v.muted = true;
        v.play().catch(() => {});
      });
      return true;
    },
    pause() {
      document.querySelectorAll("video").forEach((v) => v.pause());
    },
    setOpts(next) {
      Object.assign(ctl.opts, next);
    },
  };
  window.__reels = ctl;

  // Auto-advance. Instagram reels end; a looping video is caught by its time jumping back.
  let current = null;
  let lastTime = 0;
  let advancing = false;
  setInterval(() => {
    if (!ctl.opts.autoAdvance) return;
    const v = visibleVideo();
    if (!v) return;
    if (v !== current) {
      current = v;
      lastTime = v.currentTime;
      advancing = false;
      return;
    }
    const wrapped = !v.paused && v.duration > 0 && lastTime > v.duration - 1.5 && v.currentTime < 1;
    lastTime = v.currentTime;
    if ((v.ended || wrapped) && !advancing) {
      advancing = true;
      // Wait a moment in case Instagram scrolls by itself, to avoid moving two reels.
      setTimeout(() => {
        if (visibleVideo() !== v) return;
        scrollToNext(v);
        setTimeout(() => ctl.play(), 900);
      }, 1200);
    }
  }, 300);

  // Window controls, only in the agent-reels window: some window managers (Hyprland,
  // Sway) draw no title bar there. A browser window has its own.
  if (opts.windowControls) {
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

    // Hyprland won't move a pinned window, so unpin it for the drag and pin it again
    // once the pointer is back over the window with no button held.
    let repin = null;
    const pinAgain = () => {
      if (!repin) return;
      clearTimeout(repin);
      repin = null;
      invoke("set_pinned", { pinned: true });
    };
    window.addEventListener("mousemove", (e) => e.buttons === 0 && pinAgain(), true);
    const moveWindow = async () => {
      try {
        await invoke("set_pinned", { pinned: false });
        repin = setTimeout(pinAgain, 15000);
        await invoke("plugin:window|start_dragging", { label: "main" });
      } catch {
        pinAgain();
      }
    };

    // Styled through the CSSOM: Instagram's CSP may block an injected <style> tag.
    const el = (id, title, css) => {
      const d = document.createElement("div");
      d.id = id;
      d.title = title;
      Object.assign(d.style, { position: "fixed", zIndex: "2147483647" }, css);
      return d;
    };
    const addControls = () => {
      if (document.getElementById("__reels-drag")) return;
      const drag = el("__reels-drag", "Drag to move", { top: "0", left: "0", right: "0", height: "14px", cursor: "grab" });
      const pill = el("__reels-pill", "", {
        position: "absolute", top: "5px", left: "50%", width: "44px", height: "4px", marginLeft: "-22px",
        borderRadius: "2px", background: "rgba(255,255,255,.4)", opacity: "0", transition: "opacity .15s",
      });
      drag.append(pill);
      drag.addEventListener("mouseenter", () => (pill.style.opacity = "1"));
      drag.addEventListener("mouseleave", () => (pill.style.opacity = "0"));
      drag.addEventListener("mousedown", (e) => {
        if (e.button === 0) moveWindow();
      });
      const grip = el("__reels-grip", "Drag to resize", {
        right: "0", bottom: "0", width: "16px", height: "16px", cursor: "nwse-resize",
        background: "linear-gradient(135deg, transparent 55%, rgba(255,255,255,.4) 55%, rgba(255,255,255,.4) 62%, transparent 62%, transparent 72%, rgba(255,255,255,.4) 72%, rgba(255,255,255,.4) 79%, transparent 79%)",
      });
      grip.addEventListener("mousedown", (e) => {
        if (e.button === 0) invoke("plugin:window|start_resize_dragging", { label: "main", value: "SouthEast" });
      });
      // Attached to <html>, outside Instagram's React root, so re-renders leave them alone.
      document.documentElement.append(drag, grip);
    };
    // Middle-click and drag anywhere to move the window.
    window.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 1) return;
        e.preventDefault(); // no autoscroll
        e.stopPropagation();
        moveWindow();
      },
      true,
    );
    window.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault(), true);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addControls);
    else addControls();
  }

  // Start playing as soon as the first reel has loaded.
  if (opts.autoplay) {
    const started = Date.now();
    const kick = setInterval(() => {
      const v = visibleVideo();
      if ((v && v.readyState >= 2 && ctl.play()) || Date.now() - started > 30000) clearInterval(kick);
    }, 500);
  }
})();
