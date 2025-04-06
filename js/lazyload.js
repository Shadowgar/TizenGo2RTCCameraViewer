/**
 * Lazy loading module for TizenGo2RTCCameraViewer
 * Loads camera streams only when visible.
 */

window.setupLazyLoading = function() {
    if (!('IntersectionObserver' in window)) {
        console.log("Intersection Observer not supported, loading all cameras");
        var videos = document.querySelectorAll('.camera-feed');
        for (var i = 0; i < videos.length; i++) {
            window.initializePlayer(videos[i]);
        }
        return;
    }

    var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            var videoElement = entry.target.querySelector('.camera-feed');
            var streamId = videoElement.dataset.stream;

            if (entry.isIntersecting) {
                console.log("Camera visible: " + streamId);
                if (!window.activeVideos[streamId]) {
                    if (window.requestIdleCallback) {
                        requestIdleCallback(function() {
                            window.initializePlayer(videoElement);
                        }, { timeout: 1000 });
                    } else {
                        setTimeout(function() {
                            window.initializePlayer(videoElement);
                        }, 10);
                    }
                } else if (videoElement.paused) {
                    videoElement.play().catch(console.error);
                }
            } else {
                console.log("Camera not visible: " + streamId);
                if (window.activeVideos[streamId] && window.currentMode !== 'single') {
                    setTimeout(function() {
                        if (!entry.isIntersecting) {
                            window.activeVideos[streamId].pause();
                        }
                    }, 1500);
                }
            }
        });
    }, {
        root: null,
        rootMargin: '25px',
        threshold: 0.1
    });

    var containers = document.querySelectorAll('.camera-container');
    containers.forEach(function(container) {
        observer.observe(container);
    });
};
