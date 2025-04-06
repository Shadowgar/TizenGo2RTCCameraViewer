/**
 * Navigation module for TizenGo2RTCCameraViewer
 * Handles grid/single view switching and camera navigation.
 */

window.updateSelectedCamera = function(index) {
    if (!window.cameraContainers) return;
    for (var i = 0; i < window.cameraContainers.length; i++) {
        window.cameraContainers[i].classList.remove('selected');
    }
    window.selectedCameraIndex = Math.max(0, Math.min(index, window.cameraContainers.length - 1));
    window.cameraContainers[window.selectedCameraIndex].classList.add('selected');
    window.cameraContainers[window.selectedCameraIndex].focus();
};

window.navigateGrid = function(direction) {
    if (window.currentMode !== 'grid') return;
    var gridColumns = 2;
    var currentRow = Math.floor(window.selectedCameraIndex / gridColumns);
    var currentCol = window.selectedCameraIndex % gridColumns;

    switch(direction) {
        case 'up':
            if (currentRow > 0) window.updateSelectedCamera(window.selectedCameraIndex - gridColumns);
            break;
        case 'down':
            if (currentRow < Math.floor((window.cameraContainers.length - 1) / gridColumns)) window.updateSelectedCamera(window.selectedCameraIndex + gridColumns);
            break;
        case 'left':
            if (currentCol > 0) window.updateSelectedCamera(window.selectedCameraIndex - 1);
            break;
        case 'right':
            if (currentCol < gridColumns - 1 && window.selectedCameraIndex < window.cameraContainers.length - 1) window.updateSelectedCamera(window.selectedCameraIndex + 1);
            break;
    }
};

window.handleEnter = function() {
    if (window.currentMode === 'grid' && window.selectedCameraIndex >= 0) {
        var selectedVideo = window.cameraContainers[window.selectedCameraIndex].querySelector('.camera-feed');
        var streamId = selectedVideo.dataset.stream;
        if (streamId) window.switchToSingleView(streamId);
    }
};

window.switchToGridView = function() {
    window.currentMode = 'grid';
    window.currentSingleCamera = null;
    var mainFeed = document.getElementById('main-feed');
    if (mainFeed) {
        mainFeed.pause();
        mainFeed.removeAttribute('src');
        mainFeed.load();
    }
    document.getElementById('grid-view').style.display = 'flex';
    document.getElementById('single-view').style.display = 'none';
    for (var i = 0; i < window.cameraContainers.length; i++) {
        window.cameraContainers[i].style.display = 'block';
    }
    setTimeout(function() {
        var videos = document.querySelectorAll('#grid-view .camera-feed');
        for (var j = 0; j < videos.length; j++) {
            window.initializePlayer(videos[j]);
        }
        window.updateSelectedCamera(window.selectedCameraIndex);
    }, 100);
};

window.switchToSingleView = function(cameraId) {
    if (!window.cameraSources[cameraId]) return;
    var mainFeed = document.getElementById('main-feed');
    var mainLabel = document.getElementById('main-label');
    window.showLoadingIndicator('main-feed');
    var label = cameraId.replace('_stream', '');
    label = label.charAt(0).toUpperCase() + label.slice(1);
    mainLabel.textContent = label;
    for (var i = 0; i < window.cameraContainers.length; i++) {
        window.cameraContainers[i].style.display = 'none';
    }
    mainFeed.pause();
    mainFeed.removeAttribute('src');
    mainFeed.load();
    mainFeed.dataset.stream = cameraId;
    window.initializePlayer(mainFeed);
    document.getElementById('grid-view').style.display = 'none';
    document.getElementById('single-view').style.display = 'block';
    window.currentMode = 'single';
    window.currentSingleCamera = cameraId;
};

window.switchToNextCamera = function() {
    if (!window.currentSingleCamera) return;
    var cameraIds = Object.keys(window.cameraSources);
    var currentIndex = cameraIds.indexOf(window.currentSingleCamera);
    var nextIndex = (currentIndex + 1) % cameraIds.length;
    window.switchToSingleView(cameraIds[nextIndex]);
};

window.switchToPreviousCamera = function() {
    if (!window.currentSingleCamera) return;
    var cameraIds = Object.keys(window.cameraSources);
    var currentIndex = cameraIds.indexOf(window.currentSingleCamera);
    var prevIndex = (currentIndex - 1 + cameraIds.length) % cameraIds.length;
    window.switchToSingleView(cameraIds[prevIndex]);
};
