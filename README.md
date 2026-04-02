# Vibe Capture

Frame-perfect web page recorder. Records any website as a smooth, constant frame rate video — no dropped frames, no stuttering, ever.

Built for recording Figma prototypes, landing pages, animations, and anything that runs in a browser.

> **v0.2** — Figma video playback fix, mobile emulation, improved scroll detection. Still early — there will be bugs. Tested only on macOS 26.

**Author:** [Sasha Derivanov](https://github.com/derivanov)

---

## Install & Run

Open Terminal, then:

```bash
git clone https://github.com/derivanov/vibe-capture.git
cd vibe-capture
bash setup.sh
```

The setup script installs everything automatically (Node.js, ffmpeg, dependencies). Takes a few minutes the first time.

When it's done:

```bash
npm start
```

A control panel opens in Chrome. That's it.

<details>
<summary><b>Manual install (if you prefer not to run the script)</b></summary>

Requirements: **Node.js 18+** and **ffmpeg** in your PATH.

```bash
git clone https://github.com/derivanov/vibe-capture.git
cd vibe-capture
npm install
npm start
```

</details>

---

## How to use

1. **Paste a URL** and click **Open** — a browser window opens with your page
2. **Set up** what you need (resolution, duration, FPS, auto-scroll, etc.)
3. **Click Record** — wait for the progress bar to finish
4. **Download** the video

### Keyboard shortcuts during recording

| Key | Action |
|---|---|
| Space | Click center of page (advance Figma slides) |
| Q | Stop recording early |

---

## Settings

| Setting | What it does |
|---|---|
| **Viewport presets** | 1920x1080, 1440x900, 1280x800, 1024x768, Mobile |
| **Retina** | 2x output resolution. Best at 1024px and below |
| **FPS** | Frames per second. 60 = smooth, 30 = smaller file |
| **Duration** | How many seconds to record |
| **MP4 / ProRes** | MP4 for sharing, ProRes for editing in Final Cut / DaVinci / Premiere |
| **Auto-scroll** | Scrolls the page automatically with smooth easing |
| **Auto-record** | Starts recording immediately after Open (catches entrance animations) |
| **Cursor** | Shows a dot cursor in the recording |

### Encoding (advanced)

Click "Encoding" to expand. These are H.264 settings for MP4:

- **Preset** — Ultrafast (fast encode) to Best (smallest file). Default: Fast
- **CRF** — Quality. Lower = better. Default: 18 (visually lossless)
- **Tune** — Film / Animation / Still Image. Optimizes compression for content type

---

## CLI (optional)

There's also a command-line version:

```bash
node capture.mjs "https://example.com" --duration 5 --fps 60
node capture.mjs "https://example.com" --scroll --scroll-speed 200
node capture.mjs "https://example.com" --width 390 --height 844 --scale 2
node capture.mjs "https://example.com" --prores --output edit.mov
```

Run `node capture.mjs --help` for all options.

---

## How it works

Unlike screen recorders that capture in real time (and drop frames when your Mac is busy), Vibe Capture **freezes time** inside the browser. It advances the clock frame by frame, screenshots each one, then encodes them into video.

A 10-second recording might take 30-60 seconds — but the output is always perfectly smooth at the exact FPS you set.

---

## Troubleshooting

**"Page not scrollable" but the page scrolls fine**
Some sites use custom scroll containers. Vibe Capture tries to detect them, but unusual setups might not work. Try scrolling manually during recording instead.

**Recording takes a long time**
That's normal. To speed up: use 30fps, lower resolution, skip Retina.

**ffmpeg not found**
Run `bash setup.sh` again — it will install ffmpeg.

**Browser window looks zoomed out**
Normal for non-Retina. The recording will be full resolution.

---

## License

MIT
