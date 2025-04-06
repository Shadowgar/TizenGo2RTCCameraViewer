/**
 * UI helper module for TizenGo2RTCCameraViewer
 * Handles loading indicators, stream health, and play button.
 */

window.showLoadingIndicator = function(streamId) {
    var loadingElement;
    if (streamId === 'main-feed') {
        loadingElement = document.getElementById('main-loading');
    } else {
        var videoElement = document.querySelector('[data-stream="' + streamId + '"]');
        if (videoElement) {
            var containerId = videoElement.id.replace('-feed', '-loading');
            loadingElement = document.getElementById(containerId);
        }
    }
    if (loadingElement) loadingElement.style.display = 'block';
};

window.hideLoadingIndicator = function(streamId) {
    var loadingElement;
    if (streamId === 'main-feed') {
        loadingElement = document.getElementById('main-loading');
    } else {
        var videoElement = document.querySelector('[data-stream="' + streamId + '"]');
        if (videoElement) {
            var containerId = videoElement.id.replace('-feed', '-loading');
            loadingElement = document.getElementById(containerId);
        }
    }
    if (loadingElement) loadingElement.style.display = 'none';
};

window.updateStreamHealth = function(cameraIndex, status) {
    var container = window.cameraContainers ? window.cameraContainers[cameraIndex] : null;
    if (!container) return;

    var healthIndicator = container.querySelector('.stream-health-indicator');
    if (!healthIndicator) {
        healthIndicator = document.createElement('div');
        healthIndicator.className = 'stream-health-indicator';
        container.appendChild(healthIndicator);
    }

    healthIndicator.classList.remove('health-good', 'health-poor', 'health-error');

    switch(status) {
        case 'good':
            healthIndicator.classList.add('health-good');
            healthIndicator.textContent = 'Good';
            break;
        case 'poor':
            healthIndicator.classList.add('health-poor');
            healthIndicator.textContent = 'Poor';
            break;
        case 'error':
            healthIndicator.classList.add('health-error');
            healthIndicator.textContent = 'Error';
            break;
        default:
            healthIndicator.classList.add('health-good');
            healthIndicator.textContent = 'Good';
    }
};

window.showPlayButton = function(videoElement) {
    var container = videoElement.closest('.camera-container');
    if (!container) return;

    if (container.querySelector('.play-button')) return;

    var playButton = document.createElement('button');
    playButton.className = 'play-button';
    playButton.innerHTML = '▶';
    playButton.onclick = function() {
        videoElement.play();
        playButton.style.display = 'none';
    };

    container.appendChild(playButton);
};
