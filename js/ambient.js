/**
 * Ambient mode module for TizenGo2RTCCameraViewer
 * Handles Samsung TV ambient mode integration.
 */

window.setupAmbientMode = function() {
    try {
        if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol && typeof tizen.tvaudiocontrol.getScreenState === 'function') {
            document.addEventListener('visibilitychange', function() {
                if (document.hidden) {
                    try {
                        if (tizen.tvaudiocontrol.getScreenState() !== 'SCREEN_STATE_NORMAL') {
                            window.enterAmbientMode();
                        }
                    } catch (e) {
                        console.error("Error checking screen state:", e);
                    }
                } else {
                    window.exitAmbientMode();
                }
            });

            try {
                if (tizen.tvaudiocontrol.getScreenState() !== 'SCREEN_STATE_NORMAL') {
                    window.enterAmbientMode();
                }
            } catch (e) {
                console.error("Error checking screen state:", e);
            }
        } else {
            console.log("Ambient mode API not available or unsupported");
        }
    } catch (e) {
        console.error("Error setting up ambient mode:", e);
    }
};

window.enterAmbientMode = function() {
    console.log("Entering ambient mode");
    document.body.classList.add('ambient-mode');
    var ambientContainer = document.getElementById('ambient-container');
    if (!ambientContainer) {
        ambientContainer = document.createElement('div');
        ambientContainer.id = 'ambient-container';
        var ambientVideo = document.createElement('video');
        ambientVideo.id = 'ambient-feed';
        ambientVideo.className = 'camera-feed';
        ambientVideo.dataset.stream = 'frontyard_stream';
        ambientContainer.appendChild(ambientVideo);
        document.body.appendChild(ambientContainer);
        window.initializePlayer(ambientVideo);
    }
    document.getElementById('main').style.display = 'none';
    ambientContainer.style.display = 'block';
    document.body.style.filter = 'brightness(0.7) contrast(0.9)';
};

window.exitAmbientMode = function() {
    console.log("Exiting ambient mode");
    document.body.classList.remove('ambient-mode');
    document.body.style.filter = '';
    document.getElementById('main').style.display = 'block';
    var ambientContainer = document.getElementById('ambient-container');
    if (ambientContainer) ambientContainer.style.display = 'none';
};
