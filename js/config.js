(function (global) {
    "use strict";

    // Set these to your Raspberry Pi LAN IP when running in emulator,
    // where .local hostnames are often not resolvable.
    global.TVAppConfig = {
        bridgeBaseUrl: "http://192.168.1.50:8090",
        mediamtxBaseUrl: "http://192.168.1.50:8889"
    };
})(window);
