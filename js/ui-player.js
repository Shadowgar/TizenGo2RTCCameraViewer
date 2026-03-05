(function (global) {
    "use strict";

    // PLAYER mode overlay/HUD presentation state (loading, buffering, errors).

    var hudElement;
    var cameraNameElement;
    var hudStatusElement;
    var hudClockElement;
    var loadingElement;
    var bufferingElement;
    var errorElement;
    var errorMessageElement;
    var retryButton;
    var backButton;

    var clockInterval = null;
    var hudAutoHideSeconds = 0;
    var hudAutoHideTimer = null;
    var errorActions = ["retry", "back"];
    var focusedErrorActionIndex = 0;

    function clearHudAutoHideTimer() {
        if (hudAutoHideTimer) {
            clearTimeout(hudAutoHideTimer);
            hudAutoHideTimer = null;
        }
    }

    function scheduleHudAutoHide() {
        clearHudAutoHideTimer();

        if (!hudElement || hudAutoHideSeconds <= 0) {
            return;
        }

        hudAutoHideTimer = setTimeout(function () {
            show(hudElement, false);
        }, hudAutoHideSeconds * 1000);
    }

    function show(element, shouldShow) {
        if (!element) {
            return;
        }
        element.classList.toggle("hidden", !shouldShow);
    }

    function renderClock() {
        if (!hudClockElement) {
            return;
        }
        hudClockElement.textContent = new Date().toLocaleTimeString();
    }

    function setErrorFocus(index) {
        focusedErrorActionIndex = Math.max(0, Math.min(index, errorActions.length - 1));
        retryButton.classList.toggle("focused", focusedErrorActionIndex === 0);
        backButton.classList.toggle("focused", focusedErrorActionIndex === 1);
    }

    var PlayerUI = {
        init: function (elements) {
            hudElement = elements.hud;
            cameraNameElement = elements.hudCameraName;
            hudStatusElement = elements.hudStatus;
            hudClockElement = elements.hudClock;
            loadingElement = elements.loading;
            bufferingElement = elements.buffering;
            errorElement = elements.error;
            errorMessageElement = elements.errorMessage;
            retryButton = elements.errorRetry;
            backButton = elements.errorBack;
        },

        enter: function (cameraLabel) {
            this.setCameraName(cameraLabel);
            this.setStatus("Opening stream…");
            this.showHud(true);
            this.showLoading(true);
            this.showBuffering(false);
            this.hideError();
            scheduleHudAutoHide();

            if (clockInterval) {
                clearInterval(clockInterval);
            }
            renderClock();
            clockInterval = setInterval(renderClock, 1000);
        },

        exit: function () {
            this.showLoading(false);
            this.showBuffering(false);
            this.hideError();
            clearHudAutoHideTimer();
            if (clockInterval) {
                clearInterval(clockInterval);
                clockInterval = null;
            }
        },

        showHud: function (visible) {
            show(hudElement, !!visible);
            if (visible) {
                scheduleHudAutoHide();
            } else {
                clearHudAutoHideTimer();
            }
        },

        toggleHud: function () {
            if (!hudElement) {
                return;
            }
            var shouldShow = hudElement.classList.contains("hidden");
            this.showHud(shouldShow);
        },

        setAutoHideSeconds: function (seconds) {
            hudAutoHideSeconds = Math.max(0, Number(seconds) || 0);
            if (!hudElement || hudElement.classList.contains("hidden")) {
                return;
            }

            scheduleHudAutoHide();
        },

        pingHudActivity: function () {
            if (!hudElement) {
                return;
            }
            show(hudElement, true);
            scheduleHudAutoHide();
        },

        setCameraName: function (name) {
            if (cameraNameElement) {
                cameraNameElement.textContent = name || "Camera";
            }
        },

        setStatus: function (statusText) {
            if (hudStatusElement) {
                hudStatusElement.textContent = statusText || "";
            }
        },

        showLoading: function (visible) {
            show(loadingElement, !!visible);
        },

        showBuffering: function (visible) {
            show(bufferingElement, !!visible);
        },

        showError: function (message) {
            if (errorMessageElement) {
                errorMessageElement.textContent = message || "Playback failed";
            }
            setErrorFocus(0);
            show(errorElement, true);
            clearHudAutoHideTimer();
        },

        hideError: function () {
            show(errorElement, false);
        },

        isErrorVisible: function () {
            return errorElement && !errorElement.classList.contains("hidden");
        },

        moveErrorActionFocus: function (direction) {
            if (!this.isErrorVisible()) {
                return;
            }

            if (direction === "LEFT") {
                setErrorFocus(focusedErrorActionIndex - 1);
            }

            if (direction === "RIGHT") {
                setErrorFocus(focusedErrorActionIndex + 1);
            }
        },

        getSelectedErrorAction: function () {
            return errorActions[focusedErrorActionIndex] || "retry";
        }
    };

    global.PlayerUI = PlayerUI;
})(window);
