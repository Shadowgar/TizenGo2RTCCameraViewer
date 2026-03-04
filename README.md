# TizenGo2RTCCameraViewer (AVPlay Edition)

Samsung Tizen TV web app (JavaScript) for a robust 4-camera live viewer using:

- `camera-bridge` (`/tizen/bootstrap-lite`, `/tizen/poll`, `/tizen/open`)
- MediaMTX HLS output (`index.m3u8`)
- Samsung AVPlay API (`webapis.avplay`) for playback

## Architecture

Pipeline:

`Night Owl DVRIP -> go2rtc -> (optional repair publisher) -> MediaMTX -> HLS -> Tizen AVPlay`

This app does **not** contain DVR credentials. All sensitive config stays on the Raspberry Pi backend.

## App Modes

1. **GRID mode**
     - 2x2 camera tiles: Driveway, Backyard, Frontyard, Backdeck
     - Per-tile `LIVE/IDLE`, status, and last update timestamp
     - D-pad focus border

2. **PLAYER mode**
     - Fullscreen AVPlay HLS playback
     - HUD with camera name, status, and clock
     - Playback error overlay with `Retry` and `Back`
     - Auto-retry with exponential backoff

## Remote Keys

- **Arrows (GRID)**: move focus
- **Enter/OK**: open selected camera in PLAYER
- **Back/Return (PLAYER)**: back to GRID (clean AVPlay stop/close)
- **Back/Return (GRID)**: press twice quickly to exit app
- **Long Return / Exit key**: exits app (mapped via `Exit` key)
- **Play/Pause**: toggle pause/resume in PLAYER
- **Up/Down (PLAYER)**: toggle HUD visibility

## Configuration

Base URLs are configurable via `localStorage` (recommended, no credentials in source):

- `TVAPP_BRIDGE_URL` (default: `http://openclaw.local:8090`)
- `TVAPP_MEDIAMTX_URL` (default: `http://openclaw.local:8889`)

You can set these from a browser console before packaging tests:

```javascript
localStorage.setItem("TVAPP_BRIDGE_URL", "http://openclaw.local:8090");
localStorage.setItem("TVAPP_MEDIAMTX_URL", "http://openclaw.local:8889");
```

## Backend Contract Used

- `GET /tizen/bootstrap-lite`
  - Reads `poll_url`, `poll_interval_ms`, `startup_grace_ms`, `state_version`, cameras
- `GET /tizen/poll?since=<state_version>`
  - If `changed=true`, applies payload state
- `POST /tizen/open` with body:
  - `{ "camera": "driveway", "mode": "main" }`
  - Expects `playback.hls_url` in response and uses it directly

## Project Structure

```text
config.xml
index.html
css/
    style.css
js/
    app.js
    api.js
    player.js
    state.js
    ui-grid.js
    ui-player.js
```

## Build & Run (Tizen Studio)

1. Open this folder in Tizen Studio.
2. Ensure TV certificate profile is configured.
3. Connect TV (Developer Mode + same network).
4. Right click project -> **Build Signed Package**.
5. Run on target device from Device Manager / Run As.

## Notes

- AVPlay requires Samsung Tizen TV runtime (`$WEBAPIS/webapis/webapis.js`).
- HLS URL should point to MediaMTX multivariant playlist (`.../index.m3u8`).
- No `hls.js` is used.
