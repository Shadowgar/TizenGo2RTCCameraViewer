/**
 * Main app bootstrap for TizenGo2RTCCameraViewer
 */

window.currentMode = 'grid';
window.currentSingleCamera = null;
window.activeVideos = {};
window.selectedCameraIndex = 0;
window.cameraContainers = [];
window.reconnectAttempts = {};
window.maxReconnectAttempts = 5;
window.networkQuality = 'high';

window.onload = function() {
    console.log("Application starting...");

    window.cameraContainers = document.querySelectorAll('.camera-container');
    window.updateSelectedCamera(0);

    for (var k = 0; k < window.cameraContainers.length; k++) {
        window.cameraContainers[k].setAttribute('tabindex', '0');
    }

    var params = window.location.search.substring(1).split('&');
    var mode = null;
    var camera = null;

    for (var i = 0; i < params.length; i++) {
        var pair = params[i].split('=');
        if (pair[0] === 'mode') mode = pair[1];
        else if (pair[0] === 'camera') camera = pair[1];
    }

    window.setupLazyLoading();
    window.setupAmbientMode();
    window.setupRemoteControls();

    window.addEventListener('resize', window.optimizeCameraPlayback || function(){});
    setInterval(window.optimizeCameraPlayback || function(){}, 5000);
    setInterval(window.checkNetworkQuality || function(){}, 10000);
    setInterval(window.monitorStreamHealth || function(){}, 10000);

    if (mode === 'single' && camera && window.cameraSources[camera]) {
        window.switchToSingleView(camera);
    }
};
