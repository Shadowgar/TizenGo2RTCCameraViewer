/**
 * Camera sources configuration for TizenGo2RTCCameraViewer
 * Defines HLS URLs for each camera.
 */

window.cameraSources = {
    driveway_stream: {
        hls: 'https://stream.theroccos.us/api/stream.m3u8?src=driveway_stream',
        mjpeg: ''
    },
    backyard_stream: {
        hls: 'https://stream.theroccos.us/api/stream.m3u8?src=backyard_stream',
        mjpeg: ''
    },
    frontyard_stream: {
        hls: 'https://stream.theroccos.us/api/stream.m3u8?src=frontyard_stream',
        mjpeg: ''
    },
    backdeck_stream: {
        hls: 'https://stream.theroccos.us/api/stream.m3u8?src=backdeck_stream',
        mjpeg: ''
    }
};
