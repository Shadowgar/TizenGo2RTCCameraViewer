/* global Hls */
/* global IntersectionObserver */

// IntersectionObserver polyfill for Tizen compatibility
if (!('IntersectionObserver' in window)) {
    // Simple polyfill for IntersectionObserver
    window.IntersectionObserver = function(callback, options) {
        this.callback = callback;
        this.options = options || {};
        this.targets = [];
        this.lastCheckTime = 0;
        this.checkThrottle = 150; // Throttle checks to every 150ms
        
        // Method to start observing an element
        this.observe = function(target) {
            if (this.targets.indexOf(target) === -1) {
                this.targets.push(target);
                this.checkVisibility(target);
            }
        };
        
        // Method to stop observing an element
        this.unobserve = function(target) {
            var index = this.targets.indexOf(target);
            if (index !== -1) {
                this.targets.splice(index, 1);
            }
        };
        
        // Method to disconnect the observer
        this.disconnect = function() {
            this.targets = [];
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
        };
        
        // Method to check visibility
        this.checkVisibility = function(target) {
            var rect = target.getBoundingClientRect();
            var windowHeight = window.innerHeight || document.documentElement.clientHeight;
            var windowWidth = window.innerWidth || document.documentElement.clientWidth;
            
            // Check if element is in viewport
            var isIntersecting = (
                rect.top <= windowHeight &&
                rect.left <= windowWidth &&
                rect.bottom >= 0 &&
                rect.right >= 0
            );
            
            // Call the callback with an entry
            this.callback([{
                boundingClientRect: rect,
                intersectionRatio: isIntersecting ? 1 : 0,
                intersectionRect: isIntersecting ? rect : null,
                isIntersecting: isIntersecting,
                rootBounds: {
                    bottom: windowHeight,
                    left: 0,
                    right: windowWidth,
                    top: 0,
                    width: windowWidth,
                    height: windowHeight
                },
                target: target,
                time: Date.now()
            }]);
        };
        
        // Set up a timer to periodically check visibility with throttling
        var self = this;
        this.checkAll = function() {
            var now = Date.now();
            if (now - self.lastCheckTime < self.checkThrottle) return;
            
            self.lastCheckTime = now;
            self.targets.forEach(function(target) {
                self.checkVisibility(target);
            });
        };
        
        // Only check on scroll and resize events to reduce CPU usage
        window.addEventListener('scroll', this.checkAll, { passive: true });
        window.addEventListener('resize', this.checkAll, { passive: true });
        
        // Fallback interval with longer delay
        this.intervalId = setInterval(this.checkAll, 500);
    };
}

// Camera stream configuration
var cameraStreams = {
    backdeck_stream: 'http://192.168.50.25:1984/api/stream.m3u8?src=backdeck_stream&mp4=flac&width=1280&height=720',
    driveway_stream: 'http://192.168.50.25:1984/api/stream.m3u8?src=driveway_stream&mp4=flac&width=1280&height=720',
    frontyard_stream: 'http://192.168.50.25:1984/api/stream.m3u8?src=frontyard_stream&mp4=flac&width=1280&height=720',
    backyard_stream: 'http://192.168.50.25:1984/api/stream.m3u8?src=backyard_stream&mp4=flac&width=1280&height=720'
};

// View mode: 'grid' or 'single'
var currentMode = 'grid';
var currentSingleCamera = null;
var hlsPlayers = {};
var lazyLoadObserver = null; // Define lazyLoadObserver variable

// Track currently selected camera in grid view
var selectedCameraIndex = 0;
var cameraContainers = []; // Will hold references to camera containers

// Network quality monitoring
var networkQuality = 'high'; // Can be 'low', 'medium', 'high'
var lastNetworkCheck = Date.now();
var networkCheckInterval = 10000; // Check every 10 seconds

// Reconnection tracking
var reconnectAttempts = {};
var maxReconnectAttempts = 5;
var reconnectInterval = 5000; // 5 seconds between attempts

// Ambient mode variables
var ambientCycleInterval = null;
var ambientCameras = ['frontyard_stream', 'driveway_stream', 'backdeck_stream', 'backyard_stream'];
var currentAmbientCamera = 0;

// Set to track which cameras are currently visible
var visibleCameras = new Set();

// Set to track monitoring intervals for each stream
var streamMonitorIntervals = {};

// Set up lazy loading with Intersection Observer
function setupLazyLoading() {
    // Check if Intersection Observer is supported
    if (!('IntersectionObserver' in window)) {
        console.log("Intersection Observer not supported, loading all cameras");
        // Load all cameras if not supported
        var videos = document.querySelectorAll('.camera-feed');
        for (var i = 0; i < videos.length; i++) {
            initializePlayer(videos[i]);
        }
        return;
    }
    
    // Create an observer to watch for cameras coming into view
    lazyLoadObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            var videoElement = entry.target.querySelector('.camera-feed');
            var streamId = videoElement.dataset.stream;
            
            if (entry.isIntersecting) {
                // Camera is visible, load it if not already loaded
                console.log("Camera visible: " + streamId);
                visibleCameras.add(streamId);
                
                if (!hlsPlayers[streamId] || !hlsPlayers[streamId].media) {
                    console.log("Loading camera: " + streamId);
                    // Use requestIdleCallback or setTimeout to defer loading until browser is idle
                    if (window.requestIdleCallback) {
                        requestIdleCallback(function() {
                            initializePlayer(videoElement);
                        }, { timeout: 1000 });
                    } else {
                        setTimeout(function() {
                            initializePlayer(videoElement);
                        }, 10);
                    }
                } else if (videoElement.paused) {
                    // If player exists but is paused, resume it
                    console.log("Resuming camera: " + streamId);
                    resumeVideo(videoElement);
                    if (hlsPlayers[streamId]) {
                        hlsPlayers[streamId].startLoad();
                    }
                }
                
                // Preload adjacent cameras for better user experience - but only if memory isn't constrained
                if (!checkMemoryPressure()) {
                    preloadAdjacentCameras(streamId);
                }
            } else {
                // Camera is not visible, unload it if it's not the current single camera
                console.log("Camera not visible: " + streamId);
                visibleCameras.delete(streamId);
                
                // Don't unload if it's the current single camera
                if (currentMode !== 'single' || currentSingleCamera !== streamId) {
                    // Give a small delay before unloading to prevent flickering during scrolling
                    setTimeout(function() {
                        if (!visibleCameras.has(streamId)) {
                            console.log("Unloading camera: " + streamId);
                            destroyHlsPlayer(streamId);
                        }
                    }, 1500); // Reduced from 2 seconds to 1.5 seconds for faster memory cleanup
                }
            }
        });
    }, {
        root: null, // Use viewport as root
        rootMargin: '25px', // Reduced from 50px to 25px for more precise loading
        threshold: 0.1 // Trigger when at least 10% of the camera is visible
    });
    
    // Observe all camera containers
    cameraContainers.forEach(function(container) {
        lazyLoadObserver.observe(container);
    });
}

// Function to preload adjacent cameras for smoother navigation
function preloadAdjacentCameras(currentStreamId) {
    if (currentMode !== 'grid') {
        return {};
    }
    
    // Find the index of the current camera
    var currentIndex = -1;
    for (var i = 0; i < cameraContainers.length; i++) {
        var video = cameraContainers[i].querySelector('.camera-feed');
        if (video && video.dataset.stream === currentStreamId) {
            currentIndex = i;
            break;
        }
    }
    
    if (currentIndex === -1) {
        return {};
    }
    
    // Determine which adjacent cameras to preload
    var preloadIndices = [];
    
    // In a grid, we want to preload cameras to the right, below, and diagonally
    var gridSize = Math.sqrt(cameraContainers.length);
    if (gridSize % 1 === 0) { // Perfect square grid
        var row = Math.floor(currentIndex / gridSize);
        var col = currentIndex % gridSize;
        
        // Right camera
        if (col < gridSize - 1) {
            preloadIndices.push(currentIndex + 1);
        }
        
        // Bottom camera
        if (row < gridSize - 1) {
            preloadIndices.push(currentIndex + gridSize);
        }
    } else {
        // If not a perfect grid, just preload the next camera
        if (currentIndex < cameraContainers.length - 1) {
            preloadIndices.push(currentIndex + 1);
        }
    }
    
    // Preload the determined cameras with low priority
    preloadIndices.forEach(function(index) {
        if (index >= 0 && index < cameraContainers.length) {
            var video = cameraContainers[index].querySelector('.camera-feed');
            var streamId = video.dataset.stream;
            
            // Only preload if not already loaded
            if (!hlsPlayers[streamId] && !visibleCameras.has(streamId)) {
                console.log("Preloading adjacent camera: " + streamId);
                // Use a lightweight preloading approach
                preloadStream(streamId);
            }
        }
    });
    return {};
}

// Lightweight preloading of streams without fully initializing the player
function preloadStream(streamId) {
    if (!cameraStreams[streamId]) {
        return {};
    }
    
    // Create a temporary HLS instance just to start loading the manifest
    var tempHls = new Hls({
        maxBufferLength: 0,           // Don't buffer any data
        startLevel: 0,                // Lowest quality
        manifestLoadingTimeOut: 2000, // Shorter timeout for faster preloading
        manifestLoadingMaxRetry: 1,   // Only try once
        enableWorker: false,          // Don't use workers for preloading
        progressive: true,            // Enable progressive parsing
        lowLatencyMode: false,        // Disable low latency mode for preloading
        fragLoadingTimeOut: 0,        // Don't load fragments
        fragLoadingMaxRetry: 0        // Don't retry fragment loading
    });
    
    // Just load the manifest but don't attach to any media element
    tempHls.loadSource(cameraStreams[streamId]);
    
    // Destroy after a shorter time
    setTimeout(function() {
        if (tempHls) {
            tempHls.stopLoad();
            tempHls.destroy();
            tempHls = null;
        }
    }, 1000); // Reduced from 2000ms to 1000ms
    return {};
}

// Function to properly destroy an HLS player and clean up resources
function destroyHlsPlayer(streamId) {
    if (hlsPlayers[streamId]) {
        // Stop monitoring interval
        if (streamMonitorIntervals[streamId]) {
            clearInterval(streamMonitorIntervals[streamId]);
            delete streamMonitorIntervals[streamId];
        }
        
        // Get the video element before destroying the player
        var videoElement = hlsPlayers[streamId].media;
        
        try {
            // Properly clean up the HLS instance
            hlsPlayers[streamId].stopLoad();
            hlsPlayers[streamId].detachMedia();
            hlsPlayers[streamId].destroy();
            
            // Clear any references to the HLS instance
            hlsPlayers[streamId] = null;
            delete hlsPlayers[streamId];
            
            // Reset the video element
            if (videoElement) {
                // Pause the video
                videoElement.pause();
                
                // Remove all event listeners
                videoElement.onplay = null;
                videoElement.onpause = null;
                videoElement.onended = null;
                videoElement.onerror = null;
                videoElement.onloadeddata = null;
                videoElement.onloadedmetadata = null;
                
                // Clear the source
                videoElement.removeAttribute('src');
                videoElement.load();
                
                // Apply the aspect ratio fix
                forceAspectRatio(videoElement);
            }
        } catch (e) {
            console.error("Error destroying HLS player: ", e);
        }
    }
}

// Function to handle video errors
function handleVideoError(error, streamId) {
    console.error("Error playing " + (streamId || "video"), error);
    hideLoadingIndicator(streamId);
}

// Force the video to fill its container by stretching if needed
function forceAspectRatio(videoElement) {
    // Force the video to completely fill the container
    videoElement.style.position = 'absolute';
    videoElement.style.top = '0';
    videoElement.style.left = '0';
    videoElement.style.width = '100%';
    videoElement.style.height = '100%';
    
    // Force stretching to fill container regardless of aspect ratio
    videoElement.style.objectFit = 'fill';
    
    // Set attributes and make sure any browser constraints are overridden
    videoElement.setAttribute('width', '100%');
    videoElement.setAttribute('height', '100%');
    
    // Disable any preserveAspectRatio attributes
    if (videoElement.hasAttribute('preserveAspectRatio')) {
        videoElement.removeAttribute('preserveAspectRatio');
    }
}

// Function for manifest parsed event
function onManifestParsed(videoElement, streamId) {
    try {
        videoElement.play();
        // Apply aspect ratio correction once video starts playing
        videoElement.addEventListener('playing', function() {
            forceAspectRatio(videoElement);
            hideLoadingIndicator(streamId);
        }, { once: true });
    } catch(error) {
        handleVideoError(error, streamId);
    }
}

// Function to hide loading indicator
function hideLoadingIndicator(streamId) {
    // Find the appropriate loading indicator
    var loadingElement;
    
    if (streamId === 'main-feed') {
        loadingElement = document.getElementById('main-loading');
    } else {
        // Find the container that has the video with this stream ID
        var videoElement = document.querySelector('[data-stream="' + streamId + '"]');
        if (videoElement) {
            var containerId = videoElement.id.replace('-feed', '-loading');
            loadingElement = document.getElementById(containerId);
        }
    }
    
    // Hide the loading indicator if found
    if (loadingElement) {
        loadingElement.style.display = 'none';
    }
}

// Function to show loading indicator
function showLoadingIndicator(streamId) {
    var loadingElement;
    
    if (streamId === 'main-feed') {
        loadingElement = document.getElementById('main-loading');
    } else {
        // Find the container that has the video with this stream ID
        var videoElement = document.querySelector('[data-stream="' + streamId + '"]');
        if (videoElement) {
            var containerId = videoElement.id.replace('-feed', '-loading');
            loadingElement = document.getElementById(containerId);
        }
    }
    
    // Show the loading indicator if found
    if (loadingElement) {
        loadingElement.style.display = 'block';
    }
}

// Function for reconnect attempt
function attemptReconnect(streamId, container, errorIndicator) {
    // Get the video element
    var videoElement = document.querySelector('[data-stream="' + streamId + '"]');
    
    // Reinitialize the player
    if (videoElement) {
        // If we have an existing HLS player, destroy it first
        if (hlsPlayers[streamId]) {
            hlsPlayers[streamId].destroy();
            delete hlsPlayers[streamId];
        }
        
        // Reinitialize
        initializePlayer(videoElement);
        
        // Remove error state if successful
        setTimeout(function() {
            checkReconnectSuccess(streamId, container, errorIndicator);
        }, 2000);
    }
}

// Function to check if reconnection was successful
function checkReconnectSuccess(streamId, container, errorIndicator) {
    if (hlsPlayers[streamId] && hlsPlayers[streamId].media && !hlsPlayers[streamId].media.error) {
        container.classList.remove('stream-error');
        if (errorIndicator) {
            errorIndicator.remove();
        }
        reconnectAttempts[streamId] = 0; // Reset counter on success
    }
}

// Function to hide health indicator
function hideIndicator(indicator) {
    indicator.style.opacity = '0';
    setTimeout(function() {
        indicator.remove();
    }, 1000);
}

// Helper function to schedule hiding an indicator
function scheduleHideIndicator(indicator, delay) {
    setTimeout(function() {
        hideIndicator(indicator);
    }, delay);
}

//Helper function to play a video with error handling
function playVideoWithErrorHandling(video) {
    try {
        // Try to play the video directly
        video.play();
    } catch(e) {
        console.error("Error playing video", e);
    }
}

// Define resumeVideo function
function resumeVideo(video) {
    if (video && typeof video.play === 'function') {
        playVideoWithErrorHandling(video);
    }
}

// Function to cycle cameras in ambient mode
function cycleCameras() {
    currentAmbientCamera = (currentAmbientCamera + 1) % ambientCameras.length;
    var ambientVideo = document.getElementById('ambient-feed');
    
    if (ambientVideo) {
        // Switch to next camera
        var nextStream = ambientCameras[currentAmbientCamera];
        
        // If we have an HLS player for this stream, use it
        if (hlsPlayers[nextStream]) {
            var hls = hlsPlayers[nextStream];
            var currentPlayer = ambientVideo.hls;
            
            if (currentPlayer) {
                currentPlayer.detachMedia();
            }
            
            hls.attachMedia(ambientVideo);
            ambientVideo.dataset.stream = nextStream;
            
            try {
                ambientVideo.play();
            } catch(e) {
                console.error("Error playing ambient video", e);
            }
        } else {
            // Initialize a new player
            ambientVideo.dataset.stream = nextStream;
            initializePlayer(ambientVideo);
        }
    }
}

// Optimize camera loading and playback
function optimizeCameraPlayback() {
    // Check if we're running low on memory and need to be more aggressive with cleanup
    var memoryPressure = checkMemoryPressure();
    
    // In grid view, we want all visible cameras to play and pause off-screen ones
    if (currentMode === 'grid') {
        var gridRect = document.getElementById('grid-view').getBoundingClientRect();
        var visibleCount = 0;
        var maxVisibleCameras = memoryPressure ? 2 : 4; // Limit visible cameras under memory pressure
        
        for (var i = 0; i < cameraContainers.length; i++) {
            var container = cameraContainers[i];
            var containerRect = container.getBoundingClientRect();
            var video = container.querySelector('.camera-feed');
            var streamId = video.dataset.stream;
            
            // Check if container is in viewport
            var isVisible = !(
                containerRect.bottom < gridRect.top || 
                containerRect.top > gridRect.bottom ||
                containerRect.right < gridRect.left || 
                containerRect.left > gridRect.right
            );
            
            // If camera is visible or is the selected camera, ensure it's playing
            // But limit the number of simultaneously playing cameras
            if ((isVisible || container.classList.contains('selected')) && visibleCount < maxVisibleCameras) {
                visibleCount++;
                if (!hlsPlayers[streamId] || !hlsPlayers[streamId].media) {
                    initializePlayer(video);
                } else if (video.paused) {
                    hlsPlayers[streamId].startLoad();
                    playVideoWithErrorHandling(video);
                }
            } 
            // Otherwise, pause it to save resources
            else {
                if (hlsPlayers[streamId]) {
                    if (!video.paused) {
                        video.pause();
                        hlsPlayers[streamId].stopLoad();
                    }
                    
                    // If we're under memory pressure, be more aggressive with cleanup
                    if (memoryPressure && !container.classList.contains('selected')) {
                        destroyHlsPlayer(streamId);
                    }
                }
            }
        }
    }
    // In single view, only the main feed should be playing
    else if (currentMode === 'single') {
        var mainFeed = document.getElementById('main-feed');
        if (mainFeed.paused) {
            playVideoWithErrorHandling(mainFeed);
        }
        
        // Pause all grid view cameras to save resources
        for (var j = 0; j < cameraContainers.length; j++) {
            var gridVideo = cameraContainers[j].querySelector('.camera-feed');
            var gridStreamId = gridVideo.dataset.stream;
            
            // Don't pause the current single camera
            if (gridStreamId !== currentSingleCamera && hlsPlayers[gridStreamId]) {
                gridVideo.pause();
                hlsPlayers[gridStreamId].stopLoad();
                
                // If we're under memory pressure, destroy all non-visible players
                if (memoryPressure) {
                    destroyHlsPlayer(gridStreamId);
                }
            }
        }
    }
}

// Check if we're running low on memory
function checkMemoryPressure() {
    // Use performance.memory if available (Chrome)
    if (window.performance && performance.memory) {
        var memoryInfo = performance.memory;
        var usedHeapRatio = memoryInfo.usedJSHeapSize / memoryInfo.jsHeapSizeLimit;
        
        // If we're using more than 70% of available JS heap, consider it memory pressure
        return usedHeapRatio > 0.7;
    }
    
    // Count active HLS players as a proxy for memory usage
    var activePlayerCount = 0;
    for (var streamId in hlsPlayers) {
        if (hlsPlayers[streamId]) {
            activePlayerCount++;
        }
    }
    
    // If we have more than 3 active players, consider it memory pressure
    return activePlayerCount > 3;
}

// Update the selected camera
function updateSelectedCamera(index) {
    // Remove selection from all cameras
    for (var i = 0; i < cameraContainers.length; i++) {
        cameraContainers[i].classList.remove('selected');
    }
    
    // Ensure index is in valid range
    selectedCameraIndex = Math.max(0, Math.min(index, cameraContainers.length - 1));
    
    // Add selection to current camera
    cameraContainers[selectedCameraIndex].classList.add('selected');
    
    // Focus the selected container for keyboard accessibility
    cameraContainers[selectedCameraIndex].focus();
}

// Implement grid navigation
function navigateGrid(direction) {
    if (currentMode !== 'grid') {
        return;
    }
    
    var gridColumns = 2; // We have a 2x2 grid
    var currentRow = Math.floor(selectedCameraIndex / gridColumns);
    var currentCol = selectedCameraIndex % gridColumns;
    
    switch(direction) {
        case 'up':
            if (currentRow > 0) {
                updateSelectedCamera(selectedCameraIndex - gridColumns);
            }
            break;
        case 'down':
            if (currentRow < Math.floor((cameraContainers.length - 1) / gridColumns)) {
                updateSelectedCamera(selectedCameraIndex + gridColumns);
            }
            break;
        case 'left':
            if (currentCol > 0) {
                updateSelectedCamera(selectedCameraIndex - 1);
            }
            break;
        case 'right':
            if (currentCol < gridColumns - 1 && selectedCameraIndex < cameraContainers.length - 1) {
                updateSelectedCamera(selectedCameraIndex + 1);
            }
            break;
    }
}

// Handle enter key press
function handleEnter() {
    if (currentMode === 'grid' && selectedCameraIndex >= 0) {
        // Get the stream ID from the selected camera
        var selectedVideo = cameraContainers[selectedCameraIndex].querySelector('.camera-feed');
        var streamId = selectedVideo.dataset.stream;
        if (streamId) {
            switchToSingleView(streamId);
        }
    }
}

// Switch to grid view showing all cameras
function switchToGridView() {
    document.getElementById('grid-view').style.display = 'flex';
    document.getElementById('single-view').style.display = 'none';
    
    // If we're coming from single view, we need to reattach the HLS player
    if (currentMode === 'single' && currentSingleCamera) {
        // Get the HLS instance from the single view
        var hls = hlsPlayers[currentSingleCamera];
        if (hls) {
            // Detach from main feed
            hls.detachMedia();
            
            // Find the original video element in the grid
            var gridVideo = document.querySelector('[data-stream="' + currentSingleCamera + '"]');
            if (gridVideo) {
                // Reattach to the grid video
                hls.attachMedia(gridVideo);
                try {
                    gridVideo.play();
                } catch(e) {
                    console.error("Error playing grid video:", e);
                }
            }
        }
    }
    
    // Show all camera containers
    for (var i = 0; i < cameraContainers.length; i++) {
        cameraContainers[i].style.display = 'block';
    }
    
    // Ensure all grid cameras are playing and have HLS players
    var videos = document.querySelectorAll('#grid-view .camera-feed');
    for (var j = 0; j < videos.length; j++) {
        var video = videos[j];
        var streamId = video.dataset.stream;
        
        // If this stream doesn't have an HLS player, initialize one
        if (!hlsPlayers[streamId] || !hlsPlayers[streamId].media) {
            initializePlayer(video);
        } else {
            // Otherwise just resume the video
            resumeVideo(video);
        }
    }
    
    // Update the current mode
    currentMode = 'grid';
}

// Switch to single camera view
function switchToSingleView(cameraId) {
    if (!cameraStreams[cameraId]) {
        return;
    }
    
    var mainFeed = document.getElementById('main-feed');
    var mainLabel = document.getElementById('main-label');
    
    // Show loading indicator for main feed
    showLoadingIndicator('main-feed');
    
    // Set label based on camera ID
    var label = cameraId.replace('_stream', '');
    label = label.charAt(0).toUpperCase() + label.slice(1); // Capitalize first letter
    mainLabel.textContent = label;
    
    // Hide all camera containers in grid view (don't destroy them)
    for (var i = 0; i < cameraContainers.length; i++) {
        cameraContainers[i].style.display = 'none';
    }
    
    // If we already have an HLS instance for this camera, use it
    if (hlsPlayers[cameraId]) {
        var hls = hlsPlayers[cameraId];
        hls.detachMedia();
        hls.attachMedia(mainFeed);
        try {
            mainFeed.play();
            // Apply aspect ratio correction for single view
            mainFeed.addEventListener('playing', function() {
                forceAspectRatio(mainFeed);
                hideLoadingIndicator('main-feed');
            }, { once: true });
        } catch(e) {
            console.error("Error playing video", e);
            hideLoadingIndicator('main-feed');
        }
    } else {
        // Otherwise create a new one
        mainFeed.dataset.stream = cameraId;
        initializePlayer(mainFeed);
    }
    
    document.getElementById('grid-view').style.display = 'none';
    document.getElementById('single-view').style.display = 'block';
    currentMode = 'single';
    currentSingleCamera = cameraId;
}

// Update stream health indicator
function updateStreamHealth(cameraIndex, status) {
    // Get the camera container
    var container = cameraContainers[cameraIndex];
    if (!container) {
        console.error("Invalid camera index:", cameraIndex);
        return;
    }
    
    // Find or create the health indicator
    var healthIndicator = container.querySelector('.stream-health-indicator');
    if (!healthIndicator) {
        healthIndicator = document.createElement('div');
        healthIndicator.className = 'stream-health-indicator';
        container.appendChild(healthIndicator);
    }
    
    // Remove all status classes
    healthIndicator.classList.remove('health-good', 'health-poor', 'health-error');
    
    // Set the appropriate status class and text
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
}

// Network quality monitoring and adaptive streaming
function checkNetworkQuality() {
    var now = Date.now();
    if (now - lastNetworkCheck < networkCheckInterval) {
        return;
    }
    
    lastNetworkCheck = now;
    
    // Use Navigator.connection if available
    if (navigator.connection) {
        var conn = navigator.connection;
        
        if (conn.saveData) {
            // Data saver is enabled, use lowest quality
            adjustStreamQuality('low');
            return;
        }
        
        if (conn.effectiveType) {
            switch (conn.effectiveType) {
                case 'slow-2g':
                case '2g':
                    adjustStreamQuality('low');
                    break;
                case '3g':
                    adjustStreamQuality('medium');
                    break;
                case '4g':
                    adjustStreamQuality('high');
                    break;
                default:
                    adjustStreamQuality('medium');
            }
        }
    } else {
        // If Navigator.connection isn't available, check loading times
        monitorStreamLoadingTime();
    }
}

function monitorStreamLoadingTime() {
    // This is a simple implementation that could be expanded
    var activePlayer = currentMode === 'single' ? 
        hlsPlayers[currentSingleCamera] : 
        hlsPlayers[document.querySelector('.camera-container.selected .camera-feed').dataset.stream];
    
    if (activePlayer && activePlayer.stats) {
        var stats = activePlayer.stats;
        
        // Check for loading delays
        if (stats.fragLoadingTime > 1000) {
            // Loading is slow, lower quality
            adjustStreamQuality('low');
        } else if (stats.fragLoadingTime > 500) {
            adjustStreamQuality('medium');
        } else {
            adjustStreamQuality('high');
        }
    }
}

function adjustStreamQuality(quality) {
    if (networkQuality === quality) {
        return;
    }
    
    networkQuality = quality;
    console.log("Adjusting stream quality to: " + quality);
    
    // Apply quality setting to all HLS players
    for (var streamId in hlsPlayers) {
        var player = hlsPlayers[streamId];
        
        if (player) {
            switch (quality) {
                case 'low':
                    player.nextLevel = 0; // Force lowest quality
                    break;
                case 'medium':
                    player.nextLevel = Math.floor(player.levels.length / 2); // Middle quality
                    break;
                case 'high':
                    player.nextLevel = -1; // Auto (highest based on bandwidth)
                    break;
            }
        }
    }
    
    // Show quality indicator
    showQualityIndicator(quality);
}

function showQualityIndicator(quality) {
    // Create or update quality indicator
    var indicator = document.getElementById('quality-indicator');
    
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'quality-indicator';
        document.body.appendChild(indicator);
    }
    
    indicator.className = 'quality-' + quality;
    indicator.textContent = 'Quality: ' + quality.charAt(0).toUpperCase() + quality.slice(1);
    
    // Show temporarily then fade out
    indicator.style.display = 'block';
    setTimeout(function() {
        indicator.style.opacity = '0';
    }, 3000);
}

// Enhanced error handling and reconnection
function handleStreamError(streamId, error) {
    console.error("Stream error for " + streamId, error);
    
    // Initialize reconnect attempts counter if needed
    if (!reconnectAttempts[streamId]) {
        reconnectAttempts[streamId] = 0;
    }
    
    var container = document.querySelector('[data-stream="' + streamId + '"]').closest('.camera-container');
    
    // Show error state
    container.classList.add('stream-error');
    
    // Add error indicator if it doesn't exist
    var errorIndicator = container.querySelector('.error-indicator');
    if (!errorIndicator) {
        errorIndicator = document.createElement('div');
        errorIndicator.className = 'error-indicator';
        errorIndicator.innerHTML = '<span class="error-icon">⚠️</span> Stream Error<br>Reconnecting...';
        container.appendChild(errorIndicator);
    }
    
    // Attempt to reconnect if we haven't tried too many times
    if (reconnectAttempts[streamId] < maxReconnectAttempts) {
        reconnectAttempts[streamId]++;
        
        errorIndicator.innerHTML = '<span class="error-icon">⚠️</span> Stream Error<br>Reconnecting... Attempt ' + 
            reconnectAttempts[streamId] + '/' + maxReconnectAttempts;
        
        console.log("Attempting to reconnect to " + streamId + " (" + reconnectAttempts[streamId] + "/" + maxReconnectAttempts + ")");
        
        // Use the predefined function with parameters
        setTimeout(function() {
            attemptReconnect(streamId, container, errorIndicator);
        }, reconnectInterval);
    } else {
        // Max attempts reached, show final error state
        errorIndicator.innerHTML = '<span class="error-icon">⚠️</span> Stream Error<br>Reconnection failed';
        console.error("Max reconnection attempts reached for " + streamId);
        hideLoadingIndicator(streamId);
    }
}

// Stream health monitoring
function monitorStreamHealth() {
    for (var streamId in hlsPlayers) {
        var player = hlsPlayers[streamId];
        
        if (player && player.stats) {
            var stats = player.stats;
            var videoElement = player.media;
            var container = videoElement.closest('.camera-container');
            
            if (!container) {
                continue;
            }
            
            // Remove any existing indicators
            var existingIndicator = container.querySelector('.stream-health');
            if (existingIndicator) {
                existingIndicator.remove();
            }
            
            // Create health indicator
            var healthIndicator = document.createElement('div');
            healthIndicator.className = 'stream-health';
            
            // Calculate health based on various metrics
            var health = calculateStreamHealth(stats);
            
            // Set appropriate class and text
            if (health > 80) {
                healthIndicator.classList.add('health-good');
                healthIndicator.textContent = 'Excellent';
            } else if (health > 50) {
                healthIndicator.classList.add('health-medium');
                healthIndicator.textContent = 'Good';
            } else if (health > 30) {
                healthIndicator.classList.add('health-poor');
                healthIndicator.textContent = 'Poor';
            } else {
                healthIndicator.classList.add('health-bad');
                healthIndicator.textContent = 'Bad';
            }
            
            // Add tooltip with details
            healthIndicator.title = 'Buffer: ' + Math.round(stats.buffered * 100) / 100 + 's\n' +
                                   'Bitrate: ' + Math.round(stats.bitrate / 1000) + ' kbps\n' +
                                   'Dropped Frames: ' + stats.droppedFrames;
            
            // Add to container
            container.appendChild(healthIndicator);
            
            // Schedule hiding of the indicator with the helper function
            scheduleHideIndicator(healthIndicator, 3000);
        }
    }
}

function calculateStreamHealth(stats) {
    // This is a simplified health calculation
    // Real implementation would be more sophisticated
    
    var health = 100;
    
    // Penalize for buffering issues
    if (stats.buffered < 0.5) {
        health -= 30;
    } else if (stats.buffered < 1) {
        health -= 15;
    }
    
    // Penalize for dropped frames
    if (stats.droppedFrames > 30) {
        health -= 30;
    } else if (stats.droppedFrames > 10) {
        health -= 15;
    }
    
    // Penalize for low bitrate
    if (stats.bitrate < 100000) {
        health -= 20;
    } else if (stats.bitrate < 500000) {
        health -= 10;
    }
    
    return Math.max(0, health);
}

// Samsung Ambient Mode integration
function setupAmbientMode() {
    if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
        try {
            // Listen for ambient mode changes
            document.addEventListener('visibilitychange', handleVisibilityChange);
            
            // Check if app is launched in ambient mode
            if (tizen.tvaudiocontrol.getScreenState() === 'SCREEN_STATE_NORMAL') {
                console.log("App launched in normal mode");
            } else {
                console.log("App launched in ambient mode");
                enterAmbientMode();
            }
        } catch (e) {
            console.error("Error setting up ambient mode:", e);
        }
    } else {
        console.log("Ambient mode API not available");
    }
}

function handleVisibilityChange() {
    if (document.hidden) {
        // App is going to background or ambient mode
        if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
            if (tizen.tvaudiocontrol.getScreenState() !== 'SCREEN_STATE_NORMAL') {
                enterAmbientMode();
            }
        }
    } else {
        // App is coming to foreground
        exitAmbientMode();
    }
}

function enterAmbientMode() {
    console.log("Entering ambient mode");
    
    // Switch to ambient mode UI
    document.body.classList.add('ambient-mode');
    
    // Show only one camera (e.g., front door) in ambient mode
    var ambientContainer = document.getElementById('ambient-container');
    if (!ambientContainer) {
        ambientContainer = document.createElement('div');
        ambientContainer.id = 'ambient-container';
        
        // Create video element for ambient mode
        var ambientVideo = document.createElement('video');
        ambientVideo.id = 'ambient-feed';
        ambientVideo.className = 'camera-feed';
        ambientVideo.dataset.stream = 'frontyard_stream'; // Use front yard by default
        
        ambientContainer.appendChild(ambientVideo);
        document.body.appendChild(ambientContainer);
        
        // Initialize the player
        initializePlayer(ambientVideo);
    }
    
    // Hide main UI
    document.getElementById('main').style.display = 'none';
    ambientContainer.style.display = 'block';
    
    // Lower brightness and contrast for ambient mode
    document.body.style.filter = 'brightness(0.7) contrast(0.9)';
    
    // Cycle through cameras in ambient mode
    startAmbientCameraCycle();
}

function exitAmbientMode() {
    console.log("Exiting ambient mode");
    
    // Restore normal UI
    document.body.classList.remove('ambient-mode');
    document.body.style.filter = '';
    
    // Show main UI
    document.getElementById('main').style.display = 'block';
    
    // Hide ambient container
    var ambientContainer = document.getElementById('ambient-container');
    if (ambientContainer) {
        ambientContainer.style.display = 'none';
    }
    
    // Stop camera cycling
    stopAmbientCameraCycle();
}

function startAmbientCameraCycle() {
    // Stop any existing cycle
    stopAmbientCameraCycle();
    
    // Start cycling through cameras
    ambientCycleInterval = setInterval(cycleCameras, 30000); // Switch every 30 seconds
}

function stopAmbientCameraCycle() {
    if (ambientCycleInterval) {
        clearInterval(ambientCycleInterval);
        ambientCycleInterval = null;
    }
}

// Enhanced remote control support
function setupRemoteControls() {
    // Add visual feedback for remote control
    var feedbackIndicator = document.createElement('div');
    feedbackIndicator.id = 'remote-feedback';
    feedbackIndicator.style.display = 'none';
    document.body.appendChild(feedbackIndicator);
    
    // Add event listeners for remote control keys
    document.addEventListener('keydown', function(e) {
        // Show visual feedback
        showRemoteFeedback(e.keyCode);
        
        // Handle additional keys beyond basic navigation
        switch(e.keyCode) {
            case 415: // PLAY
                togglePlayPause();
                break;
            case 19: // PAUSE
                togglePlayPause();
                break;
            case 417: // FAST FORWARD - switch to next camera in single view
                if (currentMode === 'single') {
                    switchToNextCamera();
                }
                break;
            case 412: // REWIND - switch to previous camera in single view
                if (currentMode === 'single') {
                    switchToPreviousCamera();
                }
                break;
            case 10252: // PLAY_PAUSE toggle
                togglePlayPause();
                break;
            case 10009: // RETURN/BACK - already handled in main keydown handler
                break;
            case 10182: // EXIT/HOME
                if (typeof tizen !== 'undefined') {
                    tizen.application.getCurrentApplication().exit();
                }
                break;
            // Add more key handlers as needed
        }
    });
    
    // Add click event handlers for UI buttons
    var backToGridButton = document.getElementById('back-to-grid');
    if (backToGridButton) {
        backToGridButton.addEventListener('click', function() {
            switchToGridView();
        });
    }
    
    // Add event handlers for other control buttons
    var previousButton = document.getElementById('previous-camera');
    if (previousButton) {
        previousButton.addEventListener('click', switchToPreviousCamera);
    }
    
    var nextButton = document.getElementById('next-camera');
    if (nextButton) {
        nextButton.addEventListener('click', switchToNextCamera);
    }
    
    var togglePlayButton = document.getElementById('toggle-play');
    if (togglePlayButton) {
        togglePlayButton.addEventListener('click', togglePlayPause);
    }
}

function showRemoteFeedback(keyCode) {
    var feedbackIndicator = document.getElementById('remote-feedback');
    if (!feedbackIndicator) {
        return;
    }
    
    var keyName = '';
    
    // Map key codes to names
    switch(keyCode) {
        case 38: keyName = '↑'; break;
        case 40: keyName = '↓'; break;
        case 37: keyName = '←'; break;
        case 39: keyName = '→'; break;
        case 13: keyName = 'OK'; break;
        case 10009: keyName = 'BACK'; break;
        case 415: case 19: case 10252: keyName = 'PLAY/PAUSE'; break;
        case 417: keyName = 'NEXT'; break;
        case 412: keyName = 'PREV'; break;
        case 10182: keyName = 'EXIT'; break;
        default: keyName = 'Key: ' + keyCode; break;
    }
    
    // Show the feedback
    feedbackIndicator.textContent = keyName;
    feedbackIndicator.style.display = 'block';
    
    // Hide after a short delay
    setTimeout(function() {
        feedbackIndicator.style.display = 'none';
    }, 1000);
}

function togglePlayPause() {
    if (currentMode === 'grid') {
        // Toggle play/pause for selected camera in grid
        var selectedVideo = document.querySelector('.camera-container.selected .camera-feed');
        if (selectedVideo) {
            if (selectedVideo.paused) {
                selectedVideo.play();
            } else {
                selectedVideo.pause();
            }
        }
    } else if (currentMode === 'single') {
        // Toggle play/pause for main feed
        var mainFeed = document.getElementById('main-feed');
        if (mainFeed.paused) {
            mainFeed.play();
        } else {
            mainFeed.pause();
        }
    }
}

function switchToNextCamera() {
    if (!currentSingleCamera) {
        return;
    }
    
    // Get array of camera IDs
    var cameraIds = Object.keys(cameraStreams);
    var currentIndex = cameraIds.indexOf(currentSingleCamera);
    var nextIndex = (currentIndex + 1) % cameraIds.length;
    
    switchToSingleView(cameraIds[nextIndex]);
}

function switchToPreviousCamera() {
    if (!currentSingleCamera) {
        return;
    }
    
    // Get array of camera IDs
    var cameraIds = Object.keys(cameraStreams);
    var currentIndex = cameraIds.indexOf(currentSingleCamera);
    var prevIndex = (currentIndex - 1 + cameraIds.length) % cameraIds.length;
    
    switchToSingleView(cameraIds[prevIndex]);
}

// Initialize the application
window.onload = function() {
    console.log("Application starting...");
    
    // Add error handling for the entire application
    window.onerror = function(message, source, lineno) {
        console.error("Global error: ", message, " at ", source, ":", lineno);
        return true;
    };
    
    try {
        console.log("Initializing camera feeds...");
        // Initialize all camera feeds
        setupLazyLoading();
        
        // Initialize camera selection
        cameraContainers = document.querySelectorAll('.camera-container');
        updateSelectedCamera(0); // Select first camera by default

        // Make camera containers focusable for keyboard navigation
        for (var k = 0; k < cameraContainers.length; k++) {
            cameraContainers[k].setAttribute('tabindex', '0');
        }
        
        // Add event handler for back-to-grid button
        var backToGridButton = document.getElementById('back-to-grid');
        if (backToGridButton) {
            backToGridButton.addEventListener('click', function() {
                switchToGridView();
            });
        }
        
        // Check for URL parameters to set initial state
        var params = window.location.search.substring(1).split('&');
        var mode = null;
        var camera = null;
        
        for (var i = 0; i < params.length; i++) {
            var pair = params[i].split('=');
            if (pair[0] === 'mode') {
                mode = pair[1];
            } else if (pair[0] === 'camera') {
                camera = pair[1];
            }
        }
        
        if (mode === 'single' && camera && cameraStreams[camera]) {
            switchToSingleView(camera);
        }
        
        // Listen for messages from Home Assistant
        window.addEventListener('message', function(event) {
            if (event.data && event.data.action) {
                switch (event.data.action) {
                    case 'switchToGrid':
                        switchToGridView();
                        break;
                    case 'switchToSingle':
                        if (event.data.camera && cameraStreams[event.data.camera]) {
                            switchToSingleView(event.data.camera);
                        }
                        break;
                    default:
                        break;
                }
            }
        });
        
        // Handle key events for TV remote
        document.addEventListener('keydown', function(e) {
            switch(e.keyCode) {
                case 10009: // RETURN key
                    if (currentMode === 'single') {
                        switchToGridView();
                    } else {
                        if (typeof tizen !== 'undefined') {
                            tizen.application.getCurrentApplication().exit();
                        }
                    }
                    break;
                case 38: // UP arrow
                    navigateGrid('up');
                    break;
                case 40: // DOWN arrow
                    navigateGrid('down');
                    break;
                case 37: // LEFT arrow
                    navigateGrid('left');
                    break;
                case 39: // RIGHT arrow
                    navigateGrid('right');
                    break;
                case 13: // ENTER key
                    handleEnter();
                    break;
                default:
                    console.log('Key pressed: ' + e.keyCode);
                    break;
            }
        });
        
        // Set up lazy loading
        window.addEventListener('resize', optimizeCameraPlayback);
        setInterval(optimizeCameraPlayback, 5000); // Check every 5 seconds

        // Run initial optimization
        setTimeout(optimizeCameraPlayback, 1000);
        
        // Set up network quality monitoring
        setInterval(checkNetworkQuality, 10000); // Check every 10 seconds
        
        // Set up stream health monitoring
        setInterval(monitorStreamHealth, 10000); // Check every 10 seconds
        
        // Set up Samsung Ambient Mode
        setupAmbientMode();
        
        // Set up remote-friendly controls
        setupRemoteControls();
        
    } catch (e) {
        console.error("Error in initialization: ", e);
    }
};

// Initialize a video player with HLS.js
function initializePlayer(videoElement) {
    var streamId = videoElement.dataset.stream;
    
    if (!streamId || !cameraStreams[streamId]) {
        console.error("Invalid stream ID:", streamId);
        return;
    }
    
    // If this stream already has an HLS player, don't initialize again
    if (hlsPlayers[streamId] && hlsPlayers[streamId].media === videoElement) {
        console.log("Player already initialized for stream: " + streamId);
        return;
    }
    
    // Clean up any existing HLS player for this stream
    destroyHlsPlayer(streamId);
    
    // Show loading indicator
    showLoadingIndicator(streamId);
    
    // Get the camera index for health monitoring
    var cameraIndex = -1;
    for (var i = 0; i < cameraContainers.length; i++) {
        var video = cameraContainers[i].querySelector('.camera-feed');
        if (video && video.dataset.stream === streamId) {
            cameraIndex = i;
            break;
        }
    }
    
    // Create HLS player if supported
    if (Hls.isSupported()) {
        var hls = new Hls({
            maxBufferLength: 2,           // Reduced for faster startup and lower memory usage
            maxMaxBufferLength: 6,        // Reduced for better memory management
            manifestLoadingTimeOut: 4000, // Reduced for faster error detection
            manifestLoadingMaxRetry: 2,   
            levelLoadingTimeOut: 4000,    // Reduced for faster error detection
            levelLoadingMaxRetry: 2,      
            startLevel: -1,               // Auto-select starting level based on bandwidth
            abrEwmaDefaultEstimate: 500000, // Initial bandwidth estimate (500kbps)
            abrEwmaFastLive: 2,           // Faster ABR algorithm for live streams
            abrEwmaSlowLive: 5,           // Faster ABR algorithm for live streams
            enableWorker: true,           // Use Web Workers for better performance
            lowLatencyMode: true,         // Enable low latency mode
            backBufferLength: 5,          // Further reduced back buffer for memory efficiency
            maxBufferHole: 0.3,           
            highBufferWatchdogPeriod: 1,  
            nudgeMaxRetry: 3,             
            maxFragLookUpTolerance: 0.2,  
            liveSyncDurationCount: 2,     
            liveMaxLatencyDurationCount: 4, // Reduced for lower latency
            liveDurationInfinity: false,  
            maxLiveSyncPlaybackRate: 1.5,
            testBandwidth: true,          // Enable bandwidth testing for better quality selection
            progressive: true,            // Enable progressive parsing for faster startup
            lowLatencyMode: true,         // Enable low latency mode
            cmcd: {                       // Add CMCD (Common Media Client Data) for better CDN optimization
                enabled: true,
                sessionId: streamId,
                contentId: streamId
            }
        });
        
        hls.loadSource(cameraStreams[streamId]);
        hls.attachMedia(videoElement);
        
        // Store the HLS instance for later use
        hlsPlayers[streamId] = hls;
        
        // Set up event handlers
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
            onManifestParsed(videoElement, streamId);
            
            // Set stream health to good when manifest is parsed
            if (cameraIndex !== -1) {
                updateStreamHealth(cameraIndex, 'good');
            }
        });
        
        hls.on(Hls.Events.ERROR, function(event, data) {
            console.error("HLS error:", data);
            
            // Set stream health to error on fatal errors
            if (data.fatal && cameraIndex !== -1) {
                updateStreamHealth(cameraIndex, 'error');
            }
            
            if (data.fatal) {
                switch(data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        // Try to recover network error
                        console.log("Fatal network error encountered, trying to recover");
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log("Fatal media error encountered, trying to recover");
                        hls.recoverMediaError();
                        break;
                    default:
                        // Cannot recover
                        console.log("Fatal error, cannot recover");
                        destroyHlsPlayer(streamId);
                        handleStreamError(streamId, "Fatal playback error");
                        break;
                }
            }
        });
        
        // Set up monitoring interval to check video readyState
        if (cameraIndex !== -1) {
            // Clear any existing interval
            if (streamMonitorIntervals[streamId]) {
                clearInterval(streamMonitorIntervals[streamId]);
            }
            
            // Create new monitoring interval
            streamMonitorIntervals[streamId] = setInterval(function() {
                if (!videoElement.paused) {
                    if (videoElement.readyState < 3) { // HAVE_FUTURE_DATA = 3
                        updateStreamHealth(cameraIndex, 'poor');
                    } else {
                        updateStreamHealth(cameraIndex, 'good');
                    }
                }
            }, 5000); // Check every 5 seconds
        }
    }
    // Fallback for browsers without HLS.js support
    else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        videoElement.src = cameraStreams[streamId];
        videoElement.addEventListener('loadedmetadata', function() {
            onManifestParsed(videoElement, streamId);
            
            // Set stream health to good
            if (cameraIndex !== -1) {
                updateStreamHealth(cameraIndex, 'good');
            }
        });
        
        videoElement.addEventListener('error', function(e) {
            console.error("Video error:", e);
            handleStreamError(streamId, "Video playback error");
            
            // Set stream health to error
            if (cameraIndex !== -1) {
                updateStreamHealth(cameraIndex, 'error');
            }
        });
    } else {
        console.error("HLS is not supported in this browser!");
        handleStreamError(streamId, "HLS not supported");
    }
}