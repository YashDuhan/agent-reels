// Runs in Instagram's page: injected by the agent-reels window on every load, and by
// `reels start` in browser mode. Exposes window.__reels to play, pause and set options.
(() => {
  if (window.top !== window || window.__reels) return;

  // Instagram replaces the timer functions after this runs, and its clearInterval
  // doesn't stop intervals made with the originals, so keep the originals.
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  const setTimeout = window.setTimeout.bind(window);
  const clearTimeout = window.clearTimeout.bind(window);

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

  // Instagram keeps its own mute setting, muted at first, and applies it to every reel it
  // plays, so unmuting only the <video> lasts one reel. Flip its control (found by its
  // English label) to match, and set the <video> too in case the label differs.
  const soundIcon = (v) => {
    const r = v.getBoundingClientRect();
    return [...document.querySelectorAll('svg[aria-label="Audio is muted"], svg[aria-label="Audio is playing"]')].find((s) => {
      const q = s.getBoundingClientRect();
      return q.top >= r.top && q.bottom <= r.bottom;
    });
  };
  let lastUserClick = 0;
  const syncSound = (v) => {
    // Until the click handler below has read Instagram's new state, our setting is stale.
    if (Date.now() - lastUserClick < 1000) return;
    const svg = soundIcon(v);
    const on = svg?.getAttribute("aria-label") === "Audio is playing";
    if (svg && on !== ctl.opts.sound) (svg.closest('[role="button"],button') || svg.parentElement).click();
    v.muted = !ctl.opts.sound;
  };

  // A click on Instagram's sound control, or on the reel, which also toggles it, wins:
  // adopt Instagram's new state so the next reel doesn't switch it back. Our own clicks
  // in syncSound aren't trusted events, so they're ignored here.
  window.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return;
      lastUserClick = Date.now();
      setTimeout(() => {
        const v = visibleVideo();
        const svg = v && soundIcon(v);
        if (svg) ctl.opts.sound = svg.getAttribute("aria-label") === "Audio is playing";
      }, 300);
    },
    true,
  );

  const ctl = {
    opts,
    play() {
      const v = visibleVideo();
      if (!v) return false;
      syncSound(v);
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
      const sound = ctl.opts.sound;
      Object.assign(ctl.opts, next);
      const v = visibleVideo();
      if (v && ctl.opts.sound !== sound) syncSound(v);
    },
    toggleSound() {
      ctl.setOpts({ sound: !ctl.opts.sound });
      return ctl.opts.sound;
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

    // Always on top, switched from the right-click menu and remembered in this page's
    // storage. The window opens on top, so only "off" needs applying.
    const ON_TOP_KEY = "__reels_on_top";
    let onTop = true;
    try {
      onTop = localStorage.getItem(ON_TOP_KEY) !== "0";
    } catch {}
    if (!onTop) invoke("set_on_top", { on: false });
    const setOnTop = (on) => {
      onTop = on;
      try {
        localStorage.setItem(ON_TOP_KEY, on ? "1" : "0");
      } catch {}
      invoke("set_on_top", { on });
    };

    // Hyprland won't move a pinned window, so unpin it for the drag and pin it again
    // once the pointer is back over the window with no button held.
    let repin = null;
    const pinAgain = () => {
      if (!repin) return;
      clearTimeout(repin);
      repin = null;
      if (onTop) invoke("set_pinned", { pinned: true });
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
      // Leaves room for the close button at the right end.
      const dragRight = "28px";
      const drag = el("__reels-drag", "Drag to move", { top: "0", left: "0", right: dragRight, height: "14px", cursor: "grab" });
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
      const close = el("__reels-close", "Close reels", {
        top: "0", right: "0", width: "28px", height: "22px", lineHeight: "20px", textAlign: "center",
        font: "18px/20px system-ui, sans-serif", color: "#fff", cursor: "pointer",
        background: "rgba(0,0,0,.35)", borderBottomLeftRadius: "8px", opacity: ".55", transition: "opacity .15s, background .15s",
      });
      close.textContent = "×";
      close.addEventListener("mouseenter", () => Object.assign(close.style, { opacity: "1", background: "#e81123" }));
      close.addEventListener("mouseleave", () => Object.assign(close.style, { opacity: ".55", background: "rgba(0,0,0,.35)" }));
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      close.addEventListener("click", () => invoke("quit_player"));
      // Attached to <html>, outside Instagram's React root, so re-renders leave them alone.
      document.documentElement.append(drag, grip, close);
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

    // Right-click menu, in place of the webview's own: one item, "Always on top".
    let menu = null;
    const closeMenu = () => {
      menu?.remove();
      menu = null;
    };
    window.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        menu = el("__reels-menu", "", {
          left: `${Math.min(e.clientX, innerWidth - 170)}px`, top: `${Math.min(e.clientY, innerHeight - 40)}px`,
          padding: "4px", borderRadius: "8px", background: "#262626", boxShadow: "0 4px 16px rgba(0,0,0,.5)",
          font: "13px system-ui, sans-serif", color: "#f5f5f5", userSelect: "none",
        });
        const item = el("__reels-menu-on-top", "", {
          position: "static", padding: "6px 10px", borderRadius: "5px", cursor: "pointer", whiteSpace: "nowrap",
        });
        item.textContent = `${onTop ? "✓" : " "}  Always on top`;
        item.addEventListener("mouseenter", () => (item.style.background = "#3a3a3a"));
        item.addEventListener("mouseleave", () => (item.style.background = ""));
        item.addEventListener("mousedown", (ev) => ev.stopPropagation());
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          setOnTop(!onTop);
          closeMenu();
        });
        menu.append(item);
        document.documentElement.append(menu);
      },
      true,
    );
    window.addEventListener("mousedown", (e) => menu && !menu.contains(e.target) && closeMenu(), true);
    window.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu(), true);
    window.addEventListener("blur", closeMenu);

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
