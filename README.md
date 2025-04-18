# TizenGo2RTCCameraViewer

A Samsung Tizen TV application for viewing and managing IP camera streams using Go2RTC as the backend streaming server.

## Overview

TizenGo2RTCCameraViewer is a web-based application designed for Samsung Tizen TVs that allows users to view multiple camera streams simultaneously in a grid layout or focus on a single camera in full-screen mode. The application connects to a Go2RTC server to receive and display camera streams using HLS (HTTP Live Streaming) technology.

## Features

- **Multi-Camera Grid View**: View multiple camera streams simultaneously
- **Single Camera View**: Focus on one camera in full-screen mode
- **Remote Control Navigation**: Easy navigation using the Samsung TV remote
- **Ambient Mode Support**: Special display mode when the TV is in ambient mode
- **Adaptive Streaming**: Adjusts video quality based on network conditions
- **Stream Health Monitoring**: Visual indicators for stream health status
- **Auto-Reconnection**: Automatically attempts to reconnect to lost streams
- **Optimized Performance**: Efficient resource usage for smooth playback

## Requirements

- Samsung Tizen TV (2.3 or higher)
- Go2RTC server running on your network
- IP cameras configured in Go2RTC
- Network connectivity between TV and Go2RTC server

## Installation

1. Clone this repository or download the source code
2. Open the project in Tizen Studio
3. Configure your camera streams in the `main.js` file
4. Build the project for your target device
5. Install the resulting .wgt file on your Samsung TV using the Tizen Studio Device Manager or Developer Mode

## Configuration

Edit the `cameraStreams` object in `js/main.js` to configure your camera streams:

```javascript
var cameraStreams = {
    camera1: 'http://your-go2rtc-server:1984/api/stream.m3u8?src=camera1&mp4=flac',
    camera2: 'http://your-go2rtc-server:1984/api/stream.m3u8?src=camera2&mp4=flac',
    // Add more cameras as needed
};
```

## Usage

- Use the arrow keys on your remote to navigate between cameras
- Press Enter/OK to switch between grid view and single camera view
- Press Back to return to grid view from single camera view
- Press Play/Pause to toggle video playback

## Go2RTC Integration

This application is designed to work with [Go2RTC](https://github.com/AlexxIT/go2rtc), an excellent streaming server that supports various protocols and can connect to many different camera types. Go2RTC converts your camera streams to HLS format, which is compatible with Samsung Tizen TVs.

## Troubleshooting

- **Streams not loading**: Ensure your Go2RTC server is accessible from your TV's network
- **Playback issues**: Check network connectivity and Go2RTC server logs
- **Performance problems**: Reduce the number of simultaneous streams or lower stream quality

## License

MIT License

## Author

Paul Rocco

## Acknowledgements

- [Go2RTC](https://github.com/AlexxIT/go2rtc) for the streaming server
- [HLS.js](https://github.com/video-dev/hls.js/) for HLS playback in the browser
- Samsung Tizen development community
