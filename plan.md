# TizenGo2RTCCameraViewer - Rebuild Plan

---

## Overview

A Samsung Tizen TV app to view 4 Dahua NVR camera streams via Go2RTC, optimized for **fast, reliable, real-time streaming** with a clean, modular architecture.

---

## Cameras

- **driveway_stream:** channel 0
- **backyard_stream:** channel 1
- **frontyard_stream:** channel 2
- **backdeck_stream:** channel 3

All sourced via DVRIP, transcoded by Go2RTC to HLS.

---

## Core Features

- Multi-camera grid view (2x2)
- Single camera fullscreen view
- Remote control navigation
- Lazy loading of streams
- Stream health monitoring
- Auto-reconnection
- Ambient mode with cycling camera
- Adaptive streaming (HLS only)
- Modular codebase (config, player, UI, navigation, ambient, remote, main)

---

## Streaming Protocol

- **Primary:** HLS (`.m3u8`) streams from Go2RTC
- **No fallback** (MJPEG unsupported, MP4 unreliable)
- **No RTSP or WebRTC initially**

---

## Architecture

- **HTML5 + JavaScript app** running on Tizen TV browser
- **Modular JS files:**
  - `config.js` — stream URLs
  - `player.js` — stream init
  - `ui.js` — UI helpers
  - `navigation.js` — view switching
  - `ambient.js` — ambient mode
  - `remote.js` — remote keys
  - `main.js` — app bootstrap
- **<500 lines per file**

---

## Constraints

- Tizen TV browser limitations
- Go2RTC must provide compatible HLS streams
- Use fixed local IP or hostname for streams

---

## Next Steps

- Scaffold project files
- Implement modules
- Test on Tizen TV
- Package and deploy
