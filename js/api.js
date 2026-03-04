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

        if (!payload.playback || typeof payload.playback !== "object") {
            throw new Error("Invalid /tizen/open payload: playback object is required");
        }

        if (!payload.playback.hls_url) {
            throw new Error("Invalid /tizen/open payload: playback.hls_url is required");
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
                var controller = global.AbortController ? new AbortController() : null;

                if (controller) {
                    timeoutHandle = global.setTimeout(function () {
                        controller.abort();
                    }, timeoutMs);
                }

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
                        if (timeoutHandle) {
                            global.clearTimeout(timeoutHandle);
                        }

                        if (!response.ok) {
                            var retriable = response.status >= 500 || response.status === 429;
                            throw {
                                retriable: retriable,
                                message: "HTTP " + response.status + " from " + options.url
                            };
                        }
                        return response.json();
                    })
                    .then(resolve)
                    .catch(function (error) {
                        if (timeoutHandle) {
                            global.clearTimeout(timeoutHandle);
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

                        reject(error instanceof Error ? error : new Error(error.message || "Network request failed"));
                    });
            });
        }

        return doRequest();
    }

    var TVApi = {
        getBootstrapLite: function () {
            var url = buildUrl(global.TVAppState.getBridgeBaseUrl(), "/tizen/bootstrap-lite");
            return requestJson({
                url: url,
                retries: MAX_RETRIES
            }).then(function (payload) {
                validateBootstrapLite(payload);
                return payload;
            });
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

        openCamera: function (cameraName, mode) {
            var url = buildUrl(global.TVAppState.getBridgeBaseUrl(), "/tizen/open");
            return requestJson({
                url: url,
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: {
                    camera: cameraName,
                    mode: mode || "main"
                },
                retries: MAX_RETRIES
            }).then(function (payload) {
                validateOpen(payload);
                return payload;
            });
        }
    };

    global.TVApi = TVApi;
})(window);
