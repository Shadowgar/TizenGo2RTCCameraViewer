/**
 * Player module for TizenGo2RTCCameraViewer
 * Handles HLS stream initialization and error handling.
 */

window.initializePlayer = function(videoElement) {
    var streamId = videoElement.dataset.stream;
    if (!streamId || !window.cameraSources || !window.cameraSources[streamId]) {
        console.error("Invalid stream ID:", streamId);
        return;
    }

    var hlsUrl = window.cameraSources[streamId].hls;
    var hlsInstance = null;

    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        videoElement.src = hlsUrl;
    } else if (window.Hls && window.Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(hlsUrl);
        hlsInstance.attachMedia(videoElement);
    } else {
        videoElement.src = hlsUrl;
    }

    videoElement.onerror = function(e) {
        console.warn("Stream error for", streamId, e);
    };

    if (!window.activeVideos) window.activeVideos = {};
    window.activeVideos[streamId] = videoElement;

    var playPromise = videoElement.play();
    if (playPromise !== undefined) {
        playPromise.catch(function(error) {
            console.error("Error playing video:", error);
            if (error.name === 'NotAllowedError' && typeof window.showPlayButton === 'function') {
                window.showPlayButton(videoElement);
            }
        });
    }
};
