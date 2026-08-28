'use strict';

const replacements = [
    [
        `workerUrl: options.workerUrl || new URL(
      './worker/demux-worker-runtime.js', import.meta.url),`,
        'workerUrl: options.workerUrl,',
    ],
    [
        `wasmUrl: options.wasmUrl || new URL(
      './dist/tlvdemux.js', import.meta.url).href,`,
        'wasmUrl: options.wasmUrl,',
    ],
];

module.exports = function removeTlvDemuxWorkerDefaults(source) {
    let output = source;
    for (const [original, replacement] of replacements) {
        if (!output.includes(original)) {
            throw new Error('tlvdemux worker client defaults changed; update the self-contained bundle adapter.');
        }
        output = output.replace(original, replacement);
    }
    return output;
};
