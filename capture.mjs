#!/usr/bin/env node

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { calcScrollY, timeVirtualization, injectCursorOverlay, removeCursorOverlay, buildFfmpegArgs } from './shared.mjs';

// --- Argument parsing ---
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
🎬 Vibe Capture — Frame-Perfect Web Recorder

Usage:
  node capture.mjs <url> [options]

Options:
  --fps <n>            Frames per second (default: 60)
  --duration <n>       Duration in seconds (default: 10, auto with --scroll)
  --output <file>      Output file, .mp4 or .mov (default: recording.mp4)
  --width <n>          Viewport width (default: 1920)
  --height <n>         Viewport height (default: 1080)
  --click <x,y>        Click at position before recording starts
  --prores             Export as ProRes 422 HQ .mov (better for editing)
  --preset <name>      H.264 preset: ultrafast/fast/medium/slow/veryslow (default: fast)
  --crf <n>            H.264 quality 0-51, lower=better (default: 18)
  --tune <name>        H.264 tune: film/animation/stillimage (default: none)
  --profile <name>     H.264 profile: baseline/high/high444 (default: high)
  --pix-fmt <fmt>      Pixel format: yuv420p/yuv422p/yuv444p (default: yuv420p)
  --jpeg-quality <n>   Source frame JPEG quality 50-100 (default: 95)
  --headless           Run without showing the browser window
  --scale <n>          Device scale factor for retina (default: 1)
  --no-cursor          Disable cursor overlay (enabled by default)

Auto-scroll:
  --scroll             Enable auto-scroll mode
  --scroll-speed <n>   Scroll speed in pixels/sec (default: 300)
  --scroll-delay <n>   Delay before scroll starts, seconds (default: 1)
  --scroll-ease <n>    Ease-in/out duration, seconds (default: 0.8)

Controls during recording:
  Space / Enter     Click center of page (advance Figma slide, etc.)
  q                 Stop recording early

Examples:
  node capture.mjs "https://figma.com/proto/abc123" --duration 5 --fps 60
  node capture.mjs "https://figma.com/proto/abc123" --duration 3 --prores --output edit.mov
  node capture.mjs "https://example.com" --scroll --scroll-speed 200 --scroll-ease 1.0
  node capture.mjs "https://example.com" --fps 30 --duration 10 --width 1280 --height 720
`);
  process.exit(0);
}

const url = args.find(a => !a.startsWith('--'));
if (!url) {
  console.error('Error: URL is required. Run with --help for usage.');
  process.exit(1);
}

const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const fps = parseInt(getArg('fps', '60'));
const width = parseInt(getArg('width', '1920'));
const height = parseInt(getArg('height', '1080'));
const scale = parseInt(getArg('scale', '1'));
const clickPos = getArg('click', null);
const headless = hasFlag('headless');
const useProRes = hasFlag('prores');
const autoScroll = hasFlag('scroll');
const scrollSpeed = parseFloat(getArg('scroll-speed', '300'));
const scrollDelay = parseFloat(getArg('scroll-delay', '1'));
const scrollEase = parseFloat(getArg('scroll-ease', '0.8'));
const durationExplicit = args.includes('--duration');
const preset = getArg('preset', 'fast');
const crf = parseInt(getArg('crf', '18'));
const tune = getArg('tune', 'none');
const h264profile = getArg('profile', 'high');
const pixFmt = getArg('pix-fmt', 'yuv420p');
const jpegQuality = parseInt(getArg('jpeg-quality', '95'));
const showCursor = !hasFlag('no-cursor');

let duration = parseFloat(getArg('duration', '10'));

let output = getArg('output', useProRes ? 'recording.mov' : 'recording.mp4');
if (useProRes && !output.endsWith('.mov')) {
  output = output.replace(/\.\w+$/, '.mov');
}

const frameDuration = 1000 / fps;

console.log('\n🎬 Vibe Capture — Frame-Perfect Web Recorder\n');
console.log(`  URL:        ${url}`);
console.log(`  FPS:        ${fps}`);
console.log(`  Viewport:   ${width}x${height}${scale > 1 ? ` @${scale}x` : ''}`);
console.log(`  Output:     ${output}${useProRes ? ' (ProRes 422 HQ)' : ` (H.264 preset=${preset} crf=${crf})`}`);
if (autoScroll) {
  console.log(`  Scroll:     ${scrollSpeed} px/s, delay ${scrollDelay}s, ease ${scrollEase}s`);
}
console.log();

// --- Launch browser ---
console.log('Launching browser...');
const browser = await puppeteer.launch({
  headless: headless ? 'new' : false,
  defaultViewport: { width, height, deviceScaleFactor: scale },
  args: [
    `--window-size=${width},${height + 85}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]
});

const page = (await browser.pages())[0];

// --- CDP session for fast screenshots ---
const cdp = await page.createCDPSession();

// --- Mobile emulation (User-Agent, screen, touch) ---
const isMobileCLI = width < 768;
if (isMobileCLI) {
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale,
    mobile: true,
    screenWidth: width, screenHeight: height,
    screenOrientationType: 'portraitPrimary', screenOrientationAngle: 0,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

// --- Inject time virtualization (before any page scripts run) ---
await page.evaluateOnNewDocument(timeVirtualization);

// --- Navigate ---
console.log(`Opening: ${url}`);
console.log('(waiting for page to load...)\n');
try {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
} catch {
  console.log('Page load timed out — continuing anyway.');
}

await new Promise(r => setTimeout(r, 2000));

// --- Calculate scroll parameters ---
let scrollDistance = 0;
let scrollTotalTime = 0;

if (autoScroll) {
  const scrollInfo = await page.evaluate(() => window.__vibeGetScrollInfo());
  scrollDistance = scrollInfo.distance;

  if (scrollDistance <= 0) {
    console.log('⚠  Page is not scrollable. Auto-scroll disabled.\n');
  } else {
    // totalTime = distance / speed + easeDuration (accounts for ease-in/out reducing distance)
    scrollTotalTime = scrollDistance / scrollSpeed + scrollEase;

    if (!durationExplicit) {
      duration = scrollDelay + scrollTotalTime + 0.5; // 0.5s buffer at end
    }

    console.log(`  Scroll distance: ${scrollDistance}px`);
    console.log(`  Scroll time:     ${scrollTotalTime.toFixed(1)}s (+ ${scrollDelay}s delay)`);
    console.log(`  Total duration:  ${duration.toFixed(1)}s (${Math.ceil(duration * fps)} frames)\n`);
  }
}

const totalFrames = Math.ceil(duration * fps);

// --- Wait for user ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

console.log('✅ Page loaded.');
console.log('   Navigate to the desired state in the browser window.');
console.log('   When ready, come back here and press Enter.\n');
await ask('▶  Press Enter to start recording... ');
rl.close();

// --- Click before recording (if requested) ---
if (clickPos) {
  const [x, y] = clickPos.split(',').map(Number);
  console.log(`\nClicking at (${x}, ${y})...`);
  await page.mouse.click(x, y);
  await new Promise(r => setTimeout(r, 200));
}

// --- Create frames directory ---
const baseName = path.basename(output, path.extname(output));
const framesDir = path.join(path.dirname(output), `${baseName}_frames`);
fs.mkdirSync(framesDir, { recursive: true });

// --- Keyboard controls during recording ---
let pendingClick = false;
let shouldStop = false;

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    const k = key.toString();
    if (k === ' ' || k === '\r' || k === '\n') pendingClick = true;
    if (k === 'q' || k === '\x03') shouldStop = true;
  });
}

// --- Start capture ---
await page.evaluate(() => window.__vibeStartCapture());

// Inject cursor overlay
if (showCursor) {
  await injectCursorOverlay(page);
}

console.log(`\nRecording ${duration}s at ${fps}fps (${totalFrames} frames)`);
console.log('Controls: [Space] click/next slide  [q] stop early\n');

const captureStart = Date.now();
let framesCaptured = 0;

for (let i = 0; i < totalFrames; i++) {
  if (shouldStop) break;

  // Handle click from keyboard
  if (pendingClick) {
    pendingClick = false;
    await page.mouse.click(Math.floor(width / 2), Math.floor(height / 2));
    // Advance a few virtual frames so the click registers and animation starts
    for (let j = 0; j < 3; j++) {
      await page.evaluate((dt) => window.__vibeAdvanceFrame(dt), frameDuration);
    }
  }

  // Advance virtual time + sync media/animations
  await page.evaluate(async (dt) => {
    const p = window.__vibeAdvanceFrame(dt);
    if (p) await p;
  }, frameDuration);

  // Auto-scroll
  if (autoScroll && scrollDistance > 0) {
    const elapsedSec = (i + 1) * frameDuration / 1000;
    const scrollElapsed = elapsedSec - scrollDelay;
    if (scrollElapsed > 0) {
      const y = calcScrollY(scrollElapsed, scrollTotalTime, scrollDistance, scrollEase);
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), Math.round(y));
    }
  }

  // Capture frame via CDP as JPEG and save to disk
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: Math.max(50, Math.min(100, jpegQuality)),
  });

  fs.writeFileSync(
    path.join(framesDir, `frame_${String(i).padStart(6, '0')}.jpg`),
    Buffer.from(data, 'base64')
  );
  framesCaptured++;

  // Progress
  const done = i + 1;
  const pct = (done / totalFrames * 100).toFixed(1);
  const elapsed = ((Date.now() - captureStart) / 1000).toFixed(1);
  const msPerFrame = (Date.now() - captureStart) / done;
  const eta = ((totalFrames - done) * msPerFrame / 1000).toFixed(0);
  const bar = '█'.repeat(Math.floor(done / totalFrames * 30)) + '░'.repeat(30 - Math.floor(done / totalFrames * 30));
  process.stdout.write(`\r  ${bar} ${done}/${totalFrames} (${pct}%) — ${elapsed}s elapsed, ~${eta}s left`);
}

const captureTime = ((Date.now() - captureStart) / 1000).toFixed(1);
console.log(`\n\n  ${framesCaptured} frames captured in ${captureTime}s`);

// Remove cursor overlay
if (showCursor) {
  await removeCursorOverlay(page);
}

// Restore terminal
if (process.stdin.isTTY) {
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

// Close browser
await browser.close();

// --- Encode video from saved frames ---
console.log('  Encoding video from frames...');

const ffmpegArgs = buildFfmpegArgs({
  fps,
  inputPattern: path.join(framesDir, 'frame_%06d.jpg'),
  outputPath: output,
  prores: useProRes,
  preset, crf, tune,
  profile: h264profile,
  pixFmt,
});

const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['ignore', 'pipe', 'pipe']
});

let ffmpegError = '';
ffmpeg.stderr.on('data', d => { ffmpegError += d.toString(); });

try {
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg error (code ${code}):\n${ffmpegError.slice(-500)}`));
    });
  });

  const fileSize = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ Done! Saved: ${output} (${fileSize} MB)`);
  console.log(`   ${framesCaptured} frames, ${(framesCaptured / fps).toFixed(1)}s @ ${fps}fps`);
  console.log(`   Source frames preserved in: ${framesDir}\n`);
} catch (err) {
  console.error(`\n❌ Encoding failed: ${err.message}`);
  console.log(`   Source frames preserved in: ${framesDir}`);
  console.log(`   You can encode manually: ffmpeg -framerate ${fps} -i "${framesDir}/frame_%06d.jpg" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p "${output}"\n`);
  process.exit(1);
}
