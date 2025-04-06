# TizenGo2RTCCameraViewer - Rebuild Task List

_Last updated: 2025-04-05_

---

## Initial Setup

- Initialize a new git repository (if not done).
- Create project folder structure:
  - `index.html`
  - `css/style.css`
  - `js/config.js`
  - `js/player.js`
  - `js/ui.js`
  - `js/navigation.js`
  - `js/ambient.js`
  - `js/remote.js`
  - `js/main.js`
- Add placeholder icon and images.

---

## Core Tasks

### 1. **Design `index.html`**

- Basic layout: grid view, single view, overlays.
- Include all JS modules in order.
- Add remote control help overlay.

### 2. **Create `config.js`**

- Define `window.cameraSources` with fixed HLS URLs for 4 cameras.
- Use local IP or hostname, avoid ingress URLs.

### 3. **Implement `player.js`**

- Initialize streams with HLS.js or native HLS.
- Handle errors gracefully.
- No MJPEG fallback.

### 4. **Implement `ui.js`**

- Show/hide loading indicators.
- Update stream health.
- Show play button if autoplay blocked.

### 5. **Implement `navigation.js`**

- Grid/single view switching.
- Camera navigation.
- Remote key handling for navigation.

### 6. **Implement `ambient.js`**

- Enter/exit ambient mode.
- Cycle cameras in ambient mode.
- Handle unsupported APIs gracefully.

### 7. **Implement `remote.js`**

- Handle remote control keys.
- Show feedback overlay.
- Toggle play/pause.

### 8. **Implement `main.js`**

- Initialize app on load.
- Set up event listeners.
- Call all setup functions.

### 9. **Style with `css/style.css`**

- Responsive grid and single view.
- Loading indicators, overlays.
- Remote feedback styling.

---

## Testing

- Test on Tizen TV emulator and real device.
- Verify streams load and switch correctly.
- Check remote navigation.
- Validate ambient mode.
- Fix any bugs.

---

## Deployment

- Package as Tizen `.wgt` app.
- Sign and install on TV.
- Document setup in `README.md`.

---

This task list will guide a **clean, modular rebuild** of your Tizen TV camera viewer app with reliable HLS streaming.
