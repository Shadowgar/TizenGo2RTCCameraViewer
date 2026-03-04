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

    var pollTimer = null;
    var pollBackoffStep = 0;
    var pollInFlight = false;
    var openRequestToken = 0;
    var lastBackPressAt = 0;
    var playbackRetryTimer = null;
    var playbackRetryAttempt = 0;

    function byId(id) {
        return document.getElementById(id);
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
    }

    function renderGrid() {
        GridUI.render(TVAppState.getCameras());
    }

    function switchToGrid() {
        TVAppState.setMode("GRID");
        playerScreen.classList.add("hidden");
        gridScreen.classList.remove("hidden");

        PlayerUI.exit();
        TVPlayer.stopAndClose();
        clearTimeout(playbackRetryTimer);
        playbackRetryTimer = null;
    }

    function switchToPlayer(cameraName) {
        TVAppState.setCurrentCamera(cameraName);
        TVAppState.setMode("PLAYER");
        gridScreen.classList.add("hidden");
        playerScreen.classList.remove("hidden");
        PlayerUI.enter(TVAppState.getCameraLabel(cameraName));
    }

    function extractHlsUrl(openResponse, cameraName) {
        if (openResponse && openResponse.playback && openResponse.playback.hls_url) {
            return openResponse.playback.hls_url;
        }

        var camera = TVAppState.getCamera(cameraName);
        if (camera && camera.playback && camera.playback.main) {
            return camera.playback.main;
        }

        return null;
    }

    async function openAndPlayCamera(cameraName, options) {
        options = options || {};
        var token = ++openRequestToken;
        var shouldReopen = options.reopen !== false;

        clearTimeout(playbackRetryTimer);
        playbackRetryTimer = null;

        PlayerUI.hideError();
        PlayerUI.showLoading(true);
        PlayerUI.setStatus("Requesting stream...");

        try {
            var hlsUrl = null;

            if (shouldReopen) {
                var openResponse = await TVApi.openCamera(cameraName, "main");
                if (token !== openRequestToken) {
                    return;
                }

                TVAppState.applyBackendState(openResponse);

                if (openResponse.state_version !== undefined) {
                    TVAppState.applyBackendState({ state_version: openResponse.state_version });
                }

                if (openResponse.camera) {
                    TVAppState.setCameraRunning(openResponse.camera, false, "STARTING");
                }

                hlsUrl = extractHlsUrl(openResponse, cameraName);
            } else {
                hlsUrl = extractHlsUrl(null, cameraName);
            }

            if (!hlsUrl) {
                throw new Error("Backend did not provide playback.hls_url");
            }

            TVAppState.setCameraPlaybackUrl(cameraName, hlsUrl);
            PlayerUI.setStatus("Waiting for publisher...");
            await TVAppState.waitForCameraRunning(cameraName, TVAppState.getStartupGraceMs());

            if (token !== openRequestToken) {
                return;
            }

            PlayerUI.setStatus("Starting AVPlay...");
            await TVPlayer.play(hlsUrl);

            if (token !== openRequestToken) {
                return;
            }

            PlayerUI.showLoading(false);
            PlayerUI.showBuffering(false);
            PlayerUI.setStatus("LIVE");
            playbackRetryAttempt = 0;
        } catch (error) {
            if (token !== openRequestToken) {
                return;
            }

            console.error("openAndPlayCamera failed", error);
            PlayerUI.showLoading(false);
            PlayerUI.showBuffering(false);
            schedulePlaybackRetry(cameraName, error);
        }
    }

    function schedulePlaybackRetry(cameraName, error) {
        playbackRetryAttempt += 1;
        var delayMs = Math.min(15000, 1000 * Math.pow(2, playbackRetryAttempt - 1));
        var seconds = Math.round(delayMs / 1000);
        var message = "Playback failed: " + (error && error.message ? error.message : "unknown error") + ". Auto retry in " + seconds + "s.";

        PlayerUI.setStatus("ERROR");
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

        if (keyCode === KEY.RETURN) {
            switchToGrid();
            return;
        }

        if (keyCode === KEY.UP || keyCode === KEY.DOWN) {
            PlayerUI.toggleHud();
            return;
        }

        if (keyCode === KEY.PAUSE || keyCode === KEY.PLAY || keyCode === KEY.PLAY_PAUSE) {
            var state = TVPlayer.togglePause();
            PlayerUI.setStatus(state === "PAUSED" ? "PAUSED" : "LIVE");
        }
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

    async function runPollCycle() {
        if (pollInFlight) {
            scheduleNextPoll();
            return;
        }

        pollInFlight = true;

        try {
            var response = await TVApi.poll(TVAppState.getStateVersion(), TVAppState.getPollUrl());
            if (response.changed && response.payload) {
                TVAppState.applyBackendState(response.payload);
            } else if (response.state_version !== undefined) {
                TVAppState.applyBackendState({ state_version: response.state_version });
            }

            pollBackoffStep = 0;
        } catch (error) {
            pollBackoffStep = Math.min(pollBackoffStep + 1, 5);
            console.warn("Polling failed", error);
        } finally {
            pollInFlight = false;
            renderGrid();
            scheduleNextPoll();
        }
    }

    function registerRemoteKeys() {
        if (!global.tizen || !tizen.tvinputdevice) {
            return;
        }

        ["MediaPlayPause", "MediaPlay", "MediaPause", "Exit"].forEach(function (keyName) {
            try {
                tizen.tvinputdevice.registerKey(keyName);
            } catch (error) {
                console.warn("Key registration failed", keyName, error);
            }
        });
    }

    function exitApp() {
        clearTimeout(pollTimer);
        clearTimeout(playbackRetryTimer);
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

    async function bootstrap() {
        try {
            var bootstrapData = await TVApi.getBootstrapLite();
            TVAppState.applyBackendState(bootstrapData);
            updateBackendInfo();
            renderGrid();
            showToast("Connected");
            scheduleNextPoll();
        } catch (error) {
            console.error("Bootstrap failed", error);
            showToast("Bootstrap failed. Retrying...");
            pollBackoffStep = Math.min(pollBackoffStep + 1, 5);
            scheduleNextPoll();
        }
    }

    function bindLifecycle() {
        document.addEventListener("keydown", handleKeyDown);

        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                TVPlayer.stopAndClose();
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
            },
            onError: function (error) {
                var camera = TVAppState.getCurrentCamera();
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
        bindStateListeners();
        bindLifecycle();
        registerRemoteKeys();
        initPlayerCallbacks();
        renderGrid();
        updateBackendInfo();
        switchToGrid();
        bootstrap();
    }

    document.addEventListener("DOMContentLoaded", initialize);
})(window);
