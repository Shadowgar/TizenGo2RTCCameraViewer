(function (global) {
    "use strict";

    // Emulator networking tip:
    // - Tizen TV emulator uses NAT (10.0.2.x)
    // - 10.0.2.2 maps to the host machine from emulator guest
    // Use host-side forwarding/tunnel from host:8090/8889 -> Pi:8090/8889,
    // then keep these URLs on 10.0.2.2 for emulator testing.
    global.TVAppConfig = {
        forceRuntimeConfig: true,
        bridgeBaseUrl: "http://192.168.50.179:8090",
        bridgeBaseUrlCandidates: [
            "http://192.168.50.179:8090",
            "http://10.0.2.2:8090"
        ],
        mediamtxBaseUrl: "http://10.0.2.2:8889"
    };
})(window);
