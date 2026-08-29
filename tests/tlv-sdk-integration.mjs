import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';

import {
    startTLVLayerSwitch,
    tlvPlaybackEntryKind,
} from '../src/ts/tlv-playback-entry.ts';

const require = createRequire(import.meta.url);

test('tlvdemux 0.3.5 live sources use the dedicated live playback entry', () => {
    assert.equal(tlvPlaybackEntryKind(true, 0), 'live');
    assert.equal(tlvPlaybackEntryKind(false, 0), 'startup');
    assert.equal(tlvPlaybackEntryKind(false, 30), 'seek');
});

test('0.3.5 resilience consumer has no superseded pipeline option or legacy recovery adapter', () => {
    const player = readFileSync(new URL('../src/ts/tlv-player.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(player, /forceReinitialize/);
    assert.match(player, /createMsePlaybackResilienceController/);
    assert.match(player, /onMseVideoRecovery/);
    assert.match(player, /createLiveMseTransitionManager/);
    assert.match(player, /createRecordedTLVTransitionManager/);
    assert.match(player, /setMseVideoTrackActive/);
    assert.match(player, /tlv_playback_mode/);
    assert.doesNotMatch(player, /createTLVDamageRecovery|reportedDamage/);
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
        mediaTimeUs: 3000000n,
        presentationStartUs: 2000000n,
    };
    assert.equal(await startTLVLayerSwitch({...request, queuesReady: false}), true);
    assert.equal(await startTLVLayerSwitch({...request, queuesReady: true}), true);
    assert.deepEqual(calls, [
        ['entry', 1n, 2n, 3000000n],
        ['running', 1n, 2n, 5000000n],
    ]);
});

test('production and development builds embed the tlvdemux runtime without host sidecars', () => {
    for (const name of ['prod', 'dev']) {
        const config = require(`../webpack/${name}.config.js`);
        assert.equal(config.output.assetModuleFilename, undefined);
        assert.ok(config.module.rules.some(rule =>
            String(rule.resourceQuery) === String(/runtime-source/) && rule.type === 'asset/source'));
        assert.ok(config.module.rules.some(rule =>
            String(rule.test) === String(/tlvdemux\/worker-tlvdemux\.mjs$/) &&
            String(rule.use).endsWith('/webpack/tlvdemux-worker-defaults-loader.cjs')));
    }
});

test('published bundle has no tlvdemux sidecar or build-machine dependency', () => {
    const files = readdirSync(new URL('../dist/', import.meta.url));
    const bundle = readFileSync(new URL('../dist/DPlayer.min.js', import.meta.url), 'utf8');
    assert.deepEqual(files.filter(file => /^tlvdemux(?:-worker)?\.js$/.test(file)), []);
    assert.doesNotMatch(bundle, /(?:\/|\\)tlvdemux(?:-worker)?\.js/);
    assert.doesNotMatch(bundle, /\/Users\//);
    assert.match(bundle, /createObjectURL/);
    assert.match(bundle, /about:blank/);
});
