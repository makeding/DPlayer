import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

import {startTLVLayerSwitch, tlvPlaybackEntryKind} from '../src/ts/tlv-playback-entry.ts';

const require = createRequire(import.meta.url);

test('tlvdemux 0.3.1 live sources use the dedicated live playback entry', () => {
    assert.equal(tlvPlaybackEntryKind(true, 0), 'live');
    assert.equal(tlvPlaybackEntryKind(false, 0), 'startup');
    assert.equal(tlvPlaybackEntryKind(false, 30), 'seek');
});

test('manual layer selection before MSE entry delegates to the public entry switch', async () => {
    const calls = [];
    const demuxer = {
        switchLayerAtPlaybackEntry: async (...args) => { calls.push(['entry', ...args]); return true; },
        switchLayer: async (...args) => { calls.push(['running', ...args]); return true; },
    };
    const request = {
        demuxer,
        videoTrackId: 1n,
        audioTrackId: 2n,
        presentationTimeUs: 3000000n,
    };
    assert.equal(await startTLVLayerSwitch({...request, queuesReady: false}), true);
    assert.equal(await startTLVLayerSwitch({...request, queuesReady: true}), true);
    assert.deepEqual(calls, [
        ['entry', 1n, 2n, 3000000n],
        ['running', 1n, 2n, 3000000n],
    ]);
});

test('production and development builds emit readable stable tlvdemux asset names', () => {
    for (const name of ['prod', 'dev']) {
        const config = require(`../webpack/${name}.config.js`);
        const assetName = config.output.assetModuleFilename;
        assert.equal(assetName({filename: '/node_modules/tlvdemux/dist/tlvdemux.js'}), 'tlvdemux.js');
        assert.equal(assetName({filename: '/node_modules/tlvdemux/worker/demux-worker-runtime.js'}), 'tlvdemux-worker.js');
    }
});
