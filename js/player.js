(function (global) {
    "use strict";

    // Samsung AVPlay wrapper that normalizes lifecycle operations and events.

    var avplay = null;
    var callbacks = {};

    function getAvPlay() {
        if (avplay) {
            return avplay;
        }

        if (global.webapis && global.webapis.avplay) {
            avplay = global.webapis.avplay;
            return avplay;
        }

        throw new Error("webapis.avplay is unavailable. Ensure $WEBAPIS/webapis/webapis.js is loaded on Samsung Tizen TV.");
    }

    function safeCall(methodName) {
        var player = getAvPlay();
        if (!player || typeof player[methodName] !== "function") {
            return;
        }

        try {
            player[methodName]();
        } catch (error) {
            console.warn("AVPlay", methodName, "failed", error);
        }
    }

    function applyDisplayRect() {
        var player = getAvPlay();
        var windowWidth = Math.floor(
            global.innerWidth ||
            (global.document && global.document.documentElement && global.document.documentElement.clientWidth) ||
            0
        );
        var windowHeight = Math.floor(
            global.innerHeight ||
            (global.document && global.document.documentElement && global.document.documentElement.clientHeight) ||
            0
        );
        var screenWidth = Math.floor((global.screen && global.screen.availWidth) || 0);
        var screenHeight = Math.floor((global.screen && global.screen.availHeight) || 0);

        var width = Math.max(
            1,
            Math.floor(
                windowWidth ||
                screenWidth ||
                1920
            )
        );
        var height = Math.max(
            1,
            Math.floor(
                windowHeight ||
                screenHeight ||
                1080
            )
        );

        // Normalize to landscape coordinates expected by AVPlay.
        if (height > width) {
            var tmp = width;
            width = height;
            height = tmp;
        }

        if (width < 1280 || height < 720) {
            width = 1920;
            height = 1080;
        }

        player.setDisplayRect(0, 0, width, height);
    }

    function installListener() {
        var player = getAvPlay();

        player.setListener({
            onbufferingstart: function () {
                if (callbacks.onBufferingStart) {
                    callbacks.onBufferingStart();
                }
            },
            onbufferingprogress: function (percent) {
                if (callbacks.onBufferingProgress) {
                    callbacks.onBufferingProgress(percent);
                }
            },
            onbufferingcomplete: function () {
                if (callbacks.onBufferingComplete) {
                    callbacks.onBufferingComplete();
                }
            },
            onstreamcompleted: function () {
                if (callbacks.onStreamCompleted) {
                    callbacks.onStreamCompleted();
                }
            },
            oncurrentplaytime: function (currentTime) {
                if (callbacks.onCurrentPlayTime) {
                    callbacks.onCurrentPlayTime(currentTime);
                }
            },
            onerror: function (error) {
                if (callbacks.onError) {
                    callbacks.onError(new Error("AVPlay error code: " + error));
                }
            },
            onevent: function (eventType, eventData) {
                if (callbacks.onEvent) {
                    callbacks.onEvent(eventType, eventData);
                }
            }
        });
    }

    function stopAndCloseInternal() {
        try {
            var player = getAvPlay();
            var state = player.getState ? player.getState() : "NONE";

            if (state === "PLAYING" || state === "PAUSED" || state === "READY") {
                safeCall("stop");
            }

            if (state !== "NONE") {
                safeCall("close");
            }
        } catch (error) {
            console.warn("AVPlay stop/close failed", error);
        }
    }

    var TVPlayer = {
        init: function (listenerCallbacks) {
            callbacks = listenerCallbacks || {};
            getAvPlay();
            installListener();
        },

        play: function (hlsUrl) {
            var player = getAvPlay();
            var url = String(hlsUrl || "").trim();
            if (!url) {
                return Promise.reject(new Error("HLS URL is empty"));
            }

            stopAndCloseInternal();
            installListener();

            return new Promise(function (resolve, reject) {
                try {
                    player.open(url);
                    applyDisplayRect();

                    try {
                        player.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");
                    } catch (displayMethodError) {
                        console.warn("Unable to set display method", displayMethodError);
                    }

                    try {
                        player.setStreamingProperty("ADAPTIVE_INFO", "STARTBITRATE=HIGHEST");
                    } catch (streamingPropertyError) {
                        console.warn("Unable to set ADAPTIVE_INFO", streamingPropertyError);
                    }

                    player.prepareAsync(function () {
                        try {
                            player.play();

                            // Some Tizen models need a second rect/method apply after play() to
                            // bring the AVPlay plane above an initially black compositor state.
                            try {
                                applyDisplayRect();
                                player.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");
                            } catch (postPlayDisplayError) {
                                console.warn("Unable to apply post-play display settings", postPlayDisplayError);
                            }

                            resolve();
                        } catch (playError) {
                            reject(playError);
                        }
                    }, function (prepareError) {
                        reject(new Error("AVPlay prepareAsync failed: " + prepareError));
                    });
                } catch (error) {
                    reject(error);
                }
            });
        },

        togglePause: function () {
            var player = getAvPlay();
            var currentState = player.getState ? player.getState() : "NONE";

            try {
                if (currentState === "PLAYING") {
                    player.pause();
                    return "PAUSED";
                }

                if (currentState === "PAUSED") {
                    player.play();
                    return "PLAYING";
                }
            } catch (error) {
                console.warn("togglePause failed", error);
            }

            return currentState;
        },

        refreshDisplayRect: function () {
            try {
                var player = getAvPlay();
                var currentState = player.getState ? player.getState() : "NONE";
                if (currentState === "NONE") {
                    return;
                }

                applyDisplayRect();
            } catch (error) {
                console.warn("refreshDisplayRect failed", error);
            }
        },

        stopAndClose: function () {
            stopAndCloseInternal();
        },

        destroy: function () {
            stopAndCloseInternal();
            callbacks = {};
        }
    };

    global.TVPlayer = TVPlayer;
})(window);
