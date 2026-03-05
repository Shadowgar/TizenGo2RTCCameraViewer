(function (global) {
    "use strict";

    // GRID mode renderer and directional focus manager for the 2x2 tile layout.

    function formatTime(value) {
        if (!value) {
            return "Updated: --";
        }

        var date = new Date(value);
        if (isNaN(date.getTime())) {
            return "Updated: " + String(value);
        }

        return "Updated: " + date.toLocaleTimeString();
    }

    function normalizeStatus(status) {
        return String(status || "UNKNOWN").toUpperCase();
    }

    var container = null;
    var cameraOrder = [];
    var focusedIndex = 0;
    var thumbNonce = Date.now();
    var lastThumbNonceAt = 0;
    var THUMB_REFRESH_MS = 900;
    var THUMB_LOAD_TIMEOUT_MS = 4500;
    var refreshCursor = 0;

    function withNonce(url, nonce) {
        var value = String(url || "").trim();
        if (!value) {
            return "";
        }

        var separator = value.indexOf("?") === -1 ? "?" : "&";
        return value + separator + "tvapp_ts=" + encodeURIComponent(String(nonce));
    }

    function buildSnapshotFallback(cameraName) {
        var base = (global.TVAppState && global.TVAppState.getBridgeBaseUrl)
            ? String(global.TVAppState.getBridgeBaseUrl() || "").replace(/\/$/, "")
            : "";

        if (!base) {
            return "";
        }

        return base + "/snapshot/" + encodeURIComponent(String(cameraName || ""));
    }

    function createTile(cameraName, cameraLabel) {
        var tile = document.createElement("div");
        tile.className = "camera-tile";
        tile.setAttribute("data-camera", cameraName);

        tile.innerHTML = [
            '<div class="tile-preview"></div>',
            '<div class="tile-thumb-wrap"><img class="tile-thumb" alt=""/></div>',
            '<div class="tile-head">',
            '<span class="tile-name"></span>',
            '<span class="tile-live">LIVE</span>',
            "</div>",
            '<div class="tile-status"></div>',
            '<div class="tile-debug"></div>',
            '<div class="tile-updated"></div>'
        ].join("");

        tile.querySelector(".tile-name").textContent = cameraLabel;

        var thumb = tile.querySelector(".tile-thumb");
        var preview = tile.querySelector(".tile-preview");
        if (thumb) {
            thumb.addEventListener("load", function () {
                thumb.setAttribute("data-thumb-state", "ok");
                thumb.removeAttribute("data-thumb-started-at");
                if (preview && thumb.src) {
                    preview.style.backgroundImage = 'url("' + thumb.src.replace(/"/g, "%22") + '")';
                    preview.classList.add("ready");
                }
            });
            thumb.addEventListener("error", function () {
                thumb.setAttribute("data-thumb-state", "err");
                thumb.removeAttribute("data-thumb-started-at");
            });
        }

        return tile;
    }

    function setFocusedTile(index) {
        focusedIndex = Math.max(0, Math.min(index, cameraOrder.length - 1));
        var tiles = container.querySelectorAll(".camera-tile");
        for (var i = 0; i < tiles.length; i += 1) {
            if (i === focusedIndex) {
                tiles[i].classList.add("focused");
            } else {
                tiles[i].classList.remove("focused");
            }
        }
    }

    var GridUI = {
        init: function (containerElement, orderedCameras) {
            container = containerElement;
            cameraOrder = orderedCameras.slice();
            container.innerHTML = "";

            cameraOrder.forEach(function (cameraName) {
                var label = global.TVAppState.getCameraLabel(cameraName);
                container.appendChild(createTile(cameraName, label));
            });

            setFocusedTile(0);
        },

        render: function (camerasByName) {
            if (!container) {
                return;
            }

            var now = Date.now();
            var rotateTick = false;
            if (now - lastThumbNonceAt >= THUMB_REFRESH_MS) {
                thumbNonce = now;
                lastThumbNonceAt = now;
                rotateTick = true;
            }

            cameraOrder.forEach(function (cameraName) {
                var camera = camerasByName[cameraName] || {};
                var tile = container.querySelector('[data-camera="' + cameraName + '"]');
                if (!tile) {
                    return;
                }

                var status = normalizeStatus(camera.status);
                var running = !!camera.running;
                var thumb = tile.querySelector(".tile-thumb");
                var preview = tile.querySelector(".tile-preview");
                var thumbState = "none";

                tile.querySelector(".tile-name").textContent = camera.label || global.TVAppState.getCameraLabel(cameraName);
                tile.querySelector(".tile-status").textContent = status;
                tile.querySelector(".tile-debug").textContent = camera.debugInfo || "";
                tile.querySelector(".tile-updated").textContent = formatTime(camera.updatedAt || global.TVAppState.getStateUpdatedAt());

                if (thumb) {
                    var baseThumbUrl = camera.thumbnailUrl || buildSnapshotFallback(cameraName);
                    if (baseThumbUrl) {
                        var resolvedThumbUrl = withNonce(baseThumbUrl, thumbNonce);
                        var currentThumbState = thumb.getAttribute("data-thumb-state") || "none";
                        var startedAt = Number(thumb.getAttribute("data-thumb-started-at") || "0");
                        var isStuckLoading = currentThumbState === "loading" && startedAt > 0 && (now - startedAt) > THUMB_LOAD_TIMEOUT_MS;

                        if (isStuckLoading) {
                            currentThumbState = "timeout";
                            thumb.setAttribute("data-thumb-state", "timeout");
                        }

                        var shouldPrime = !thumb.getAttribute("data-src");
                        var shouldRetry = currentThumbState === "err" || currentThumbState === "timeout";
                        var shouldRotateRefresh = rotateTick && cameraOrder[refreshCursor] === cameraName;

                        if ((shouldPrime || shouldRetry || shouldRotateRefresh) && currentThumbState !== "loading") {
                            thumb.src = resolvedThumbUrl;
                            thumb.setAttribute("data-src", resolvedThumbUrl);
                            thumb.setAttribute("data-thumb-state", "loading");
                            thumb.setAttribute("data-thumb-started-at", String(now));
                        }
                        thumb.classList.remove("hidden");
                    } else {
                        thumb.removeAttribute("src");
                        thumb.removeAttribute("data-src");
                        thumb.setAttribute("data-thumb-state", "none");
                        thumb.removeAttribute("data-thumb-started-at");
                        if (preview) {
                            preview.style.backgroundImage = "";
                            preview.classList.remove("ready");
                        }
                    }

                    thumbState = thumb.getAttribute("data-thumb-state") || thumbState;
                }

                tile.querySelector(".tile-debug").textContent = (camera.debugInfo || "") + (camera.debugInfo ? " " : "") + "snap=" + thumbState;

                var liveBadge = tile.querySelector(".tile-live");
                liveBadge.classList.toggle("live", running);
                liveBadge.textContent = running ? "LIVE" : "IDLE";

                tile.classList.toggle("running", running);
            });

            if (rotateTick && cameraOrder.length > 0) {
                refreshCursor = (refreshCursor + 1) % cameraOrder.length;
            }

            setFocusedTile(focusedIndex);
        },

        moveFocus: function (direction) {
            var row = Math.floor(focusedIndex / 2);
            var col = focusedIndex % 2;

            if (direction === "LEFT") {
                col = Math.max(0, col - 1);
            } else if (direction === "RIGHT") {
                col = Math.min(1, col + 1);
            } else if (direction === "UP") {
                row = Math.max(0, row - 1);
            } else if (direction === "DOWN") {
                row = Math.min(1, row + 1);
            }

            setFocusedTile(row * 2 + col);
            global.TVAppState.setFocusIndex(focusedIndex);
            return focusedIndex;
        },

        setFocusIndex: function (index) {
            setFocusedTile(index);
        },

        getFocusedCameraName: function () {
            return cameraOrder[focusedIndex] || null;
        }
    };

    global.GridUI = GridUI;
})(window);
