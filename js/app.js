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
    var debugPanel;
    var debugContent;

    var pollTimer = null;
    var bootstrapRetryTimer = null;
    var pollBackoffStep = 0;
    var bootstrapBackoffStep = 0;
    var pollInFlight = false;
    var openRequestToken = 0;
    var lastBackPressAt = 0;
    var playbackRetryTimer = null;
    var playbackRetryAttempt = 0;
    var resizeRectTimer = null;
    var debugRefreshTimer = null;
    var debugVisible = false;
    var playerHasActiveStream = false;
    var pollPlaybackRecoverInFlight = false;

    var MAX_AUTO_PLAYBACK_RETRIES = 4;

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

    function setDebugVisible(visible) {
        debugVisible = !!visible;

        if (!debugPanel) {
            return;
        }

        debugPanel.classList.toggle("hidden", !debugVisible);

        if (!debugVisible) {
            clearInterval(debugRefreshTimer);
            debugRefreshTimer = null;
            return;
        }

        refreshDebugPanel();
        clearInterval(debugRefreshTimer);
        debugRefreshTimer = setInterval(refreshDebugPanel, 15000);
    }

    function refreshDebugPanel() {
        if (!debugVisible || !debugContent) {
            return;
        }

        debugContent.textContent = "Loading /diag/streams...";

        TVApi.getDiagStreams({
            startPublishers: true,
            probe: true,
            probeTimeoutSeconds: 25
        }).then(function (payload) {
            if (!debugVisible || !debugContent) {
                return;
            }

            debugContent.textContent = JSON.stringify(payload, null, 2);
        }, function (error) {
            if (!debugVisible || !debugContent) {
                return;
            }

            debugContent.textContent = "diag/streams failed: " + (error && error.message ? error.message : "unknown error");
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

    function switchToGrid() {
        TVAppState.setMode("GRID");
        playerScreen.classList.add("hidden");
        gridScreen.classList.remove("hidden");
        playerHasActiveStream = false;

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
                    var i;
                    for (i = 0; i < lines.length; i += 1) {
                        var line = String(lines[i] || "").trim();
                        if (!line || line.charAt(0) === "#") {
                            continue;
                        }

                        resolve(resolveRelativeUrl(url, line));
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

        var openPromise = shouldReopen ? TVApi.openCamera(cameraName) : Promise.resolve(null);

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
                    return TVApi.openCamera(cameraName).then(function (retryResponse) {
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
                return resolvePlayableHlsUrl(hlsUrl).then(function (resolvedHlsUrl) {
                    ensureToken();
                    PlayerUI.setStatus("Starting AVPlay...");
                    return TVPlayer.play(resolvedHlsUrl || hlsUrl);
                });
            })
            .then(function () {
                ensureToken();

                PlayerUI.showLoading(false);
                PlayerUI.showBuffering(false);
                PlayerUI.setStatus("LIVE");
                playerHasActiveStream = true;
                playbackRetryAttempt = 0;
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
                schedulePlaybackRetry(cameraName, error);
            });
    }

    function schedulePlaybackRetry(cameraName, error) {
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

        TVApi.poll(TVAppState.getStateVersion(), TVAppState.getPollUrl())
            .then(function (response) {
                if (response.changed) {
                    TVAppState.applyBackendState(response);
                } else if (response.state_version !== undefined) {
                    TVAppState.applyBackendState({ state_version: response.state_version });
                }

                pollBackoffStep = 0;
            }, function (error) {
                if (error && error.status === 422) {
                    console.warn("Poll state out of sync, re-running bootstrap");
                    triggeredResync = true;
                    bootstrapBackoffStep = 0;
                    bootstrap();
                    return;
                }

                pollBackoffStep = Math.min(pollBackoffStep + 1, 5);
                console.warn("Polling failed", error);
            })
            .then(function () {
                pollInFlight = false;
                if (triggeredResync) {
                    return;
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

        ["MediaPlayPause", "MediaPlay", "MediaPause", "Exit", "ColorF2Yellow"].forEach(function (keyName) {
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
        clearTimeout(resizeRectTimer);
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

        TVApi.getBootstrapLite()
            .then(function (bootstrapData) {
                TVAppState.applyBackendState(bootstrapData);
                bootstrapBackoffStep = 0;
                updateBackendInfo();
                renderGrid();
                showToast("Connected");
                scheduleNextPoll();
            }, function (error) {
                console.error("Bootstrap failed", error);
                bootstrapBackoffStep = Math.min(bootstrapBackoffStep + 1, 5);
                TVAppState.setAllCameraStatus("BACKEND_UNREACHABLE", false);
                renderGrid();
                showToast("Bridge unavailable. Retrying bootstrap...");
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
        debugPanel = byId("debug-panel");
        debugContent = byId("debug-content");

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
            onError: function (error) {
                var camera = TVAppState.getCurrentCamera();
                playerHasActiveStream = false;
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
        setDebugVisible(false);
        bootstrap();
    }

    document.addEventListener("DOMContentLoaded", initialize);
})(window);
