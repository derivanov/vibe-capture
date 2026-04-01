# Vibe Capture

Frame-perfect web page recorder. Records any website as a smooth, constant frame rate video with no dropped frames and no stuttering.

Built for recording Figma prototypes, landing pages, animations, and anything that runs in a browser.

> **v0.1 — Early release.** This is a raw first version. There will be bugs. Tested only on macOS Sequoia 26. I'm a designer, not a developer — I built this tool for my own needs and decided to share it.

**Author:** [Sasha Derivanov](https://github.com/sasha-derivanov)

---

## How it works

Unlike screen recorders that capture in real time (and drop frames when your computer is slow), Vibe Capture freezes time inside the browser. It advances the clock frame by frame, takes a screenshot of each frame, then stitches them into a video. The result is always smooth, always the exact FPS you asked for, regardless of how fast your computer is.

This means a 10-second video might take 30-60 seconds to record — but the output is perfect.

## What you need

- **macOS** (tested on macOS 26, might work on earlier versions)
- **Node.js 18+** (to check: open Terminal, type `node --version`)
- **ffmpeg** (to encode the final video)

### Installing Node.js (if you don't have it)

1. Go to [nodejs.org](https://nodejs.org)
2. Download the **LTS** version
3. Open the downloaded file and follow the installer
4. Restart Terminal, then type `node --version` — you should see something like `v20.x.x`

### Installing ffmpeg (if you don't have it)

The easiest way is with Homebrew. If you don't have Homebrew:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install ffmpeg:

```bash
brew install ffmpeg
```

To verify: `ffmpeg -version`

## Setup

1. Download or clone this repository
2. Open Terminal
3. Navigate to the folder:
   ```bash
   cd ~/Downloads/vibe-capture
   ```
   (or wherever you put it)
4. Install dependencies:
   ```bash
   npm install
   ```
   This will download Chromium (~200 MB) and other dependencies. Wait for it to finish.

## Usage (Web UI — recommended)

Start the control panel:

```bash
npm start
```

A Chrome window will open with the Vibe Capture control panel.

### Step by step

1. **Paste a URL** into the URL field (e.g., a Figma prototype link, a website, a landing page)
2. **Click Open** — a second browser window opens with your page
3. **Adjust settings** if needed:
   - **Viewport**: pick a resolution preset or type custom dimensions
   - **FPS**: frames per second (default 60, use 30 for smaller files)
   - **Duration**: how long to record in seconds
   - **Format**: MP4 (default) or ProRes (for video editing)
   - **Auto-Scroll**: enable to automatically scroll through the page
   - **Cursor**: show/hide a custom cursor dot in the recording
4. **Navigate** to the right state in the browser window (the right slide, scrolled to the right spot, etc.)
5. **Click Record** — recording starts
6. Wait for it to finish (you'll see a progress bar)
7. **Download** the result

### Tips

- **Auto-record**: Enable "Auto-record after open" to start recording immediately when the page loads. Useful for capturing entrance animations.
- **Auto-scroll**: Great for recording full-page scrolls of landing pages. The scroll has smooth easing and you can adjust speed and delays.
- **Next Slide**: Click this button (or press Space) to advance Figma prototype slides during recording.
- **Stop early**: Click Stop (or press Q) to end recording early. You'll still get a video from the frames captured so far.
- **Retina**: Doubles the output resolution. Works great at smaller viewports (1024 and below). At larger sizes it's slow — you'll see a yellow warning.
- **Mobile preset**: Picks 390x844 and enables Retina automatically. Good for recording mobile versions of websites.

### Encoding settings

Click "Encoding" to expand advanced H.264 settings:

- **Preset**: Ultrafast is fastest to encode, Best is smallest file. Default "Fast" is a good balance.
- **CRF**: Quality. Lower = better quality, bigger file. Default 18 is visually lossless.
- **Tune**: "Film" for live action sites, "Animation" for flat/illustrated sites, "Still Image" for mostly-static pages.
- **ProRes**: Use this if you need to edit the video in Final Cut, DaVinci, or Premiere. Larger files but no quality loss.

## Usage (CLI — for automation)

For scripting or if you prefer the command line:

```bash
node capture.mjs "https://example.com" --duration 5 --fps 60
```

### CLI options

```
--fps <n>            Frames per second (default: 60)
--duration <n>       Duration in seconds (default: 10)
--output <file>      Output file (default: recording.mp4)
--width <n>          Viewport width (default: 1920)
--height <n>         Viewport height (default: 1080)
--scroll             Enable auto-scroll
--scroll-speed <n>   Scroll speed in px/sec (default: 300)
--prores             Export as ProRes .mov
--headless           Run without showing the browser
--no-cursor          Disable cursor overlay
--preset <name>      H.264 preset (default: fast)
--crf <n>            Quality 0-51 (default: 18)
```

### CLI examples

```bash
# Record a Figma prototype for 5 seconds
node capture.mjs "https://figma.com/proto/abc123" --duration 5

# Auto-scroll a landing page
node capture.mjs "https://example.com" --scroll --scroll-speed 200

# Record mobile viewport
node capture.mjs "https://example.com" --width 390 --height 844 --scale 2

# Export ProRes for video editing
node capture.mjs "https://example.com" --prores --output edit.mov

# Low quality, small file, fast encode
node capture.mjs "https://example.com" --fps 30 --crf 28 --preset ultrafast
```

## Troubleshooting

**"Page not scrollable" but the page does scroll**
Some modern websites scroll inside a container div, not the page body. Vibe Capture detects this automatically, but very unusual page structures might not be detected. If this happens, try recording without auto-scroll and scrolling manually in the browser window during recording.

**Recording is slow**
That's expected — frame-by-frame capture takes time. Tips to speed it up:
- Lower the FPS (30 instead of 60)
- Use a smaller resolution
- Don't use Retina at resolutions above 1024px wide

**Video has wrong colors**
If using ProRes, colors should be accurate. For H.264 (MP4), some slight color differences are normal due to YUV conversion.

**ffmpeg not found**
Make sure ffmpeg is installed (`brew install ffmpeg`) and Terminal can find it (`ffmpeg -version`).

**The browser window looks zoomed out**
That's normal for non-Retina recordings. The viewport is scaled down to fit your screen. The recorded video will be full resolution.

## How it works (technical)

Vibe Capture uses Puppeteer to control a Chromium browser. Before the page loads, it injects a time virtualization layer that overrides:

- `requestAnimationFrame`
- `setTimeout` / `setInterval`
- `Date.now()` / `performance.now()`
- `Date` constructor
- CSS / Web Animations API
- Video/audio `currentTime`

During recording, real time is frozen. The recorder advances virtual time frame by frame (e.g., 16.67ms per frame at 60fps), takes a CDP screenshot, saves it as JPEG, then advances to the next frame. After all frames are captured, ffmpeg encodes them into the final video.

This guarantees constant frame rate output regardless of system performance.

## License

MIT
