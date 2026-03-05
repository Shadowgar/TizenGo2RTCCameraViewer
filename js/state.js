(function (global) {
    "use strict";

    // Central app state store for camera metadata, backend sync versions,
    // configuration, and mode/focus transitions.

    var CAMERA_ORDER = ["driveway", "backyard", "frontyard", "backdeck"];
    var CAMERA_LABELS = {
        driveway: "Driveway",
        backyard: "Backyard",
        frontyard: "Frontyard",
        backdeck: "Backdeck"
    };

    var STORAGE_KEYS = {
        bridgeBaseUrl: "TVAPP_BRIDGE_URL",
        mediamtxBaseUrl: "TVAPP_MEDIAMTX_URL"
    };

    var listeners = [];
    var runtimeConfig = global.TVAppConfig || {};
    var storedBridgeBaseUrl = safeGetStorage(STORAGE_KEYS.bridgeBaseUrl);
    var storedMediaMtxBaseUrl = safeGetStorage(STORAGE_KEYS.mediamtxBaseUrl);
    var useForcedRuntimeConfig = runtimeConfig.forceRuntimeConfig === true;

    var resolvedBridgeBaseUrl = useForcedRuntimeConfig
        ? (runtimeConfig.bridgeBaseUrl || storedBridgeBaseUrl || "http://openclaw.local:8090")
        : (storedBridgeBaseUrl || runtimeConfig.bridgeBaseUrl || "http://openclaw.local:8090");

    var resolvedMediaMtxBaseUrl = useForcedRuntimeConfig
        ? (runtimeConfig.mediamtxBaseUrl || storedMediaMtxBaseUrl || "http://openclaw.local:8889")
        : (storedMediaMtxBaseUrl || runtimeConfig.mediamtxBaseUrl || "http://openclaw.local:8889");

    var state = {
        mode: "GRID",
        currentCamera: null,
        focusIndex: 0,
        stateVersion: "0",
        stateUpdatedAt: null,
        pollUrl: "/tizen/poll",
        pollIntervalMs: 2500,
        startupGraceMs: 1500,
        bridgeBaseUrl: resolvedBridgeBaseUrl,
        mediamtxBaseUrl: resolvedMediaMtxBaseUrl,
        cameras: {}
    };

    if (useForcedRuntimeConfig) {
        safeSetStorage(STORAGE_KEYS.bridgeBaseUrl, resolvedBridgeBaseUrl);
        safeSetStorage(STORAGE_KEYS.mediamtxBaseUrl, resolvedMediaMtxBaseUrl);
    }

    initializeDefaultCameras();

    function safeGetStorage(key) {
        try {
            return global.localStorage ? global.localStorage.getItem(key) : null;
        } catch (error) {
            console.warn("Unable to read localStorage key:", key, error);
            return null;
        }
    }

    function safeSetStorage(key, value) {
        try {
            if (global.localStorage) {
                global.localStorage.setItem(key, value);
            }
        } catch (error) {
            console.warn("Unable to write localStorage key:", key, error);
        }
    }

    function normalizeCameraName(name) {
        return String(name || "").trim().toLowerCase();
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function initializeDefaultCameras() {
        CAMERA_ORDER.forEach(function (name) {
            state.cameras[name] = {
                name: name,
                label: CAMERA_LABELS[name] || name,
                status: "UNKNOWN",
                running: false,
                updatedAt: null,
                thumbnailUrl: null,
                debugInfo: "",
                playback: {
                    main: null,
                    live: null
                }
            };
        });
    }

    function emit(type, payload) {
        listeners.forEach(function (listener) {
            try {
                listener(type, payload);
            } catch (error) {
                console.error("State listener failed", error);
            }
        });
    }

    function mergeCameraEntry(entry) {
        var name = normalizeCameraName(entry && (entry.name || entry.camera));
        if (!name) {
            return;
        }

        if (!state.cameras[name]) {
            state.cameras[name] = {
                name: name,
                label: (entry && (entry.label || entry.display_name)) || name,
                status: "UNKNOWN",
                running: false,
                updatedAt: null,
                thumbnailUrl: null,
                debugInfo: "",
                playback: {
                    main: null,
                    live: null
                }
            };
        }

        var target = state.cameras[name];
        target.label = entry.label || entry.display_name || target.label || name;

        var statusValue = entry.status || entry.state || target.status || "UNKNOWN";
        if (!entry.status && !entry.state && typeof entry.ready === "boolean") {
            statusValue = entry.ready ? "READY" : "STOPPED";
        } else if (!entry.status && !entry.state && entry.preferred_url && target.status === "UNKNOWN") {
            statusValue = "READY";
        }
        target.status = String(statusValue).toUpperCase();

        if (typeof entry.running === "boolean") {
            target.running = entry.running;
        } else if (typeof entry.ready === "boolean") {
            target.running = entry.ready;
        } else {
            target.running = /READY|RUNNING|LIVE|PLAYING/i.test(target.status);
        }

        target.updatedAt = entry.updated_at || entry.updatedAt || target.updatedAt || nowIso();
        target.thumbnailUrl = entry.thumbnail_url || entry.thumbnailUrl || target.thumbnailUrl;
        target.debugInfo = entry.debug_info || entry.debugInfo || target.debugInfo || "";

        if (entry.playback && typeof entry.playback === "object") {
            var mainPlayback = entry.playback.main || entry.playback;
            target.playback.main = mainPlayback && mainPlayback.hls_url ? mainPlayback.hls_url : target.playback.main;
            target.playback.live = (entry.playback.live && entry.playback.live.hls_url) ? entry.playback.live.hls_url : target.playback.live;
        }

        if (entry.hls_url) {
            target.playback.main = entry.hls_url;
        }

        if (entry.preferred_url) {
            target.playback.main = entry.preferred_url;
        }

        if (entry.url) {
            target.playback.main = entry.url;
        }
    }

    function ingestCameras(cameras) {
        if (!cameras) {
            return;
        }

        if (Array.isArray(cameras)) {
            cameras.forEach(mergeCameraEntry);
            return;
        }

        if (typeof cameras === "object") {
            Object.keys(cameras).forEach(function (key) {
                var cameraEntry = cameras[key] || {};
                if (!cameraEntry.name) {
                    cameraEntry.name = key;
                }
                mergeCameraEntry(cameraEntry);
            });
        }
    }

    var TVAppState = {
        subscribe: function (listener) {
            listeners.push(listener);
            return function unsubscribe() {
                listeners = listeners.filter(function (item) {
                    return item !== listener;
                });
            };
        },

        getCameraOrder: function () {
            return CAMERA_ORDER.slice();
        },

        getCameras: function () {
            return state.cameras;
        },

        getCamera: function (name) {
            return state.cameras[normalizeCameraName(name)] || null;
        },

        getCameraLabel: function (name) {
            var camera = state.cameras[normalizeCameraName(name)];
            return camera ? camera.label : String(name || "");
        },

        getMode: function () {
            return state.mode;
        },

        setMode: function (mode) {
            state.mode = mode;
            emit("mode", mode);
        },

        getCurrentCamera: function () {
            return state.currentCamera;
        },

        setCurrentCamera: function (name) {
            state.currentCamera = normalizeCameraName(name);
            emit("currentCamera", state.currentCamera);
        },

        getFocusIndex: function () {
            return state.focusIndex;
        },

        setFocusIndex: function (index) {
            var max = this.getCameraOrder().length - 1;
            state.focusIndex = Math.max(0, Math.min(index, max));
            emit("focusIndex", state.focusIndex);
        },

        getStateVersion: function () {
            return state.stateVersion;
        },

        getStateUpdatedAt: function () {
            return state.stateUpdatedAt;
        },

        getPollUrl: function () {
            return state.pollUrl;
        },

        getPollIntervalMs: function () {
            return state.pollIntervalMs;
        },

        getStartupGraceMs: function () {
            return state.startupGraceMs;
        },

        setBridgeBaseUrl: function (url) {
            state.bridgeBaseUrl = String(url || "").trim();
            safeSetStorage(STORAGE_KEYS.bridgeBaseUrl, state.bridgeBaseUrl);
            emit("config", { bridgeBaseUrl: state.bridgeBaseUrl, mediamtxBaseUrl: state.mediamtxBaseUrl });
        },

        setMediaMtxBaseUrl: function (url) {
            state.mediamtxBaseUrl = String(url || "").trim();
            safeSetStorage(STORAGE_KEYS.mediamtxBaseUrl, state.mediamtxBaseUrl);
            emit("config", { bridgeBaseUrl: state.bridgeBaseUrl, mediamtxBaseUrl: state.mediamtxBaseUrl });
        },

        getBridgeBaseUrl: function () {
            return state.bridgeBaseUrl;
        },

        getMediaMtxBaseUrl: function () {
            return state.mediamtxBaseUrl;
        },

        applyBackendState: function (payload) {
            if (!payload || typeof payload !== "object") {
                return;
            }

            if (payload.state_version !== undefined && payload.state_version !== null) {
                state.stateVersion = String(payload.state_version);
            }

            if (payload.state_updated_at) {
                state.stateUpdatedAt = payload.state_updated_at;
            }

            if (payload.poll_url) {
                state.pollUrl = payload.poll_url;
            }

            if (typeof payload.poll_interval_ms === "number" && payload.poll_interval_ms > 0) {
                state.pollIntervalMs = payload.poll_interval_ms;
            }

            if (typeof payload.startup_grace_ms === "number" && payload.startup_grace_ms >= 0) {
                state.startupGraceMs = payload.startup_grace_ms;
            }

            ingestCameras(payload.cameras);
            emit("state", payload);
        },

        setCameraRunning: function (name, isRunning, status) {
            var key = normalizeCameraName(name);
            if (!state.cameras[key]) {
                mergeCameraEntry({ name: key });
            }
            state.cameras[key].running = !!isRunning;
            if (status) {
                state.cameras[key].status = String(status).toUpperCase();
            }
            state.cameras[key].updatedAt = nowIso();
            emit("camera", state.cameras[key]);
        },

        setCameraPlaybackUrl: function (name, hlsUrl) {
            var key = normalizeCameraName(name);
            if (!state.cameras[key]) {
                mergeCameraEntry({ name: key });
            }
            state.cameras[key].playback.main = hlsUrl || state.cameras[key].playback.main;
            emit("camera", state.cameras[key]);
        },

        setCameraDebugInfo: function (name, text) {
            var key = normalizeCameraName(name);
            if (!state.cameras[key]) {
                mergeCameraEntry({ name: key });
            }
            state.cameras[key].debugInfo = String(text || "");
            state.cameras[key].updatedAt = nowIso();
            emit("camera", state.cameras[key]);
        },

        setAllCameraDebugInfo: function (text) {
            var value = String(text || "");
            Object.keys(state.cameras).forEach(function (name) {
                state.cameras[name].debugInfo = value;
                state.cameras[name].updatedAt = nowIso();
            });

            emit("state", {
                cameras: state.cameras,
                state_updated_at: state.stateUpdatedAt
            });
        },

        setAllCameraStatus: function (status, isRunning) {
            var normalizedStatus = String(status || "UNKNOWN").toUpperCase();
            var running = !!isRunning;

            Object.keys(state.cameras).forEach(function (name) {
                state.cameras[name].status = normalizedStatus;
                state.cameras[name].running = running;
                state.cameras[name].updatedAt = nowIso();
            });

            emit("state", {
                cameras: state.cameras,
                state_updated_at: state.stateUpdatedAt
            });
        },

        isCameraRunning: function (name) {
            var camera = this.getCamera(name);
            return !!(camera && camera.running);
        },

        waitForCameraRunning: function (name, timeoutMs) {
            var self = this;
            var startedAt = Date.now();
            var maxWait = Math.max(0, Number(timeoutMs || 0));

            return new Promise(function (resolve) {
                if (self.isCameraRunning(name)) {
                    resolve(true);
                    return;
                }

                if (maxWait === 0) {
                    resolve(false);
                    return;
                }

                var intervalId = global.setInterval(function () {
                    var elapsed = Date.now() - startedAt;
                    if (self.isCameraRunning(name)) {
                        global.clearInterval(intervalId);
                        resolve(true);
                        return;
                    }

                    if (elapsed >= maxWait) {
                        global.clearInterval(intervalId);
                        resolve(false);
                    }
                }, 200);
            });
        }
    };

    global.TVAppState = TVAppState;
})(window);
