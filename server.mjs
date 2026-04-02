#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import { calcScrollY, timeVirtualization, injectCursorOverlay, removeCursorOverlay, buildFfmpegArgs } from './shared.mjs';

const PORT = 3000;
const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ---- Transliteration for filenames ----
const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i',
  'й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t',
  'у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y',
  'ь':'','э':'e','ю':'yu','я':'ya',
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I',
  'Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T',
  'У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y',
  'Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
  'ä':'ae','ö':'oe','ü':'ue','ß':'ss','Ä':'Ae','Ö':'Oe','Ü':'Ue',
  'é':'e','è':'e','ê':'e','ë':'e','à':'a','â':'a','ù':'u','û':'u','ô':'o','î':'i','ï':'i','ç':'c',
  'ñ':'n','å':'a','ø':'o',
};

function slugify(str) {
  // Transliterate known chars
  let s = '';
  for (const ch of str) {
    s += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch;
  }
  // Keep only ascii alphanumeric, spaces→dashes, collapse
  return s
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'recording';
}

// ---- State ----
let state = 'idle';
let browser = null;
let controlPage = null;
let targetPage = null;
let targetCDP = null;
let shouldStop = false;
let lastResult = null;

// Viewport tracking (CSS pixels & native DPR)
let cssW = 1920;
let cssH = 1080;
let nativeDPR = 2;
let currentDPR = 1; // actual DPR used (retina ? nativeDPR : 1)

// ---- HTTP Server ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(import.meta.dirname, 'ui', 'index.html')));
    return;
  }
  if (req.url?.startsWith('/recordings/')) {
    const filePath = path.join(process.cwd(), decodeURIComponent(req.url));
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fs.statSync(filePath).size,
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function setState(s, extra = {}) {
  state = s;
  broadcast({ type: 'state', state, ...extra });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'state', state,
    ...(lastResult && state === 'done' ? lastResult : {}),
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.action === 'open') {
        await handleOpen(msg);
        // Auto-record: start recording immediately after page opens
        if (msg.autoRecord && state === 'ready') {
          await handleRecord(msg);
        }
      }
      else if (msg.action === 'record') await handleRecord(msg);
      else if (msg.action === 'click') await handleClick(msg);
      else if (msg.action === 'stop') shouldStop = true;
      else if (msg.action === 'close') await handleClose();
    } catch (err) {
      broadcast({ type: 'error', message: err.message });
      if (state !== 'idle') await handleClose();
    }
  });
});

// ---- Handlers ----

async function handleOpen(msg) {
  if (state === 'recording' || state === 'encoding') return;
  setState('opening');
  lastResult = null;

  const { url, width = 1920, height = 1080, retina = false } = msg;

  // Always close old target page to avoid stale tabs
  if (targetPage) {
    try { await targetPage.close(); } catch {}
    targetPage = null;
    targetCDP = null;
  }

  // Create target page in a SEPARATE window
  const newPagePromise = new Promise((resolve) => {
    const handler = async (target) => {
      if (target.type() === 'page') {
        browser.off('targetcreated', handler);
        resolve(await target.page());
      }
    };
    browser.on('targetcreated', handler);
  });

  const browserCDP = await browser.target().createCDPSession();
  await browserCDP.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  });
  await browserCDP.detach();

  targetPage = await newPagePromise;
  targetCDP = await targetPage.createCDPSession();

  // Detect native DPR before any overrides
  nativeDPR = await targetPage.evaluate(() => window.devicePixelRatio);

  // Visual scaling strategy:
  //   1x (any size):   scale = 1/nativeDPR (zoom out, like Cmd+minus)
  //   Retina (any):    scale = 1 (native size, no zoom — avoids flicker)
  // Chrome title bar compensation: ~80px on macOS (title bar + possible bookmarks bar)

  const CHROME_BAR = 80;
  currentDPR = retina ? nativeDPR : 1;
  const dpr = currentDPR;
  const isMobile = width < 768;
  cssW = width;
  cssH = height;

  const visualScale = retina ? 1 : (1 / nativeDPR);

  // Mobile emulation: UA + viewport with touch (like Chrome DevTools device mode)
  if (isMobile) {
    await targetPage.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
  }

  // Set viewport + device metrics
  await targetCDP.send('Emulation.setDeviceMetricsOverride', {
    width: cssW,
    height: cssH,
    deviceScaleFactor: dpr,
    mobile: isMobile,
    scale: visualScale,
    screenWidth: isMobile ? cssW : 0,
    screenHeight: isMobile ? cssH : 0,
    screenOrientationType: isMobile ? 'portraitPrimary' : 'landscapePrimary',
    screenOrientationAngle: isMobile ? 0 : 90,
  });

  if (isMobile) {
    await targetCDP.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  // Window = viewport × visual scale + chrome bar
  const winW = Math.round(width * visualScale);
  const winH = Math.round(height * visualScale);
  try {
    const { windowId } = await targetCDP.send('Browser.getWindowForTarget');
    await targetCDP.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: winW, height: winH + CHROME_BAR, windowState: 'normal' },
    });
  } catch {}

  // Inject time virtualization before navigation
  await targetPage.evaluateOnNewDocument(timeVirtualization);

  // Navigate
  try {
    await targetPage.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  // Get scroll info (detects nested scroll containers too)
  const { distance: scrollHeight } = await targetPage.evaluate(() =>
    window.__vibeGetScrollInfo()
  );

  // Handle target close (remove old listener first to avoid duplicates on re-open)
  targetPage.removeAllListeners('close');
  targetPage.once('close', () => {
    if (state === 'recording' || state === 'encoding') {
      shouldStop = true;
    } else {
      setState('idle');
    }
    targetPage = null;
    targetCDP = null;
  });

  const outW = cssW * dpr;
  const outH = cssH * dpr;
  setState('ready', { scrollHeight, cssW, cssH, outW, outH, winW, winH });
}

async function handleRecord(msg) {
  if (state !== 'ready' || !targetPage) return;

  const {
    fps = 60,
    prores = false,
    showCursor = true,
    scroll = false,
    scrollSpeed = 300,
    scrollDelay = 1,
    scrollDelayEnd = 1,
    scrollEase = 0.8,
    preset = 'fast',
    crf = 18,
    tune = 'none',
    profile = 'high',
    pixFmt = 'yuv420p',
    jpegQuality = 95,
  } = msg;

  let duration = Math.min(parseFloat(msg.duration) || 10, 10000);

  shouldStop = false;
  setState('recording');

  // Scroll calculations
  let scrollDistance = 0;
  let scrollTotalTime = 0;

  if (scroll) {
    const scrollInfo = await targetPage.evaluate(() => window.__vibeGetScrollInfo());
    scrollDistance = scrollInfo.distance;
    if (scrollDistance > 0) {
      scrollTotalTime = scrollDistance / scrollSpeed + scrollEase;
      if (!msg.durationExplicit) {
        duration = Math.min(scrollDelay + scrollTotalTime + scrollDelayEnd, 10000);
      }
    }
  }

  const totalFrames = Math.ceil(duration * fps);
  const frameDuration = 1000 / fps;

  // Build filename from page title
  let pageTitle = 'recording';
  try {
    pageTitle = await targetPage.title();
  } catch {}
  const slug = slugify(pageTitle);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `${slug}_${ts}`;
  const ext = prores ? 'mov' : 'mp4';
  const filename = `${baseName}.${ext}`;
  const outputPath = path.join(RECORDINGS_DIR, filename);
  const framesDir = path.join(RECORDINGS_DIR, `${baseName}_frames`);
  fs.mkdirSync(framesDir, { recursive: true });

  // Start virtual time
  await targetPage.evaluate(() => window.__vibeStartCapture());

  // Inject cursor overlay if enabled
  if (showCursor) {
    await injectCursorOverlay(targetPage);
  }

  const captureStart = Date.now();
  let framesCaptured = 0;
  let diskBytes = 0;
  let captureError = false;

  // ---- Phase 1: Capture frames to disk ----
  for (let i = 0; i < totalFrames; i++) {
    if (shouldStop) break;

    try {
      await targetPage.evaluate(async (dt) => {
        const p = window.__vibeAdvanceFrame(dt);
        if (p) await p;
      }, frameDuration);

      if (scroll && scrollDistance > 0) {
        const elapsedSec = (i + 1) * frameDuration / 1000;
        const scrollElapsed = elapsedSec - scrollDelay;
        if (scrollElapsed > 0) {
          const y = calcScrollY(scrollElapsed, scrollTotalTime, scrollDistance, scrollEase);
          // Use scrollTo which our override redirects to the correct container
          await targetPage.evaluate((sy) => window.scrollTo(0, sy), Math.round(y));
        }
      }

      const { data } = await targetCDP.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: Math.max(50, Math.min(100, jpegQuality)),
      });
      const frameBuf = Buffer.from(data, 'base64');
      fs.writeFileSync(
        path.join(framesDir, `frame_${String(i).padStart(6, '0')}.jpg`),
        frameBuf
      );
      diskBytes += frameBuf.length;
      framesCaptured++;
    } catch (err) {
      // Page closed or crashed mid-capture — encode whatever we have
      captureError = true;
      broadcast({ type: 'error', message: `Capture interrupted: ${err.message}` });
      break;
    }

    if (i % Math.max(1, Math.floor(fps / 10)) === 0 || i === totalFrames - 1) {
      const elapsed = (Date.now() - captureStart) / 1000;
      const eta = (elapsed / (i + 1)) * (totalFrames - i - 1);
      broadcast({
        type: 'progress',
        frame: i + 1, total: totalFrames,
        percent: Math.round(((i + 1) / totalFrames) * 100),
        elapsed: elapsed.toFixed(1), eta: eta.toFixed(0),
        diskMB: (diskBytes / 1024 / 1024).toFixed(1),
      });
    }
  }

  // Remove cursor overlay and restore system cursor
  if (showCursor) {
    try { await removeCursorOverlay(targetPage); } catch {}
  }

  // Only mark as partial if there was an actual error — user-initiated Stop is intentional
  const partial = captureError;

  // If no frames were captured at all, nothing to encode
  if (framesCaptured === 0) {
    broadcast({ type: 'error', message: 'No frames captured.' });
    setState('ready', { scrollHeight: 0, cssW, cssH, outW: cssW * currentDPR, outH: cssH * currentDPR });
    return;
  }

  // ---- Phase 2: Encode video from saved frames ----
  setState('encoding');

  const ffmpegArgs = buildFfmpegArgs({
    fps,
    inputPattern: path.join(framesDir, 'frame_%06d.jpg'),
    outputPath,
    prores, preset, crf, tune, profile, pixFmt,
  });

  const ffmpegDone = new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });

  try {
    await ffmpegDone;
  } catch (err) {
    broadcast({ type: 'error', message: `Encoding failed: ${err.message}. Frames saved in ${baseName}_frames/` });
    setState('done', {
      filename: `${baseName}_frames/`,
      downloadUrl: null,
      size: '—', frames: framesCaptured,
      videoDuration: (framesCaptured / fps).toFixed(1), fps,
      framesOnly: true,
    });
    return;
  }

  const fileSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  lastResult = {
    filename, downloadUrl: `/recordings/${filename}`,
    size: fileSize, frames: framesCaptured,
    videoDuration: (framesCaptured / fps).toFixed(1), fps,
    framesDir: `${baseName}_frames`,
    partial,
  };
  setState('done', lastResult);
}

async function handleClick(msg) {
  if (!targetPage) return;
  const x = msg.x ?? Math.floor(cssW / 2);
  const y = msg.y ?? Math.floor(cssH / 2);
  await targetPage.mouse.click(x, y);
  if (state === 'recording') {
    const dt = 1000 / (msg.fps || 60);
    for (let j = 0; j < 3; j++) {
      await targetPage.evaluate((d) => window.__vibeAdvanceFrame(d), dt);
    }
  }
}

async function handleClose() {
  shouldStop = true;
  if (targetPage) {
    try { await targetPage.close(); } catch {}
    targetPage = null;
    targetCDP = null;
  }
  lastResult = null;
  setState('idle');
}


// ---- Cleanup ----
process.on('SIGINT', async () => {
  if (browser) try { await browser.close(); } catch {}
  process.exit(0);
});

// ---- Start ----
httpServer.listen(PORT, async () => {
  console.log(`\n🎬 Vibe Capture\n`);
  console.log(`   Control panel opens automatically in Chrome.\n`);

  browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      `--app=http://localhost:${PORT}`,
      '--window-size=540,880',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  controlPage = (await browser.pages())[0];

  browser.on('disconnected', () => {
    console.log('\n  Browser closed. Exiting.\n');
    process.exit(0);
  });
});
