/**
 * Remote control module for TizenGo2RTCCameraViewer
 * Handles remote key events and feedback.
 */

window.setupRemoteControls = function() {
    var feedbackIndicator = document.getElementById('remote-feedback');
    if (!feedbackIndicator) {
        feedbackIndicator = document.createElement('div');
        feedbackIndicator.id = 'remote-feedback';
        feedbackIndicator.style.display = 'none';
        document.body.appendChild(feedbackIndicator);
    }

    document.addEventListener('keydown', function(e) {
        var keyName = '';

        switch(e.keyCode) {
            case 38: // UP
                window.navigateGrid('up');
                keyName = 'UP'; break;
            case 40: // DOWN
                window.navigateGrid('down');
                keyName = 'DOWN'; break;
            case 37: // LEFT
                if (window.currentMode === 'grid') window.navigateGrid('left');
                else window.switchToPreviousCamera();
                keyName = 'LEFT'; break;
            case 39: // RIGHT
                if (window.currentMode === 'grid') window.navigateGrid('right');
                else window.switchToNextCamera();
                keyName = 'RIGHT'; break;
            case 13: // ENTER
                window.handleEnter();
                keyName = 'ENTER'; break;
            case 10009: // BACK
                if (window.currentMode === 'single') window.switchToGridView();
                else if (typeof tizen !== 'undefined') tizen.application.getCurrentApplication().exit();
                keyName = 'BACK'; break;
            case 415: case 19: case 10252: // PLAY/PAUSE
                window.togglePlayPause();
                keyName = 'PLAY/PAUSE'; break;
            case 417: // NEXT
                if (window.currentMode === 'single') window.switchToNextCamera();
                keyName = 'NEXT'; break;
            case 412: // PREV
                if (window.currentMode === 'single') window.switchToPreviousCamera();
                keyName = 'PREV'; break;
            case 10182: // EXIT
                if (typeof tizen !== 'undefined') tizen.application.getCurrentApplication().exit();
                keyName = 'EXIT'; break;
            default:
                keyName = 'Key: ' + e.keyCode; break;
        }

        feedbackIndicator.textContent = keyName;
        feedbackIndicator.style.display = 'block';
        setTimeout(function() {
            feedbackIndicator.style.display = 'none';
        }, 1000);
    });
};

window.togglePlayPause = function() {
    if (window.currentMode === 'grid') {
        var selectedVideo = document.querySelector('.camera-container.selected .camera-feed');
        if (selectedVideo) {
            if (selectedVideo.paused) selectedVideo.play();
            else selectedVideo.pause();
        }
    } else if (window.currentMode === 'single') {
        var mainFeed = document.getElementById('main-feed');
        if (mainFeed.paused) mainFeed.play();
        else mainFeed.pause();
    }
};
