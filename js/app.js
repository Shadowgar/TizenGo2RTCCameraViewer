/*global GridUI, PlayerUI, Promise, TVApi, TVAppState, TVPlayer, tizen */
(function (global) {
    "use strict";

    // Main controller for GRID <-> PLAYER routing, remote input, backend polling,
    // and resilient AVPlay playback recovery.

    var KEY = {
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        ENTER: 13,
        GREEN: 404,
        YELLOW: 405,
        RETURN: 10009,
        EXIT: 10182,
        PLAY: 415,
        PAUSE: 19,
        PLAY_PAUSE: 10252
    };

    var gridScreen;
    var playerScreen;
    var backendInfo;
    var toast;
    var telemetryStrip;
    var debugPanel;
    var debugTitle;
    var debugContent;
    var playerSettingsPanel;
    var playerSettingsRows = [];
    var settingCycleModeValue;
    var settingDwellCameraValue;
    var settingDwellTimeValue;
    var settingPictureModeValue;
    var settingWeatherLocationValue;
    var settingHudAutoHideValue;
    var pictureModeLayer;
    var hudWeather;
    var weatherOverlay;
    var weatherOverlayTitle;
    var weatherOverlayList;

    var pollTimer = null;
    var bootstrapRetryTimer = null;
    var pollBackoffStep = 0;
    var bootstrapBackoffStep = 0;
    var pollInFlight = false;
    var openRequestToken = 0;
    var lastBackPressAt = 0;
    var playbackRetryTimer = null;
    var playbackRetryAttempt = 0;
    var firstFrameWatchTimer = null;
    var lastPlayTimeTick = 0;
    var resizeRectTimer = null;
    var diagnosticsTimer = null;
    var viewStatusTimer = null;
    var debugRefreshTimer = null;
    var autoCycleTimer = null;
    var weatherRefreshTimer = null;
    var weatherFetchToken = 0;
    var debugVisible = false;
    var playerSettingsVisible = false;
    var playerHasActiveStream = false;
    var weatherOverlayVisible = false;
    var pollPlaybackRecoverInFlight = false;
    var lastGridWarmupAt = 0;
    var cycleMode = "TIMED";
    var pendingCycleMode = "TIMED";
    var perCameraDwellSeconds = {};
    var pendingPerCameraDwellSeconds = {};
    var pendingDwellCameraIndex = 0;
    var pictureMode = "NORMAL";
    var pendingPictureMode = "NORMAL";
    var weatherLocationId = "auto";
    var pendingWeatherLocationId = "auto";
    var hudAutoHideSeconds = 0;
    var pendingHudAutoHideSeconds = 0;
    var settingsFocusIndex = 0;
    var weatherData = null;
    var weatherLastFetchedAt = 0;
    var weatherLastNoMotionAt = 0;

    var MAX_AUTO_PLAYBACK_RETRIES = 4;
    var BACKEND_UNREACHABLE_THRESHOLD = 3;
    var GRID_WARMUP_COOLDOWN_MS = 3000;
    var CYCLE_MODE_OPTIONS = ["TIMED", "MOTION"];
    var DWELL_OPTIONS = [5, 10, 15, 20, 30];
    var PICTURE_MODE_OPTIONS = ["NORMAL", "NIGHT", "BRIGHT"];
    var HUD_AUTO_HIDE_OPTIONS = [0, 5, 10, 15];
    var WEATHER_REFRESH_MS = 10 * 60 * 1000;
    var CYCLE_SETTINGS_STORAGE_KEY = "TVAPP_PLAYER_CYCLE_SECONDS";
    var CYCLE_MODE_STORAGE_KEY = "TVAPP_PLAYER_CYCLE_MODE";
    var DWELL_SETTINGS_STORAGE_KEY = "TVAPP_PLAYER_DWELL_SECONDS";
    var PICTURE_MODE_STORAGE_KEY = "TVAPP_PLAYER_PICTURE_MODE";
    var WEATHER_LOCATION_STORAGE_KEY = "TVAPP_PLAYER_WEATHER_LOCATION";
    var HUD_AUTO_HIDE_STORAGE_KEY = "TVAPP_PLAYER_HUD_AUTO_HIDE";
    var WEATHER_LOCATIONS = [
        { id: "auto", label: "Auto" },
        { id: "henderson_nv", label: "Henderson, NV", latitude: 36.0395, longitude: -114.9817 },
        { id: "las_vegas_nv", label: "Las Vegas, NV", latitude: 36.1699, longitude: -115.1398 },
        { id: "phoenix_az", label: "Phoenix, AZ", latitude: 33.4484, longitude: -112.0740 },
        { id: "salt_lake_city_ut", label: "Salt Lake City, UT", latitude: 40.7608, longitude: -111.8910 }
    ];

    var diagnostics = {
        operations: {
            bootstrap: emptyOpStats(),
            poll: emptyOpStats(),
            open: emptyOpStats(),
            viewStatus: emptyOpStats(),
            diagQuick: emptyOpStats(),
            diagDeep: emptyOpStats(),
            resolveHls: emptyOpStats(),
            avplay: emptyOpStats()
        },
        recentEvents: [],
        lastViewStatus: null,
        lastDiagQuick: null,
        lastDiagDeep: null
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function emptyOpStats() {
        return {
            ok: 0,
            fail: 0,
            consecutiveFail: 0,
            lastDurationMs: 0,
            lastOkAt: null,
            lastFailAt: null,
            lastError: "",
            lastStatus: null,
            lastDetail: ""
        };
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function shortError(error) {
        if (!error) {
            return "unknown";
        }

        if (error.message) {
            return error.message;
        }

        return String(error);
    }

    function safeGetLocalStorage(key) {
        try {
            return global.localStorage ? global.localStorage.getItem(key) : null;
        } catch (error) {
            return null;
        }
    }

    function safeSetLocalStorage(key, value) {
        try {
            if (global.localStorage) {
                global.localStorage.setItem(key, value);
            }
        } catch (error) {
            return;
        }
    }

    function safeParseJson(value) {
        try {
            return JSON.parse(String(value || ""));
        } catch (error) {
            return null;
        }
    }

    function normalizeCycleMode(value) {
        var normalized = String(value || "").toUpperCase();
        return CYCLE_MODE_OPTIONS.indexOf(normalized) >= 0 ? normalized : "TIMED";
    }

    function normalizeDwellSeconds(value) {
        var numeric = Number(value) || 0;
        return DWELL_OPTIONS.indexOf(numeric) >= 0 ? numeric : 10;
    }

    function normalizePictureMode(value) {
        var normalized = String(value || "").toUpperCase();
        return PICTURE_MODE_OPTIONS.indexOf(normalized) >= 0 ? normalized : "NORMAL";
    }

    function normalizeHudAutoHideSeconds(value) {
        var numeric = Number(value) || 0;
        return HUD_AUTO_HIDE_OPTIONS.indexOf(numeric) >= 0 ? numeric : 0;
    }

    function findWeatherLocationById(id) {
        var targetId = String(id || "").toLowerCase();
        var i;

        for (i = 0; i < WEATHER_LOCATIONS.length; i += 1) {
            if (WEATHER_LOCATIONS[i].id === targetId) {
                return WEATHER_LOCATIONS[i];
            }
        }

        return WEATHER_LOCATIONS[0];
    }

    function normalizeWeatherLocationId(id) {
        return findWeatherLocationById(id).id;
    }

    function buildDefaultDwellMap(defaultSeconds) {
        var fallback = normalizeDwellSeconds(defaultSeconds);
        var map = {};

        TVAppState.getCameraOrder().forEach(function (cameraName) {
            map[cameraName] = fallback;
        });

        return map;
    }

    function normalizeDwellMap(rawMap, defaultSeconds) {
        var normalized = buildDefaultDwellMap(defaultSeconds);
        if (!rawMap || typeof rawMap !== "object") {
            return normalized;
        }

        Object.keys(normalized).forEach(function (cameraName) {
            normalized[cameraName] = normalizeDwellSeconds(rawMap[cameraName]);
        });

        return normalized;
    }

    function cloneDwellMap(sourceMap) {
        return normalizeDwellMap(sourceMap, 10);
    }

    function cycleLabel(seconds) {
        return String(seconds) + " sec";
    }

    function cycleModeLabel(mode) {
        return mode === "MOTION" ? "Motion-Only" : "Timed";
    }

    function pictureModeLabel(mode) {
        if (mode === "NIGHT") {
            return "Night";
        }
        if (mode === "BRIGHT") {
            return "Bright";
        }
        return "Normal";
    }

    function hudAutoHideLabel(seconds) {
        return seconds > 0 ? String(seconds) + " sec" : "Off";
    }

    function weatherLocationLabel(locationId) {
        return findWeatherLocationById(locationId).label;
    }

    function getDwellSecondsForCamera(cameraName, dwellMap) {
        var map = dwellMap || perCameraDwellSeconds;
        var fallbackCamera = TVAppState.getCameraOrder()[0] || "";
        var key = String(cameraName || fallbackCamera || "").toLowerCase();
        return normalizeDwellSeconds(map[key]);
    }

    function loadPlayerPreferences() {
        var legacyCycleSeconds = normalizeDwellSeconds(safeGetLocalStorage(CYCLE_SETTINGS_STORAGE_KEY));
        var storedDwell = safeParseJson(safeGetLocalStorage(DWELL_SETTINGS_STORAGE_KEY));

        cycleMode = normalizeCycleMode(safeGetLocalStorage(CYCLE_MODE_STORAGE_KEY));
        perCameraDwellSeconds = normalizeDwellMap(storedDwell, legacyCycleSeconds);
        pictureMode = normalizePictureMode(safeGetLocalStorage(PICTURE_MODE_STORAGE_KEY));
        weatherLocationId = normalizeWeatherLocationId(safeGetLocalStorage(WEATHER_LOCATION_STORAGE_KEY));
        hudAutoHideSeconds = normalizeHudAutoHideSeconds(safeGetLocalStorage(HUD_AUTO_HIDE_STORAGE_KEY));
    }

    function savePlayerPreferences() {
        safeSetLocalStorage(CYCLE_MODE_STORAGE_KEY, cycleMode);
        safeSetLocalStorage(DWELL_SETTINGS_STORAGE_KEY, JSON.stringify(perCameraDwellSeconds));
        safeSetLocalStorage(PICTURE_MODE_STORAGE_KEY, pictureMode);
        safeSetLocalStorage(WEATHER_LOCATION_STORAGE_KEY, weatherLocationId);
        safeSetLocalStorage(HUD_AUTO_HIDE_STORAGE_KEY, String(hudAutoHideSeconds));
    }

    function opStart() {
        return Date.now();
    }

    function pushDiagEvent(level, text) {
        diagnostics.recentEvents.unshift({
            at: nowIso(),
            level: level,
            text: text
        });

        if (diagnostics.recentEvents.length > 60) {
            diagnostics.recentEvents.length = 60;
        }

        updateTelemetryStrip();
        renderDebugSnapshot();
    }

    function markOpSuccess(name, startedAt, detail) {
        var op = diagnostics.operations[name];
        if (!op) {
            return;
        }

        op.ok += 1;
        op.consecutiveFail = 0;
        op.lastDurationMs = Math.max(0, Date.now() - startedAt);
        op.lastOkAt = nowIso();
        op.lastError = "";
        op.lastStatus = null;
        op.lastDetail = detail || "";

        updateTelemetryStrip();
        renderDebugSnapshot();
    }

    function markOpFailure(name, startedAt, error, detail) {
        var op = diagnostics.operations[name];
        if (!op) {
            return;
        }

        op.fail += 1;
        op.consecutiveFail += 1;
        op.lastDurationMs = Math.max(0, Date.now() - startedAt);
        op.lastFailAt = nowIso();
        op.lastError = shortError(error);
        op.lastStatus = error && error.status ? error.status : null;
        op.lastDetail = detail || "";

        pushDiagEvent("ERROR", name + " failed: " + op.lastError);
    }

    function latestErrorSummary() {
        var i;
        for (i = 0; i < diagnostics.recentEvents.length; i += 1) {
            if (diagnostics.recentEvents[i].level === "ERROR") {
                return diagnostics.recentEvents[i].text;
            }
        }
        return "none";
    }

    function updateTelemetryStrip() {
        if (!telemetryStrip) {
            return;
        }

        var b = diagnostics.operations.bootstrap;
        var p = diagnostics.operations.poll;
        var o = diagnostics.operations.open;
        telemetryStrip.textContent = [
            "B " + b.ok + "/" + b.fail,
            "P " + p.ok + "/" + p.fail,
            "O " + o.ok + "/" + o.fail,
            "Last: " + latestErrorSummary()
        ].join(" | ");
    }

    function renderDebugSnapshot() {
        if (!debugVisible || !debugContent) {
            return;
        }

        var cameras = TVAppState.getCameras();
        var cameraSummary = {};
        Object.keys(cameras).forEach(function (name) {
            cameraSummary[name] = {
                status: cameras[name].status,
                running: cameras[name].running,
                debug: cameras[name].debugInfo,
                updatedAt: cameras[name].updatedAt
            };
        });

        var snapshot = {
            generated_at: nowIso(),
            mode: TVAppState.getMode(),
            bridge: TVAppState.getBridgeBaseUrl(),
            poll_url: TVAppState.getPollUrl(),
            state_version: TVAppState.getStateVersion(),
            operations: diagnostics.operations,
            cameras: cameraSummary,
            last_view_status: diagnostics.lastViewStatus,
            last_diag_quick: diagnostics.lastDiagQuick,
            last_diag_deep: diagnostics.lastDiagDeep,
            recent_events: diagnostics.recentEvents.slice(0, 20)
        };

        debugContent.textContent = JSON.stringify(snapshot, null, 2);
    }

    function applyViewStatusToTiles(payload) {
        if (!payload || !payload.cameras || typeof payload.cameras !== "object") {
            return;
        }

        Object.keys(payload.cameras).forEach(function (cameraName) {
            var item = payload.cameras[cameraName] || {};
            var running = !!item.running;

            TVAppState.setCameraRunning(
                cameraName,
                running,
                running ? "READY" : "STOPPED"
            );

            var debugText = [
                "run=" + (running ? "1" : "0"),
                "pid=" + (item.pid === undefined || item.pid === null ? "-" : item.pid),
                "exit=" + (item.last_exit_code === undefined || item.last_exit_code === null ? "-" : item.last_exit_code),
                "rst=" + (item.restart_count === undefined || item.restart_count === null ? "-" : item.restart_count)
            ].join(" ");

            TVAppState.setCameraDebugInfo(cameraName, debugText);
        });
    }

    function showToast(text, durationMs) {
        if (!toast) {
            return;
        }

        toast.textContent = text;
        toast.classList.remove("hidden");
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(function () {
            toast.classList.add("hidden");
        }, durationMs || 1700);
    }

    function updateBackendInfo() {
        var bridge = TVAppState.getBridgeBaseUrl();
        backendInfo.textContent = "Bridge: " + bridge;
        updateTelemetryStrip();
    }

    function renderGrid() {
        GridUI.render(TVAppState.getCameras());
    }

    function setPlayerSettingsFocus(index) {
        if (!playerSettingsRows || !playerSettingsRows.length) {
            settingsFocusIndex = 0;
            return;
        }

        var maxIndex = playerSettingsRows.length - 1;
        settingsFocusIndex = Math.max(0, Math.min(index, maxIndex));
        playerSettingsRows.forEach(function (rowElement, rowIndex) {
            rowElement.classList.toggle("focused", rowIndex === settingsFocusIndex);
        });
    }

    function getPendingDwellCameraName() {
        var cameraOrder = TVAppState.getCameraOrder();
        if (!cameraOrder || !cameraOrder.length) {
            return "";
        }

        var index = Math.max(0, Math.min(pendingDwellCameraIndex, cameraOrder.length - 1));
        return cameraOrder[index];
    }

    function renderPlayerSettingsUi() {
        if (!playerSettingsPanel) {
            return;
        }

        var dwellCameraName = getPendingDwellCameraName();
        if (settingCycleModeValue) {
            settingCycleModeValue.textContent = cycleModeLabel(pendingCycleMode);
        }

        if (settingDwellCameraValue) {
            settingDwellCameraValue.textContent = TVAppState.getCameraLabel(dwellCameraName);
        }

        if (settingDwellTimeValue) {
            settingDwellTimeValue.textContent = cycleLabel(getDwellSecondsForCamera(dwellCameraName, pendingPerCameraDwellSeconds));
        }

        if (settingPictureModeValue) {
            settingPictureModeValue.textContent = pictureModeLabel(pendingPictureMode);
        }

        if (settingWeatherLocationValue) {
            settingWeatherLocationValue.textContent = weatherLocationLabel(pendingWeatherLocationId);
        }

        if (settingHudAutoHideValue) {
            settingHudAutoHideValue.textContent = hudAutoHideLabel(pendingHudAutoHideSeconds);
        }

        setPlayerSettingsFocus(settingsFocusIndex);
    }

    function stopAutoCycle() {
        clearTimeout(autoCycleTimer);
        autoCycleTimer = null;
    }

    function isCameraInMotion(cameraName) {
        var payload = diagnostics.lastViewStatus;
        if (!payload || !payload.cameras || typeof payload.cameras !== "object") {
            return false;
        }

        var item = payload.cameras[cameraName] || {};
        if (!item || typeof item !== "object") {
            return false;
        }

        if (item.motion === true || item.motion_detected === true || item.motionActive === true || item.in_motion === true) {
            return true;
        }

        if (typeof item.motion_level === "number") {
            return item.motion_level > 0;
        }

        if (typeof item.motion_score === "number") {
            return item.motion_score > 0;
        }

        if (item.events && typeof item.events.motion === "boolean") {
            return item.events.motion;
        }

        return false;
    }

    function findNextMotionCamera(currentCamera, direction) {
        var cameraOrder = TVAppState.getCameraOrder();
        if (!cameraOrder || !cameraOrder.length) {
            return null;
        }

        var currentIndex = cameraOrder.indexOf(currentCamera);
        if (currentIndex < 0) {
            currentIndex = TVAppState.getFocusIndex();
        }
        if (currentIndex < 0) {
            currentIndex = 0;
        }

        var step = direction === "LEFT" ? -1 : 1;
        var tries;
        for (tries = 0; tries < cameraOrder.length; tries += 1) {
            currentIndex = (currentIndex + step + cameraOrder.length) % cameraOrder.length;
            if (isCameraInMotion(cameraOrder[currentIndex])) {
                return cameraOrder[currentIndex];
            }
        }

        return null;
    }

    function getCurrentCameraDwellSeconds() {
        var currentCamera = TVAppState.getCurrentCamera();
        return getDwellSecondsForCamera(currentCamera, perCameraDwellSeconds);
    }

    function restartAutoCycle() {
        stopAutoCycle();

        if (TVAppState.getMode() !== "PLAYER" || playerSettingsVisible || PlayerUI.isErrorVisible()) {
            return;
        }

        var delaySeconds = getCurrentCameraDwellSeconds();

        autoCycleTimer = setTimeout(function () {
            autoCycleTimer = null;
            if (TVAppState.getMode() !== "PLAYER" || playerSettingsVisible || PlayerUI.isErrorVisible()) {
                return;
            }

            if (cycleMode === "MOTION") {
                var nextMotionCamera = findNextMotionCamera(TVAppState.getCurrentCamera(), "RIGHT");
                if (!nextMotionCamera) {
                    if ((Date.now() - weatherLastNoMotionAt) > 8000) {
                        PlayerUI.setStatus("Waiting for motion...");
                        weatherLastNoMotionAt = Date.now();
                    }
                    restartAutoCycle();
                    return;
                }

                cyclePlayerCamera("RIGHT", {
                    fromAutoCycle: true,
                    targetCamera: nextMotionCamera
                });
                return;
            }

            cyclePlayerCamera("RIGHT", { fromAutoCycle: true });
        }, delaySeconds * 1000);
    }

    function openPlayerSettings() {
        if (!playerSettingsPanel) {
            return;
        }

        pendingCycleMode = cycleMode;
        pendingPerCameraDwellSeconds = cloneDwellMap(perCameraDwellSeconds);
        pendingPictureMode = pictureMode;
        pendingWeatherLocationId = weatherLocationId;
        pendingHudAutoHideSeconds = hudAutoHideSeconds;
        pendingDwellCameraIndex = TVAppState.getFocusIndex();
        settingsFocusIndex = 0;
        playerSettingsVisible = true;
        playerSettingsPanel.classList.remove("hidden");
        renderPlayerSettingsUi();
        stopAutoCycle();
    }

    function closePlayerSettings(applyChanges) {
        if (!playerSettingsPanel) {
            return;
        }

        if (applyChanges) {
            cycleMode = normalizeCycleMode(pendingCycleMode);
            perCameraDwellSeconds = cloneDwellMap(pendingPerCameraDwellSeconds);
            pictureMode = normalizePictureMode(pendingPictureMode);
            weatherLocationId = normalizeWeatherLocationId(pendingWeatherLocationId);
            hudAutoHideSeconds = normalizeHudAutoHideSeconds(pendingHudAutoHideSeconds);
            savePlayerPreferences();
            applyPictureMode();
            PlayerUI.setAutoHideSeconds(hudAutoHideSeconds);
            fetchWeatherForecast({ force: true });
            showToast("Single-view settings saved", 1200);
        }

        playerSettingsVisible = false;
        playerSettingsPanel.classList.add("hidden");
        restartAutoCycle();
    }

    function cyclePendingValue(valueList, currentValue, direction) {
        var currentIndex = valueList.indexOf(currentValue);
        if (currentIndex < 0) {
            currentIndex = 0;
        }

        if (direction === "LEFT") {
            currentIndex = (currentIndex - 1 + valueList.length) % valueList.length;
        } else {
            currentIndex = (currentIndex + 1) % valueList.length;
        }

        return valueList[currentIndex];
    }

    function adjustPendingSettings(direction) {
        var cameraOrder = TVAppState.getCameraOrder();
        var dwellCameraName;

        if (settingsFocusIndex === 0) {
            pendingCycleMode = cyclePendingValue(CYCLE_MODE_OPTIONS, pendingCycleMode, direction);
            return;
        }

        if (settingsFocusIndex === 1) {
            if (!cameraOrder || !cameraOrder.length) {
                return;
            }
            if (direction === "LEFT") {
                pendingDwellCameraIndex = (pendingDwellCameraIndex - 1 + cameraOrder.length) % cameraOrder.length;
            } else {
                pendingDwellCameraIndex = (pendingDwellCameraIndex + 1) % cameraOrder.length;
            }
            return;
        }

        if (settingsFocusIndex === 2) {
            dwellCameraName = getPendingDwellCameraName();
            pendingPerCameraDwellSeconds[dwellCameraName] = cyclePendingValue(
                DWELL_OPTIONS,
                getDwellSecondsForCamera(dwellCameraName, pendingPerCameraDwellSeconds),
                direction
            );
            return;
        }

        if (settingsFocusIndex === 3) {
            pendingPictureMode = cyclePendingValue(PICTURE_MODE_OPTIONS, pendingPictureMode, direction);
            return;
        }

        if (settingsFocusIndex === 4) {
            var weatherIds = WEATHER_LOCATIONS.map(function (item) { return item.id; });
            pendingWeatherLocationId = cyclePendingValue(weatherIds, pendingWeatherLocationId, direction);
            return;
        }

        if (settingsFocusIndex === 5) {
            pendingHudAutoHideSeconds = cyclePendingValue(HUD_AUTO_HIDE_OPTIONS, pendingHudAutoHideSeconds, direction);
        }
    }

    function handlePlayerSettingsKey(keyCode) {
        if (keyCode === KEY.RETURN) {
            closePlayerSettings(false);
            return true;
        }

        if (keyCode === KEY.UP) {
            setPlayerSettingsFocus(settingsFocusIndex - 1);
            return true;
        }

        if (keyCode === KEY.DOWN) {
            setPlayerSettingsFocus(settingsFocusIndex + 1);
            return true;
        }

        if (keyCode === KEY.LEFT || keyCode === KEY.RIGHT) {
            adjustPendingSettings(keyCode === KEY.LEFT ? "LEFT" : "RIGHT");
            renderPlayerSettingsUi();
            return true;
        }

        if (keyCode === KEY.ENTER) {
            closePlayerSettings(true);
            return true;
        }

        return false;
    }

    function cyclePlayerCamera(direction, options) {
        options = options || {};

        var cameraOrder = TVAppState.getCameraOrder();
        if (!cameraOrder || cameraOrder.length === 0) {
            return;
        }

        var currentCamera = TVAppState.getCurrentCamera();
        var currentIndex = cameraOrder.indexOf(currentCamera);
        if (currentIndex < 0) {
            currentIndex = TVAppState.getFocusIndex();
        }
        if (currentIndex < 0) {
            currentIndex = 0;
        }

        var nextCamera = options.targetCamera || null;
        var nextIndex = nextCamera ? cameraOrder.indexOf(nextCamera) : -1;

        if (nextIndex < 0) {
            var delta = direction === "LEFT" ? -1 : 1;
            nextIndex = (currentIndex + delta + cameraOrder.length) % cameraOrder.length;
            nextCamera = cameraOrder[nextIndex];
        }

        if (!nextCamera || nextCamera === currentCamera) {
            restartAutoCycle();
            return;
        }

        TVAppState.setFocusIndex(nextIndex);
        GridUI.setFocusIndex(nextIndex);
        TVAppState.setCurrentCamera(nextCamera);
        PlayerUI.enter(TVAppState.getCameraLabel(nextCamera));
        if (options.fromAutoCycle && cycleMode === "MOTION") {
            PlayerUI.setStatus("Motion detected: switching...");
        } else {
            PlayerUI.setStatus(options.fromAutoCycle ? "Auto cycling..." : "Switching...");
        }

        if (!options.fromAutoCycle) {
            showToast("Camera: " + TVAppState.getCameraLabel(nextCamera), 1000);
        }

        openAndPlayCamera(nextCamera, { reopen: true });
    }

    function applyPictureMode() {
        if (!pictureModeLayer) {
            return;
        }

        pictureModeLayer.classList.remove("night", "bright");
        if (pictureMode === "NIGHT") {
            pictureModeLayer.classList.remove("hidden");
            pictureModeLayer.classList.add("night");
            return;
        }

        if (pictureMode === "BRIGHT") {
            pictureModeLayer.classList.remove("hidden");
            pictureModeLayer.classList.add("bright");
            return;
        }

        pictureModeLayer.classList.add("hidden");
    }

    function weatherCodeLabel(code) {
        var map = {
            0: "Clear",
            1: "Mainly clear",
            2: "Partly cloudy",
            3: "Cloudy",
            45: "Fog",
            48: "Rime fog",
            51: "Drizzle",
            53: "Drizzle",
            55: "Drizzle",
            56: "Freezing drizzle",
            57: "Freezing drizzle",
            61: "Rain",
            63: "Rain",
            65: "Heavy rain",
            66: "Freezing rain",
            67: "Freezing rain",
            71: "Snow",
            73: "Snow",
            75: "Heavy snow",
            80: "Rain showers",
            81: "Rain showers",
            82: "Heavy showers",
            95: "Thunderstorm",
            96: "Thunderstorm",
            99: "Thunderstorm"
        };

        return map[code] || "Unknown";
    }

    function formatWeatherTemp(value) {
        var numeric = Number(value);
        if (isNaN(numeric)) {
            return "--";
        }

        var fahrenheit = Math.round((numeric * 9 / 5) + 32);
        return String(fahrenheit) + "F";
    }

    function formatWeatherHour(isoTime) {
        var date = new Date(isoTime);
        if (isNaN(date.getTime())) {
            return "--:--";
        }

        return date.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
        });
    }

    function renderWeatherUi() {
        if (hudWeather) {
            if (weatherData) {
                hudWeather.textContent = weatherData.locationLabel + " | " + formatWeatherTemp(weatherData.currentTempC) + " " + weatherCodeLabel(weatherData.currentCode);
            } else {
                hudWeather.textContent = "Weather unavailable";
            }
        }

        if (!weatherOverlayTitle || !weatherOverlayList) {
            return;
        }

        if (!weatherData) {
            weatherOverlayTitle.textContent = "Weather Forecast";
            weatherOverlayList.innerHTML = '<div class="weather-row"><span class="weather-time">No forecast data</span><span class="weather-temp">--</span><span class="weather-desc">--</span></div>';
            return;
        }

        weatherOverlayTitle.textContent = weatherData.locationLabel + " Hourly";
        weatherOverlayList.innerHTML = weatherData.hourly.map(function (entry) {
            return [
                '<div class="weather-row">',
                '<span class="weather-time">' + formatWeatherHour(entry.time) + '</span>',
                '<span class="weather-temp">' + formatWeatherTemp(entry.tempC) + '</span>',
                '<span class="weather-desc">' + weatherCodeLabel(entry.code) + '</span>',
                '</div>'
            ].join("");
        }).join("");
    }

    function resolveWeatherLocation() {
        var selected = findWeatherLocationById(weatherLocationId);
        if (selected.id !== "auto") {
            return Promise.resolve(selected);
        }

        var fallback = findWeatherLocationById("henderson_nv");
        return new Promise(function (resolve) {
            if (!global.navigator || !global.navigator.geolocation || typeof global.navigator.geolocation.getCurrentPosition !== "function") {
                resolve(fallback);
                return;
            }

            var resolved = false;
            var timeoutId = setTimeout(function () {
                if (resolved) {
                    return;
                }
                resolved = true;
                resolve(fallback);
            }, 1700);

            global.navigator.geolocation.getCurrentPosition(function (position) {
                if (resolved) {
                    return;
                }
                resolved = true;
                clearTimeout(timeoutId);
                resolve({
                    id: "auto",
                    label: "Auto",
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                });
            }, function () {
                if (resolved) {
                    return;
                }
                resolved = true;
                clearTimeout(timeoutId);
                resolve(fallback);
            }, {
                enableHighAccuracy: false,
                timeout: 1300,
                maximumAge: 300000
            });
        });
    }

    function scheduleWeatherRefresh() {
        clearTimeout(weatherRefreshTimer);
        weatherRefreshTimer = setTimeout(function () {
            fetchWeatherForecast({ force: true });
        }, WEATHER_REFRESH_MS);
    }

    function fetchWeatherForecast(options) {
        options = options || {};

        var isFresh = (Date.now() - weatherLastFetchedAt) < (WEATHER_REFRESH_MS / 2);
        if (!options.force && isFresh) {
            renderWeatherUi();
            return Promise.resolve(weatherData);
        }

        var fetchToken = ++weatherFetchToken;
        return resolveWeatherLocation().then(function (location) {
            var weatherUrl = [
                "https://api.open-meteo.com/v1/forecast?timezone=auto",
                "latitude=" + encodeURIComponent(String(location.latitude)),
                "longitude=" + encodeURIComponent(String(location.longitude)),
                "current=temperature_2m,weather_code",
                "hourly=temperature_2m,weather_code",
                "forecast_days=2"
            ].join("&");

            return global.fetch(weatherUrl, { cache: "no-store" }).then(function (response) {
                if (!response || !response.ok) {
                    throw new Error("Weather request failed");
                }
                return response.json();
            }).then(function (payload) {
                if (fetchToken !== weatherFetchToken) {
                    return null;
                }

                var hourly = [];
                var hourlyTime = payload && payload.hourly ? payload.hourly.time || [] : [];
                var hourlyTemp = payload && payload.hourly ? payload.hourly.temperature_2m || [] : [];
                var hourlyCode = payload && payload.hourly ? payload.hourly.weather_code || [] : [];
                var now = Date.now();
                var i;

                for (i = 0; i < hourlyTime.length && hourly.length < 8; i += 1) {
                    var timeValue = new Date(hourlyTime[i]);
                    if (isNaN(timeValue.getTime()) || timeValue.getTime() < now) {
                        continue;
                    }

                    hourly.push({
                        time: hourlyTime[i],
                        tempC: hourlyTemp[i],
                        code: Number(hourlyCode[i]) || 0
                    });
                }

                weatherData = {
                    locationLabel: location.label,
                    currentTempC: payload && payload.current ? payload.current.temperature_2m : null,
                    currentCode: payload && payload.current ? Number(payload.current.weather_code) || 0 : 0,
                    hourly: hourly,
                    updatedAt: nowIso()
                };

                weatherLastFetchedAt = Date.now();
                renderWeatherUi();
                scheduleWeatherRefresh();
                return weatherData;
            });
        }).catch(function () {
            if (fetchToken !== weatherFetchToken) {
                return null;
            }
            weatherData = null;
            renderWeatherUi();
            scheduleWeatherRefresh();
            return null;
        });
    }

    function setWeatherOverlayVisible(visible) {
        var allowed = visible && TVAppState.getMode() === "PLAYER";
        weatherOverlayVisible = !!allowed;

        if (weatherOverlay) {
            weatherOverlay.classList.toggle("hidden", !weatherOverlayVisible);
        }

        if (weatherOverlayVisible) {
            fetchWeatherForecast({ force: false });
            PlayerUI.pingHudActivity();
        }
    }

    function setDebugVisible(visible) {
        debugVisible = !!visible;

        if (!debugPanel) {
            return;
        }

        debugPanel.classList.toggle("hidden", !debugVisible);
        if (debugTitle) {
            debugTitle.textContent = "Bridge Diagnostics (Yellow: close, Green: deep probe)";
        }

        if (!debugVisible) {
            clearInterval(debugRefreshTimer);
            debugRefreshTimer = null;
            return;
        }

        renderDebugSnapshot();
        refreshDebugPanel({ deepProbe: false });
        clearInterval(debugRefreshTimer);
        debugRefreshTimer = setInterval(function () {
            refreshDebugPanel({ deepProbe: false });
        }, 10000);
    }

    function fetchViewStatus() {
        var startedAt = opStart();
        return TVApi.getViewStatus().then(function (payload) {
            diagnostics.lastViewStatus = payload;
            markOpSuccess("viewStatus", startedAt, "active=" + (payload && payload.active_camera ? payload.active_camera : "none"));
            applyViewStatusToTiles(payload);
            return payload;
        }, function (error) {
            markOpFailure("viewStatus", startedAt, error);
            TVAppState.setAllCameraDebugInfo("view/status err: " + shortError(error));
            throw error;
        });
    }

    function fetchDiagQuick() {
        var startedAt = opStart();
        return TVApi.getDiagStreams({
            timeoutMs: 7000
        }).then(function (payload) {
            diagnostics.lastDiagQuick = payload;
            markOpSuccess("diagQuick", startedAt, "ok");
            return payload;
        }, function (error) {
            markOpFailure("diagQuick", startedAt, error);
            throw error;
        });
    }

    function fetchDiagDeep() {
        var startedAt = opStart();
        return TVApi.getDiagStreams({
            startPublishers: true,
            probe: true,
            probeTimeoutSeconds: 25,
            timeoutMs: 32000
        }).then(function (payload) {
            diagnostics.lastDiagDeep = payload;
            markOpSuccess("diagDeep", startedAt, "probe");
            return payload;
        }, function (error) {
            markOpFailure("diagDeep", startedAt, error);
            throw error;
        });
    }

    function refreshDebugPanel(options) {
        options = options || {};

        fetchViewStatus().catch(function () {
            return null;
        }).then(function () {
            return fetchDiagQuick().catch(function () {
                return null;
            });
        }).then(function () {
            if (options.deepProbe) {
                return fetchDiagDeep().catch(function () {
                    return null;
                });
            }
            return null;
        }).then(function () {
            renderDebugSnapshot();
        });
    }

    function mergeOpenResponseIntoState(openResponse) {
        if (!openResponse || !openResponse.camera) {
            return;
        }

        TVAppState.applyBackendState({
            state_version: openResponse.state_version,
            state_updated_at: openResponse.state_updated_at,
            startup_grace_ms: openResponse.startup_grace_ms,
            cameras: [openResponse]
        });
    }

    function requestOpen(cameraName, options) {
        options = options || {};
        var startedAt = opStart();
        return TVApi.openCamera(cameraName, {
            timeoutMs: options.timeoutMs,
            retries: options.retries
        }).then(function (payload) {
            markOpSuccess("open", startedAt, cameraName + " ready=" + (!!payload.ready));
            TVAppState.setCameraDebugInfo(cameraName, "open ok ready=" + (!!payload.ready));
            return payload;
        }, function (error) {
            markOpFailure("open", startedAt, error, cameraName);
            TVAppState.setCameraDebugInfo(cameraName, "open err: " + shortError(error));
            throw error;
        });
    }

    function requestViewStart(cameraName) {
        return TVApi.startView(cameraName, {
            timeoutMs: 2500,
            retries: 0
        }).then(function () {
            TVAppState.setCameraRunning(cameraName, true, "STARTING");
            TVAppState.setCameraDebugInfo(cameraName, "start req ok");
            return true;
        }, function () {
            return false;
        });
    }

    function allGridCamerasRunning() {
        var cameras = TVAppState.getCameras();
        var cameraOrder = TVAppState.getCameraOrder();

        return cameraOrder.every(function (name) {
            return cameras[name] && cameras[name].running;
        });
    }

    function warmupGridFeeds(reason) {
        if (TVAppState.getMode() !== "GRID") {
            return;
        }

        var now = Date.now();
        if ((now - lastGridWarmupAt) < GRID_WARMUP_COOLDOWN_MS) {
            return;
        }

        if (allGridCamerasRunning()) {
            return;
        }

        lastGridWarmupAt = now;
        pushDiagEvent("INFO", "grid warmup: " + String(reason || "startup"));

        TVAppState.getCameraOrder().forEach(function (cameraName, index) {
            var camera = TVAppState.getCamera(cameraName);
            if (camera && camera.running) {
                return;
            }

            setTimeout(function () {
                requestViewStart(cameraName).then(function () {
                    renderGrid();
                });
            }, index * 220);
        });

        setTimeout(function () {
            fetchViewStatus().catch(function () {
                return null;
            }).then(function () {
                renderGrid();
            });
        }, 900);
    }

    function switchToGrid() {
        TVAppState.setMode("GRID");
        playerScreen.classList.add("hidden");
        gridScreen.classList.remove("hidden");
        playerSettingsVisible = false;
        playerHasActiveStream = false;
        clearTimeout(firstFrameWatchTimer);
        firstFrameWatchTimer = null;
        lastPlayTimeTick = 0;

        stopAutoCycle();
    setWeatherOverlayVisible(false);

        PlayerUI.exit();
        TVPlayer.stopAndClose();
        clearTimeout(playbackRetryTimer);
        playbackRetryTimer = null;

        if (playerSettingsPanel) {
            playerSettingsPanel.classList.add("hidden");
        }

        warmupGridFeeds("return-to-grid");
    }

    function switchToPlayer(cameraName) {
        TVAppState.setCurrentCamera(cameraName);
        TVAppState.setMode("PLAYER");
        gridScreen.classList.add("hidden");
        playerScreen.classList.remove("hidden");
        PlayerUI.enter(TVAppState.getCameraLabel(cameraName));
        PlayerUI.setAutoHideSeconds(hudAutoHideSeconds);
        applyPictureMode();
        fetchWeatherForecast({ force: false });

        if (weatherOverlayVisible) {
            setWeatherOverlayVisible(true);
        }

        stopAutoCycle();
    }

    function extractHlsUrl(openResponse, cameraName) {
        if (openResponse && openResponse.playback && openResponse.playback.hls_url) {
            return openResponse.playback.hls_url;
        }

        if (openResponse && openResponse.preferred_url) {
            return openResponse.preferred_url;
        }

        if (openResponse && openResponse.hls_url) {
            return openResponse.hls_url;
        }

        var camera = TVAppState.getCamera(cameraName);
        if (camera && camera.playback && camera.playback.main) {
            return camera.playback.main;
        }

        return null;
    }

    function isAbsoluteUrl(url) {
        return /^https?:\/\//i.test(String(url || ""));
    }

    function resolveRelativeUrl(baseUrl, relative) {
        if (isAbsoluteUrl(relative)) {
            return relative;
        }

        var normalizedBase = String(baseUrl || "").split("?")[0];
        var slashIndex = normalizedBase.lastIndexOf("/");
        if (slashIndex === -1) {
            return relative;
        }

        var basePrefix = normalizedBase.slice(0, slashIndex + 1);
        return basePrefix + String(relative || "").replace(/^\.\//, "").replace(/^\//, "");
    }

    function resolvePlayableHlsUrl(preferredUrl) {
        var url = String(preferredUrl || "").trim();
        if (!url) {
            return Promise.resolve(url);
        }

        return new Promise(function (resolve) {
            var timeoutId = setTimeout(function () {
                resolve(url);
            }, 5000);

            global.fetch(url, { cache: "no-store" })
                .then(function (response) {
                    if (!response || !response.ok) {
                        return null;
                    }
                    return response.text();
                })
                .then(function (text) {
                    clearTimeout(timeoutId);

                    if (!text || text.indexOf("#EXT-X-STREAM-INF") === -1) {
                        resolve(url);
                        return;
                    }

                    var lines = text.split(/\r?\n/);
                    var bestUri = "";
                    var bestBandwidth = -1;
                    var i;

                    for (i = 0; i < lines.length; i += 1) {
                        var line = String(lines[i] || "").trim();
                        if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) {
                            continue;
                        }

                        var bandwidth = -1;
                        var bandwidthMatch = line.match(/(?:^|,)BANDWIDTH=(\d+)/i);
                        if (bandwidthMatch && bandwidthMatch[1]) {
                            bandwidth = parseInt(bandwidthMatch[1], 10);
                        }

                        var j;
                        for (j = i + 1; j < lines.length; j += 1) {
                            var candidate = String(lines[j] || "").trim();
                            if (!candidate) {
                                continue;
                            }
                            if (candidate.charAt(0) === "#") {
                                continue;
                            }

                            if (bandwidth > bestBandwidth) {
                                bestBandwidth = bandwidth;
                                bestUri = candidate;
                            }
                            break;
                        }
                    }

                    if (bestUri) {
                        resolve(resolveRelativeUrl(url, bestUri));
                        return;
                    }

                    resolve(url);
                })
                .catch(function () {
                    clearTimeout(timeoutId);
                    resolve(url);
                });
        });
    }

    function openAndPlayCamera(cameraName, options) {
        options = options || {};
        var token = ++openRequestToken;
        var shouldReopen = options.reopen !== false;
        var startupRetries = typeof options.startupRetries === "number" ? options.startupRetries : 1;

        stopAutoCycle();

        function cancelledError() {
            var error = new Error("Superseded open request");
            error.cancelled = true;
            return error;
        }

        function ensureToken() {
            if (token !== openRequestToken) {
                throw cancelledError();
            }
        }

        clearTimeout(playbackRetryTimer);
        playbackRetryTimer = null;
        playerHasActiveStream = false;

        PlayerUI.hideError();
        PlayerUI.showLoading(true);
        PlayerUI.setStatus("Requesting stream...");

        var openPromise = shouldReopen ? requestOpen(cameraName) : Promise.resolve(null);

        return openPromise
            .then(function (openResponse) {
                ensureToken();

                if (openResponse) {
                    mergeOpenResponseIntoState(openResponse);
                }

                var hlsUrl = extractHlsUrl(openResponse, cameraName);
                if (hlsUrl) {
                    TVAppState.setCameraPlaybackUrl(cameraName, hlsUrl);
                }

                return {
                    openResponse: openResponse,
                    hlsUrl: hlsUrl,
                    startupGraceMs: (openResponse && typeof openResponse.startup_grace_ms === "number")
                        ? openResponse.startup_grace_ms
                        : TVAppState.getStartupGraceMs(),
                    ready: !!(openResponse && openResponse.ready)
                };
            })
            .then(function (context) {
                ensureToken();

                if (!context.ready) {
                    context.ready = TVAppState.isCameraRunning(cameraName);
                }

                if (context.ready) {
                    return context;
                }

                PlayerUI.setStatus("Starting stream...");
                return TVAppState.waitForCameraRunning(cameraName, context.startupGraceMs).then(function (becameReady) {
                    if (becameReady) {
                        context.ready = true;
                        return context;
                    }

                    if (!shouldReopen || startupRetries <= 0) {
                        throw new Error("Stream unavailable after startup grace timeout");
                    }

                    PlayerUI.setStatus("Still starting... retrying open");
                    return requestOpen(cameraName).then(function (retryResponse) {
                        ensureToken();
                        mergeOpenResponseIntoState(retryResponse);

                        var retryUrl = extractHlsUrl(retryResponse, cameraName) || context.hlsUrl;
                        if (retryUrl) {
                            TVAppState.setCameraPlaybackUrl(cameraName, retryUrl);
                        }

                        var retryGraceMs = (retryResponse && typeof retryResponse.startup_grace_ms === "number")
                            ? retryResponse.startup_grace_ms
                            : context.startupGraceMs;
                        var retryReady = !!(retryResponse && retryResponse.ready) || TVAppState.isCameraRunning(cameraName);

                        if (retryReady) {
                            return {
                                hlsUrl: retryUrl,
                                ready: true
                            };
                        }

                        return TVAppState.waitForCameraRunning(cameraName, retryGraceMs).then(function (readyAfterRetry) {
                            if (!readyAfterRetry) {
                                throw new Error("Stream unavailable. Please retry.");
                            }

                            return {
                                hlsUrl: retryUrl,
                                ready: true
                            };
                        });
                    });
                });
            })
            .then(function (context) {
                ensureToken();

                var hlsUrl = context.hlsUrl || extractHlsUrl(null, cameraName);
                if (!hlsUrl) {
                    throw new Error("No preferred_url found for playback");
                }

                PlayerUI.setStatus("Resolving stream...");
                var resolveStartedAt = opStart();
                return resolvePlayableHlsUrl(hlsUrl).then(function (resolvedHlsUrl) {
                    ensureToken();
                    markOpSuccess("resolveHls", resolveStartedAt, (resolvedHlsUrl || hlsUrl));
                    PlayerUI.setStatus("Starting AVPlay...");
                    var avplayStartedAt = opStart();
                    return TVPlayer.play(resolvedHlsUrl || hlsUrl).then(function () {
                        markOpSuccess("avplay", avplayStartedAt, cameraName);
                    }, function (error) {
                        markOpFailure("avplay", avplayStartedAt, error, cameraName);
                        throw error;
                    });
                });
            })
            .then(function () {
                ensureToken();

                PlayerUI.showLoading(false);
                PlayerUI.showBuffering(false);
                PlayerUI.setStatus("LIVE");
                playerHasActiveStream = true;
                playbackRetryAttempt = 0;

                clearTimeout(firstFrameWatchTimer);
                firstFrameWatchTimer = setTimeout(function () {
                    if (TVAppState.getMode() !== "PLAYER") {
                        return;
                    }

                    if (lastPlayTimeTick > 0) {
                        return;
                    }

                    playerHasActiveStream = false;
                    schedulePlaybackRetry(cameraName, new Error("No video frames received"));
                }, 9000);

                restartAutoCycle();
            })
            .catch(function (error) {
                if (error && error.cancelled) {
                    return;
                }

                if (token !== openRequestToken) {
                    return;
                }

                console.error("openAndPlayCamera failed", error);
                PlayerUI.showLoading(false);
                PlayerUI.showBuffering(false);
                playerHasActiveStream = false;
                clearTimeout(firstFrameWatchTimer);
                firstFrameWatchTimer = null;
                TVAppState.setCameraDebugInfo(cameraName, "play err: " + shortError(error));
                schedulePlaybackRetry(cameraName, error);
            });
    }

    function schedulePlaybackRetry(cameraName, error) {
        stopAutoCycle();

        if (playbackRetryAttempt >= MAX_AUTO_PLAYBACK_RETRIES) {
            clearTimeout(playbackRetryTimer);
            playbackRetryTimer = null;
            PlayerUI.setStatus("UNAVAILABLE");
            PlayerUI.showError("Stream unavailable after retries. Press Retry or Back.");
            return;
        }

        playbackRetryAttempt += 1;
        var delayMs = Math.min(15000, 1000 * Math.pow(2, playbackRetryAttempt - 1));
        var seconds = Math.round(delayMs / 1000);
        var message = "Starting stream: " + (error && error.message ? error.message : "unknown error") + ". Auto retry in " + seconds + "s.";

        PlayerUI.setStatus("STARTING");
        PlayerUI.showError(message);

        clearTimeout(playbackRetryTimer);
        playbackRetryTimer = setTimeout(function () {
            if (TVAppState.getMode() !== "PLAYER") {
                return;
            }
            openAndPlayCamera(cameraName, { reopen: true });
        }, delayMs);
    }

    function handlePlayerErrorAction() {
        var action = PlayerUI.getSelectedErrorAction();
        var currentCamera = TVAppState.getCurrentCamera();

        if (action === "retry" && currentCamera) {
            openAndPlayCamera(currentCamera, { reopen: true });
            return;
        }

        switchToGrid();
    }

    function handleGridKey(keyCode) {
        if (keyCode === KEY.YELLOW) {
            setDebugVisible(!debugVisible);
            return;
        }

        if (keyCode === KEY.GREEN && debugVisible) {
            showToast("Running deep diagnostics...");
            refreshDebugPanel({ deepProbe: true });
            return;
        }

        if (keyCode === KEY.LEFT) {
            GridUI.moveFocus("LEFT");
        } else if (keyCode === KEY.RIGHT) {
            GridUI.moveFocus("RIGHT");
        } else if (keyCode === KEY.UP) {
            GridUI.moveFocus("UP");
        } else if (keyCode === KEY.DOWN) {
            GridUI.moveFocus("DOWN");
        } else if (keyCode === KEY.ENTER) {
            var selected = GridUI.getFocusedCameraName();
            if (!selected) {
                return;
            }
            switchToPlayer(selected);
            openAndPlayCamera(selected, { reopen: true });
        } else if (keyCode === KEY.RETURN) {
            if (debugVisible) {
                setDebugVisible(false);
                return;
            }

            var now = Date.now();
            if (now - lastBackPressAt < 1200) {
                exitApp();
            } else {
                lastBackPressAt = now;
                showToast("Press Back again to exit");
            }
        }
    }

    function handlePlayerKey(keyCode) {
        if (playerSettingsVisible) {
            if (handlePlayerSettingsKey(keyCode)) {
                return;
            }
            return;
        }

        if (keyCode !== KEY.PAUSE && keyCode !== KEY.PLAY && keyCode !== KEY.PLAY_PAUSE) {
            PlayerUI.pingHudActivity();
        }

        if (PlayerUI.isErrorVisible()) {
            if (keyCode === KEY.LEFT) {
                PlayerUI.moveErrorActionFocus("LEFT");
                return;
            }
            if (keyCode === KEY.RIGHT) {
                PlayerUI.moveErrorActionFocus("RIGHT");
                return;
            }
            if (keyCode === KEY.ENTER) {
                handlePlayerErrorAction();
                return;
            }
        }

        if (keyCode === KEY.ENTER) {
            openPlayerSettings();
            return;
        }

        if (keyCode === KEY.LEFT) {
            cyclePlayerCamera("LEFT");
            return;
        }

        if (keyCode === KEY.RIGHT) {
            cyclePlayerCamera("RIGHT");
            return;
        }

        if (keyCode === KEY.UP) {
            setWeatherOverlayVisible(true);
            return;
        }

        if (keyCode === KEY.DOWN) {
            if (weatherOverlayVisible) {
                setWeatherOverlayVisible(false);
                return;
            }
            PlayerUI.showHud(true);
            return;
        }

        if (keyCode === KEY.RETURN) {
            switchToGrid();
            return;
        }

        if (keyCode === KEY.PAUSE || keyCode === KEY.PLAY || keyCode === KEY.PLAY_PAUSE) {
            var state = TVPlayer.togglePause();
            PlayerUI.setStatus(state === "PAUSED" ? "PAUSED" : "LIVE");
        }
    }

    function maybeRecoverPlaybackAfterPoll() {
        if (TVAppState.getMode() !== "PLAYER" || playerHasActiveStream || pollPlaybackRecoverInFlight) {
            return;
        }

        var currentCamera = TVAppState.getCurrentCamera();
        if (!currentCamera) {
            return;
        }

        var cameraState = TVAppState.getCamera(currentCamera);
        if (!cameraState || !cameraState.running) {
            return;
        }

        pollPlaybackRecoverInFlight = true;
        PlayerUI.setStatus("Stream ready, starting...");
        openAndPlayCamera(currentCamera, { reopen: false, startupRetries: 0 }).then(function () {
            pollPlaybackRecoverInFlight = false;
        }, function () {
            pollPlaybackRecoverInFlight = false;
        });
    }

    function handleKeyDown(event) {
        var keyCode = event.keyCode;

        if (keyCode === KEY.EXIT) {
            exitApp();
            return;
        }

        if (TVAppState.getMode() === "GRID") {
            handleGridKey(keyCode);
        } else {
            handlePlayerKey(keyCode);
        }
    }

    function scheduleNextPoll() {
        clearTimeout(pollTimer);

        var baseInterval = TVAppState.getPollIntervalMs();
        var delay = Math.min(30000, baseInterval * Math.pow(2, pollBackoffStep));

        pollTimer = setTimeout(runPollCycle, delay);
    }

    function scheduleBootstrapRetry() {
        clearTimeout(bootstrapRetryTimer);

        var delay = Math.min(30000, 1000 * Math.pow(2, bootstrapBackoffStep));
        bootstrapRetryTimer = setTimeout(function () {
            bootstrap();
        }, delay);
    }

    function runPollCycle() {
        if (pollInFlight) {
            scheduleNextPoll();
            return;
        }

        pollInFlight = true;
        var triggeredResync = false;
        var pollStartedAt = opStart();

        TVApi.poll(TVAppState.getStateVersion(), TVAppState.getPollUrl())
            .then(function (response) {
                if (response.changed) {
                    TVAppState.applyBackendState(response);
                } else if (response.state_version !== undefined) {
                    TVAppState.applyBackendState({ state_version: response.state_version });
                }

                pollBackoffStep = 0;
                markOpSuccess("poll", pollStartedAt, "changed=" + (!!response.changed));
            }, function (error) {
                if (error && error.status === 422) {
                    console.warn("Poll state out of sync, re-running bootstrap");
                    triggeredResync = true;
                    bootstrapBackoffStep = 0;
                    markOpFailure("poll", pollStartedAt, error, "resync");
                    TVAppState.setAllCameraDebugInfo("poll resync: " + shortError(error));
                    bootstrap();
                    return;
                }

                pollBackoffStep = Math.min(pollBackoffStep + 1, 5);
                markOpFailure("poll", pollStartedAt, error);
                TVAppState.setAllCameraDebugInfo("poll err: " + shortError(error));
                console.warn("Polling failed", error);

                if (diagnostics.operations.poll.consecutiveFail >= BACKEND_UNREACHABLE_THRESHOLD) {
                    TVAppState.setAllCameraStatus("SYNC_ERROR", false);
                }
            })
            .then(function () {
                pollInFlight = false;
                if (triggeredResync) {
                    return;
                }
                if (TVAppState.getMode() === "GRID") {
                    warmupGridFeeds("poll");
                }
                maybeRecoverPlaybackAfterPoll();
                renderGrid();
                scheduleNextPoll();
            });
    }

    function registerRemoteKeys() {
        if (!global.tizen || !tizen.tvinputdevice) {
            return;
        }

        ["MediaPlayPause", "MediaPlay", "MediaPause", "Exit", "ColorF2Yellow", "ColorF1Green"].forEach(function (keyName) {
            try {
                tizen.tvinputdevice.registerKey(keyName);
            } catch (error) {
                console.warn("Key registration failed", keyName, error);
            }
        });
    }

    function exitApp() {
        clearTimeout(pollTimer);
        clearTimeout(bootstrapRetryTimer);
        clearTimeout(playbackRetryTimer);
        clearTimeout(firstFrameWatchTimer);
        clearTimeout(resizeRectTimer);
        clearTimeout(weatherRefreshTimer);
        clearInterval(diagnosticsTimer);
        clearInterval(viewStatusTimer);
        clearInterval(debugRefreshTimer);
        TVPlayer.destroy();

        try {
            if (global.tizen && tizen.application) {
                tizen.application.getCurrentApplication().exit();
                return;
            }
        } catch (error) {
            console.warn("Tizen exit failed", error);
        }

        global.close();
    }

    function bootstrap() {
        clearTimeout(bootstrapRetryTimer);
        var bootstrapStartedAt = opStart();

        TVApi.getBootstrapLite()
            .then(function (bootstrapData) {
                TVAppState.applyBackendState(bootstrapData);
                bootstrapBackoffStep = 0;
                markOpSuccess("bootstrap", bootstrapStartedAt, "sv=" + TVAppState.getStateVersion());
                updateBackendInfo();
                renderGrid();
                showToast("Connected");
                warmupGridFeeds("bootstrap");
                scheduleNextPoll();
            }, function (error) {
                console.error("Bootstrap failed", error);
                bootstrapBackoffStep = Math.min(bootstrapBackoffStep + 1, 5);
                markOpFailure("bootstrap", bootstrapStartedAt, error);
                TVAppState.setAllCameraDebugInfo("bootstrap err: " + shortError(error));

                if (diagnostics.operations.bootstrap.consecutiveFail >= BACKEND_UNREACHABLE_THRESHOLD) {
                    TVAppState.setAllCameraStatus("BACKEND_UNREACHABLE", false);
                }

                renderGrid();
                showToast("Bridge unavailable: " + shortError(error));
                scheduleBootstrapRetry();
            });
    }

    function bindLifecycle() {
        document.addEventListener("keydown", handleKeyDown);

        global.addEventListener("resize", function () {
            clearTimeout(resizeRectTimer);
            resizeRectTimer = setTimeout(function () {
                if (TVAppState.getMode() === "PLAYER") {
                    TVPlayer.refreshDisplayRect();
                }
            }, 150);
        });

        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                playerHasActiveStream = false;
                TVPlayer.stopAndClose();
                return;
            }

            if (TVAppState.getMode() !== "PLAYER") {
                return;
            }

            TVPlayer.refreshDisplayRect();

            var currentCamera = TVAppState.getCurrentCamera();
            if (currentCamera) {
                PlayerUI.setStatus("Resuming...");
                openAndPlayCamera(currentCamera, { reopen: false });
            }
        });

        global.addEventListener("beforeunload", function () {
            TVPlayer.destroy();
        });
    }

    function bindStateListeners() {
        TVAppState.subscribe(function (eventType) {
            if (eventType === "state" || eventType === "camera") {
                renderGrid();
                if (TVAppState.getMode() === "PLAYER") {
                    var currentCamera = TVAppState.getCurrentCamera();
                    var cameraState = TVAppState.getCamera(currentCamera);
                    if (cameraState) {
                        PlayerUI.setCameraName(cameraState.label);
                    }
                }
            }
        });
    }

    function initDom() {
        gridScreen = byId("grid-screen");
        playerScreen = byId("player-screen");
        backendInfo = byId("backend-info");
        toast = byId("toast");
        telemetryStrip = byId("telemetry-strip");
        debugPanel = byId("debug-panel");
        debugTitle = byId("debug-title");
        debugContent = byId("debug-content");
        playerSettingsPanel = byId("player-settings");
        playerSettingsRows = [
            byId("setting-row-cycle-mode"),
            byId("setting-row-dwell-camera"),
            byId("setting-row-dwell-time"),
            byId("setting-row-picture-mode"),
            byId("setting-row-weather-location"),
            byId("setting-row-hud-autohide")
        ].filter(function (row) {
            return !!row;
        });
        settingCycleModeValue = byId("setting-cycle-mode-value");
        settingDwellCameraValue = byId("setting-dwell-camera-value");
        settingDwellTimeValue = byId("setting-dwell-time-value");
        settingPictureModeValue = byId("setting-picture-mode-value");
        settingWeatherLocationValue = byId("setting-weather-location-value");
        settingHudAutoHideValue = byId("setting-hud-autohide-value");
        pictureModeLayer = byId("picture-mode-layer");
        hudWeather = byId("hud-weather");
        weatherOverlay = byId("weather-overlay");
        weatherOverlayTitle = byId("weather-overlay-title");
        weatherOverlayList = byId("weather-overlay-list");

        GridUI.init(byId("camera-grid"), TVAppState.getCameraOrder());
        PlayerUI.init({
            hud: byId("player-hud"),
            hudCameraName: byId("hud-camera-name"),
            hudStatus: byId("hud-status"),
            hudClock: byId("hud-clock"),
            loading: byId("player-loading"),
            buffering: byId("player-buffering"),
            error: byId("player-error"),
            errorMessage: byId("player-error-message"),
            errorRetry: byId("error-action-retry"),
            errorBack: byId("error-action-back")
        });
    }

    function initPlayerCallbacks() {
        TVPlayer.init({
            onBufferingStart: function () {
                PlayerUI.showBuffering(true);
                PlayerUI.setStatus("BUFFERING");
            },
            onBufferingComplete: function () {
                PlayerUI.showBuffering(false);
                PlayerUI.showLoading(false);
                PlayerUI.setStatus("LIVE");
                playerHasActiveStream = true;
            },
            onCurrentPlayTime: function () {
                lastPlayTimeTick = Date.now();
                clearTimeout(firstFrameWatchTimer);
                firstFrameWatchTimer = null;
                playerHasActiveStream = true;
            },
            onError: function (error) {
                var camera = TVAppState.getCurrentCamera();
                playerHasActiveStream = false;
                clearTimeout(firstFrameWatchTimer);
                firstFrameWatchTimer = null;
                if (camera) {
                    schedulePlaybackRetry(camera, error || new Error("AVPlay error"));
                }
            },
            onEvent: function (eventName, data) {
                console.log("AVPlay event", eventName, data || "");
            }
        });
    }

    function initialize() {
        initDom();
        loadPlayerPreferences();
        pendingCycleMode = cycleMode;
        pendingPerCameraDwellSeconds = cloneDwellMap(perCameraDwellSeconds);
        pendingPictureMode = pictureMode;
        pendingWeatherLocationId = weatherLocationId;
        pendingHudAutoHideSeconds = hudAutoHideSeconds;
        pendingDwellCameraIndex = TVAppState.getFocusIndex();
        PlayerUI.setAutoHideSeconds(hudAutoHideSeconds);
        applyPictureMode();
        setWeatherOverlayVisible(false);
        renderPlayerSettingsUi();
        renderWeatherUi();
        fetchWeatherForecast({ force: true });
        bindStateListeners();
        bindLifecycle();
        registerRemoteKeys();
        initPlayerCallbacks();
        renderGrid();
        updateBackendInfo();
        switchToGrid();
        setDebugVisible(false);
        updateTelemetryStrip();
        diagnosticsTimer = setInterval(function () {
            fetchViewStatus().catch(function () {
                return null;
            });
        }, 12000);
        viewStatusTimer = setInterval(function () {
            if (TVAppState.getMode() !== "GRID") {
                return;
            }
            fetchViewStatus().catch(function () {
                return null;
            });
        }, 3000);
        bootstrap();
    }

    document.addEventListener("DOMContentLoaded", initialize);
})(window);
