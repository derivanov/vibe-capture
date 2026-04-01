// shared.mjs — Shared logic between server.mjs and capture.mjs

// ---- Scroll easing ----
// Quadratic ease-in, constant cruise, quadratic ease-out.
// Total time = distance / speed + easeDuration
export function calcScrollY(t, totalTime, totalDist, ease) {
  const E = Math.min(ease, totalTime / 2);
  const S = totalDist / (totalTime - E);
  if (t <= 0) return 0;
  if (t >= totalTime) return totalDist;
  if (t < E) return S / (2 * E) * t * t;
  const easeInDist = S * E / 2;
  const cruiseEnd = totalTime - E;
  if (t < cruiseEnd) return easeInDist + S * (t - E);
  const u = t - cruiseEnd;
  return easeInDist + S * (cruiseEnd - E) + S * u - S / (2 * E) * u * u;
}

// ---- Time virtualization code (injected into target page via evaluateOnNewDocument) ----
// This function is serialized to a string, so it must be self-contained with no external references.
export function timeVirtualization() {
  let capturing = false;
  let virtualTime = 0;
  let timeOrigin = 0;

  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const origPerfNow = performance.now.bind(performance);
  const origDateNow = Date.now;

  let rafId = 0;
  const rafCallbacks = new Map();
  let timerId = 2000000;
  const pendingTimers = new Map();

  window.requestAnimationFrame = (cb) => {
    if (!capturing) return origRAF(cb);
    const id = ++rafId;
    rafCallbacks.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (!capturing) return origCAF(id);
    rafCallbacks.delete(id);
  };
  window.setTimeout = (cb, delay = 0, ...a) => {
    if (!capturing) return origSetTimeout(cb, delay, ...a);
    const id = ++timerId;
    pendingTimers.set(id, {
      callback: typeof cb === 'function' ? () => cb(...a) : () => {},
      triggerTime: virtualTime + Math.max(0, delay), interval: 0,
    });
    return id;
  };
  window.setInterval = (cb, interval = 0, ...a) => {
    if (!capturing) return origSetInterval(cb, interval, ...a);
    const id = ++timerId;
    pendingTimers.set(id, {
      callback: typeof cb === 'function' ? () => cb(...a) : () => {},
      triggerTime: virtualTime + Math.max(0, interval),
      interval: Math.max(1, interval),
    });
    return id;
  };
  window.clearTimeout = (id) => {
    if (pendingTimers.has(id)) pendingTimers.delete(id); else origClearTimeout(id);
  };
  window.clearInterval = (id) => {
    if (pendingTimers.has(id)) pendingTimers.delete(id); else origClearInterval(id);
  };

  Object.defineProperty(performance, 'now', {
    value: () => (capturing ? virtualTime : origPerfNow()),
    writable: true, configurable: true,
  });
  Date.now = () => (capturing ? timeOrigin + virtualTime : origDateNow());

  const OrigDate = window.Date;
  function VDate(...d) {
    if (d.length === 0 && capturing) return new OrigDate(timeOrigin + virtualTime);
    return new OrigDate(...d);
  }
  VDate.prototype = OrigDate.prototype;
  VDate.now = Date.now;
  VDate.parse = OrigDate.parse;
  VDate.UTC = OrigDate.UTC;
  window.Date = VDate;

  let captureStartVT = 0;

  // ---- Find the real scroll container ----
  // Many modern sites (SPAs, React, Next.js) don't scroll <body> —
  // they scroll a nested <div> with overflow:auto/scroll.
  // This function finds the deepest element with significant scrollable content.
  function findScrollContainer() {
    // Check document-level scroll first
    const docScrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (docScrollable > 50) return null; // null = use window.scrollTo (document scroll)

    // Walk all elements, find the one with the most scrollable content
    let best = null;
    let bestDist = 50; // minimum threshold to consider "scrollable"
    const candidates = document.querySelectorAll('*');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const dist = el.scrollHeight - el.clientHeight;
      if (dist > bestDist) {
        const style = window.getComputedStyle(el);
        const ov = style.overflowY;
        if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
          best = el;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  // ---- Custom scroll engine ----
  // During capture we replace native scroll with our own.
  // Wheel/keyboard events set a target; each virtual frame smoothly
  // interpolates toward it. Programmatic scrollTo/scrollBy from page
  // scripts update the target too (so "back to top" buttons work).
  let scrollTarget = 0;
  let scrollCurrent = 0;
  const SCROLL_K = 0.004;
  let insideOurScroll = false; // guard to ignore our own scrollTo calls
  let scrollContainer = null; // null = document/window scroll, Element = container scroll

  // Helpers to get/set scroll position regardless of container type
  function getScrollY() {
    return scrollContainer ? scrollContainer.scrollTop : window.scrollY;
  }
  function getMaxScroll() {
    return scrollContainer
      ? scrollContainer.scrollHeight - scrollContainer.clientHeight
      : document.documentElement.scrollHeight - window.innerHeight;
  }
  function setScrollY(y) {
    if (scrollContainer) {
      scrollContainer.scrollTop = y;
    } else {
      origScrollTo(0, y);
    }
  }

  // Save originals before override
  const origScrollTo = window.scrollTo.bind(window);
  const origScrollBy = window.scrollBy.bind(window);

  // Override scrollTo — during capture, redirect to our scroll engine
  window.scrollTo = function (...args) {
    if (!capturing || insideOurScroll) return origScrollTo(...args);
    let y;
    if (args.length === 1 && typeof args[0] === 'object') {
      y = args[0].top;
    } else {
      y = args[1];
    }
    if (y !== undefined && isFinite(y)) {
      const ms = getMaxScroll();
      scrollTarget = Math.max(0, Math.min(y, ms));
      scrollCurrent = scrollTarget; // snap for programmatic scroll
      setScrollY(Math.round(scrollTarget));
    }
  };

  // Override scrollBy — during capture, redirect to our scroll engine
  window.scrollBy = function (...args) {
    if (!capturing || insideOurScroll) return origScrollBy(...args);
    let dy;
    if (args.length === 1 && typeof args[0] === 'object') {
      dy = args[0].top;
    } else {
      dy = args[1];
    }
    if (dy !== undefined && isFinite(dy)) {
      const ms = getMaxScroll();
      scrollTarget = Math.max(0, Math.min(scrollTarget + dy, ms));
      scrollCurrent = scrollTarget;
      setScrollY(Math.round(scrollTarget));
    }
  };

  // Override Element.prototype.scrollIntoView — redirect to our engine
  const origScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (opts) {
    if (!capturing) return origScrollIntoView.call(this, opts);
    const rect = this.getBoundingClientRect();
    const y = getScrollY() + rect.top;
    const ms = getMaxScroll();
    scrollTarget = Math.max(0, Math.min(y, ms));
    scrollCurrent = scrollTarget;
    setScrollY(Math.round(scrollTarget));
  };

  // Expose scroll info for server/CLI to query
  window.__vibeGetScrollInfo = () => {
    const container = findScrollContainer();
    if (container) {
      return {
        scrollable: true,
        distance: container.scrollHeight - container.clientHeight,
        isContainer: true,
      };
    }
    const dist = document.documentElement.scrollHeight - window.innerHeight;
    return {
      scrollable: dist > 0,
      distance: Math.max(0, dist),
      isContainer: false,
    };
  };

  window.__vibeStartCapture = () => {
    capturing = true;
    virtualTime = origPerfNow();
    timeOrigin = origDateNow() - virtualTime;
    captureStartVT = virtualTime;

    // Detect scroll container
    scrollContainer = findScrollContainer();
    scrollTarget = getScrollY();
    scrollCurrent = getScrollY();

    window.addEventListener('wheel', (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      const ms = getMaxScroll();
      scrollTarget = Math.max(0, Math.min(scrollTarget + e.deltaY * 0.5, ms));
    }, { passive: false, capture: true });

    window.addEventListener('keydown', (e) => {
      if (!capturing) return;
      const map = { ArrowDown: 80, ArrowUp: -80, PageDown: 600, PageUp: -600 };
      if (map[e.key] !== undefined) {
        e.preventDefault();
        const ms = getMaxScroll();
        scrollTarget = Math.max(0, Math.min(scrollTarget + map[e.key] * 0.5, ms));
      }
    }, { capture: true });

    // Pause all media elements and record their start position
    document.querySelectorAll('video, audio').forEach(el => {
      el.__vibeStart = el.currentTime;
      el.pause();
    });

    // Pause all CSS / Web Animations and record their start time
    if (document.getAnimations) {
      document.getAnimations().forEach(a => {
        a.__vibeStart = a.currentTime || 0;
        a.pause();
      });
    }
  };

  window.__vibeAdvanceFrame = (dt) => {
    if (!capturing) return;
    virtualTime += dt;

    // Smooth scroll toward target in virtual time
    const diff = scrollTarget - scrollCurrent;
    if (Math.abs(diff) > 0.5) {
      scrollCurrent += diff * (1 - Math.exp(-SCROLL_K * dt));
    } else {
      scrollCurrent = scrollTarget;
    }
    insideOurScroll = true;
    setScrollY(Math.round(scrollCurrent));
    insideOurScroll = false;

    // Fire expired timers
    const toFire = [];
    for (const [id, timer] of pendingTimers) {
      if (timer.triggerTime <= virtualTime) toFire.push({ id, ...timer });
    }
    toFire.sort((a, b) => a.triggerTime - b.triggerTime);
    for (const t of toFire) {
      pendingTimers.delete(t.id);
      if (t.interval > 0) pendingTimers.set(t.id, { callback: t.callback, triggerTime: t.triggerTime + t.interval, interval: t.interval });
    }
    for (const t of toFire) { try { t.callback(); } catch {} }

    // Fire rAF callbacks
    const cbs = new Map(rafCallbacks);
    rafCallbacks.clear();
    for (const [, cb] of cbs) { try { cb(virtualTime); } catch {} }

    // Sync media elements (video/audio) to virtual time position
    const elapsedMs = virtualTime - captureStartVT;
    document.querySelectorAll('video, audio').forEach(el => {
      if (el.__vibeStart === undefined) {
        el.__vibeStart = el.currentTime;
        el.pause();
      }
      const dur = el.duration;
      if (!dur || !isFinite(dur)) return;
      let t = el.__vibeStart + elapsedMs / 1000;
      if (el.loop) {
        t = t % dur;
      } else {
        t = Math.min(t, dur);
      }
      if (t >= 0) el.currentTime = t;
    });

    // Sync CSS / Web Animations to virtual time position.
    // For animations that start mid-capture (e.g. hover transitions),
    // we compute __vibeStart so that the CURRENT position is preserved
    // and subsequent frames advance correctly from there.
    if (document.getAnimations) {
      document.getAnimations().forEach(a => {
        if (a.__vibeStart === undefined) {
          // offset = currentTime - elapsedMs → so that:
          //   a.currentTime = offset + elapsedMs = currentTime (now)
          //   a.currentTime = offset + (elapsedMs + dt) = currentTime + dt (next frame)
          a.__vibeStart = (a.currentTime || 0) - elapsedMs;
          a.pause();
        }
        try { a.currentTime = a.__vibeStart + elapsedMs; } catch {}
      });
    }

    // Return promise if any videos are still seeking
    const seeking = Array.from(document.querySelectorAll('video')).filter(v => v.seeking);
    if (seeking.length > 0) {
      return Promise.all(seeking.map(v =>
        new Promise(r => v.addEventListener('seeked', r, { once: true }))
      ));
    }
    return null;
  };
}

// ---- Cursor overlay helpers ----

const CURSOR_STYLE = [
  'position: fixed',
  'width: 16px',
  'height: 16px',
  'border-radius: 50%',
  'background: white',
  'box-shadow: 0 1px 4px rgba(0,0,0,0.35)',
  'pointer-events: none',
  'z-index: 2147483647',
  'transition: background 0.05s ease',
  'transform: translate(-50%, -50%)',
  'top: -100px',
  'left: -100px',
].join(';');

export async function injectCursorOverlay(page) {
  await page.evaluate((cssText) => {
    const style = document.createElement('style');
    style.id = '__vibeCursorStyle';
    style.textContent = '* { cursor: none !important; }';
    document.head.appendChild(style);

    const cursor = document.createElement('div');
    cursor.id = '__vibeCursor';
    cursor.style.cssText = cssText;
    document.body.appendChild(cursor);

    document.addEventListener('mousemove', (e) => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    }, true);

    document.addEventListener('mousedown', () => {
      cursor.style.background = 'rgba(0,0,0,0.45)';
      cursor.style.transition = 'background 0.01s';
    }, true);
    document.addEventListener('mouseup', () => {
      cursor.style.background = 'white';
      cursor.style.transition = 'background 0.15s ease';
    }, true);
  }, CURSOR_STYLE);
}

export async function removeCursorOverlay(page) {
  await page.evaluate(() => {
    const style = document.getElementById('__vibeCursorStyle');
    if (style) style.remove();
    const cursor = document.getElementById('__vibeCursor');
    if (cursor) cursor.remove();
  }).catch(() => {});
}

// ---- FFmpeg argument building ----
// Builds the ffmpeg argument array for encoding frames into video.
// Returns the full args array (excluding the 'ffmpeg' binary itself).
export function buildFfmpegArgs({ fps, inputPattern, outputPath, prores, preset, crf, tune, profile, pixFmt }) {
  const args = [
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
  ];
  if (prores) {
    args.push(
      '-c:v', 'prores_ks',
      '-profile:v', '3',
      '-pix_fmt', 'yuv422p10le',
      '-vendor', 'apl0',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
    );
    if (tune && tune !== 'none') {
      args.push('-tune', tune);
    }
    args.push(
      '-profile:v', profile === 'high444' ? 'high444' : profile,
      '-pix_fmt', pixFmt,
      '-movflags', '+faststart',
    );
  }
  args.push(outputPath);
  return args;
}
