/*global Promise */
(function (global) {
    "use strict";

    // Lightweight backend client for camera-bridge endpoints with timeout,
    // retry, and defensive response validation.

    var DEFAULT_TIMEOUT_MS = 8000;
    var MAX_RETRIES = 2;

    function isAbsoluteUrl(url) {
        return /^https?:\/\//i.test(String(url || ""));
    }

    function buildUrl(baseUrl, pathOrUrl) {
        if (!pathOrUrl) {
            return String(baseUrl || "").replace(/\/$/, "");
        }

        if (isAbsoluteUrl(pathOrUrl)) {
            return pathOrUrl;
        }

        var trimmedBase = String(baseUrl || "").replace(/\/$/, "");
        var trimmedPath = String(pathOrUrl).replace(/^\//, "");
        return trimmedBase + "/" + trimmedPath;
    }

    function validateBootstrapLite(payload) {
        if (!payload || typeof payload !== "object") {
            throw new Error("Invalid /tizen/bootstrap-lite payload: object expected");
        }

        if (!payload.poll_url) {
            throw new Error("Invalid /tizen/bootstrap-lite payload: missing poll_url");
        }

        if (payload.poll_interval_ms !== undefined && typeof payload.poll_interval_ms !== "number") {
            throw new Error("Invalid /tizen/bootstrap-lite payload: poll_interval_ms must be a number");
        }

        if (!Array.isArray(payload.cameras) && (!payload.cameras || typeof payload.cameras !== "object")) {
            throw new Error("Invalid /tizen/bootstrap-lite payload: cameras[]/object is required");
        }
    }

    function validatePoll(payload) {
        if (!payload || typeof payload !== "object") {
            throw new Error("Invalid /tizen/poll payload: object expected");
        }

        if (typeof payload.changed !== "boolean") {
            throw new Error("Invalid /tizen/poll payload: changed must be boolean");
        }
    }

    function validateOpen(payload) {
        if (!payload || typeof payload !== "object") {
            throw new Error("Invalid /tizen/open payload: object expected");
        }

        if (!payload.camera) {
            throw new Error("Invalid /tizen/open payload: camera is required");
        }

        // Some bridge variants return playback later via poll/bootstrap and keep
        // playback null in /tizen/open. Accept this shape and let the app
        // resolve URL via state fallbacks.
        if (payload.playback !== undefined && payload.playback !== null && typeof payload.playback !== "object") {
            throw new Error("Invalid /tizen/open payload: playback must be object or null");
        }
    }

    function requestJson(options) {
        var method = options.method || "GET";
        var body = options.body || null;
        var headers = options.headers || {};
        var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        var retries = Math.max(0, options.retries || 0);
        var attempt = 0;

        function doRequest() {
            return new Promise(function (resolve, reject) {
                var timeoutHandle = null;
                var controller = global.AbortController ? new global.AbortController() : null;
                var settled = false;

                function clearTimer() {
                    if (timeoutHandle) {
                        global.clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                }

                function resolveOnce(value) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimer();
                    resolve(value);
                }

                function rejectOnce(error) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimer();
                    reject(error);
                }

                timeoutHandle = global.setTimeout(function () {
                    if (controller) {
                        controller.abort();
                        return;
                    }

                    rejectOnce({
                        retriable: true,
                        message: "Request timeout after " + timeoutMs + "ms"
                    });
                }, timeoutMs);

                var fetchOptions = {
                    method: method,
                    headers: headers,
                    cache: "no-store"
                };

                if (controller) {
                    fetchOptions.signal = controller.signal;
                }

                if (body !== null) {
                    fetchOptions.body = JSON.stringify(body);
                }

                global.fetch(options.url, fetchOptions)
                    .then(function (response) {
                        if (settled) {
                            return null;
                        }

                        if (!response.ok) {
                            var retriable = response.status >= 500 || response.status === 429;
                            throw {
                                retriable: retriable,
                                status: response.status,
                                message: "HTTP " + response.status + " from " + options.url
                            };
                        }
                        return response.json();
                    })
                    .then(function (payload) {
                        if (payload === null && settled) {
                            return;
                        }
                        resolveOnce(payload);
                    })
                    .catch(function (error) {
                        if (settled) {
                            return;
                        }

                        var retriable = !!(error && error.retriable) ||
                            (error && (error.name === "AbortError" || error.name === "TypeError"));

                        if (attempt < retries && retriable) {
                            attempt += 1;
                            var backoffMs = Math.min(3000, 400 * Math.pow(2, attempt));
                            global.setTimeout(function () {
                                doRequest().then(resolve).catch(reject);
                            }, backoffMs);
                            return;
                        }

                        rejectOnce(error instanceof Error ? error : new Error(error.message || "Network request failed"));
                    });
            });
        }

        return doRequest();
    }

    function buildBridgeCandidates() {
        var seen = {};
        var list = [];
        var primary = global.TVAppState.getBridgeBaseUrl();
        var runtime = global.TVAppConfig || {};
        var configured = runtime.bridgeBaseUrlCandidates;

        function add(url) {
            var normalized = String(url || "").trim().replace(/\/$/, "");
            if (!normalized || seen[normalized]) {
                return;
            }
            seen[normalized] = true;
            list.push(normalized);
        }

        add(primary);

        if (Array.isArray(configured)) {
            configured.forEach(add);
        }

        return list;
    }

    function tryBootstrapFromCandidates(candidates, index, lastError) {
        if (index >= candidates.length) {
            return Promise.reject(lastError || new Error("No bridge URL candidates available"));
        }

        var candidate = candidates[index];
        var url = buildUrl(candidate, "/tizen/bootstrap-lite");

        return requestJson({
            url: url,
            retries: MAX_RETRIES
        }).then(function (payload) {
            validateBootstrapLite(payload);

            if (global.TVAppState.getBridgeBaseUrl() !== candidate) {
                global.TVAppState.setBridgeBaseUrl(candidate);
            }

            return payload;
        }, function (error) {
            return tryBootstrapFromCandidates(candidates, index + 1, error);
        });
    }

    var TVApi = {
        getBootstrapLite: function () {
            return tryBootstrapFromCandidates(buildBridgeCandidates(), 0, null);
        },

        poll: function (sinceVersion, pollUrl) {
            var resolvedPollUrl = buildUrl(global.TVAppState.getBridgeBaseUrl(), pollUrl || "/tizen/poll");
            var separator = resolvedPollUrl.indexOf("?") === -1 ? "?" : "&";
            var fullUrl = resolvedPollUrl + separator + "since=" + encodeURIComponent(String(sinceVersion || "0"));

            return requestJson({
                url: fullUrl,
                retries: 1
            }).then(function (payload) {
                validatePoll(payload);
                return payload;
            });
        },

        openCamera: function (cameraName) {
            var url = buildUrl(global.TVAppState.getBridgeBaseUrl(), "/tizen/open");
            return requestJson({
                url: url,
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: {
                    camera: cameraName
                },
                retries: MAX_RETRIES
            }).then(function (payload) {
                validateOpen(payload);
                return payload;
            });
        },

        getViewStatus: function () {
            var url = buildUrl(global.TVAppState.getBridgeBaseUrl(), "/view/status");
            return requestJson({
                url: url,
                retries: 1,
                timeoutMs: 8000
            });
        },

        getDiagStreams: function (options) {
            options = options || {};
            var params = [];

            if (options.startPublishers) {
                params.push("start_publishers=true");
            }

            if (options.probe) {
                params.push("probe=true");
            }

            if (typeof options.probeTimeoutSeconds === "number") {
                params.push("probe_timeout_seconds=" + encodeURIComponent(String(options.probeTimeoutSeconds)));
            }

            var path = "/diag/streams" + (params.length ? "?" + params.join("&") : "");
            var url = buildUrl(global.TVAppState.getBridgeBaseUrl(), path);

            return requestJson({
                url: url,
                retries: 1,
                timeoutMs: options.timeoutMs || 12000
            });
        }
    };

    global.TVApi = TVApi;
})(window);
