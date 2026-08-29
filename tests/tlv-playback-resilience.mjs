import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MsePlaybackMode,
    TLV_VIDEO_UNAVAILABLE,
    createMsePlaybackResilienceController,
} from 'tlvdemux/mse-playback';

const damage = overrides => ({
    code: 'TLV_SOURCE_DAMAGE',
    videoTrackId: 10n,
    startTimeUs: 10_000_000n,
    endTimeUs: 10_500_000n,
    recoveryTimeUs: 11_000_000n,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 280n,
    severity: 'severe',
    action: 'seek',
    ...overrides,
});

function fixture({paused = false} = {}) {
    const modes = [];
    const seeks = [];
    const audioOnlyRequests = [];
    const restoreRequests = [];
    const media = {
        currentTime: 10,
        paused,
        seeking: false,
        videoFrameCallbackSupported: false,
    };
    const controller = createMsePlaybackResilienceController({
        media,
        generation: 7,
        isCurrentLayer: event => event.videoTrackId === 10n,
        isTargetBuffered: () => true,
        seek(target, previous, detail) {
            seeks.push({target, previous, action: detail.action});
            media.currentTime = target;
        },
        onModeChange: event => modes.push(event),
        onAudioOnlyRequested: event => audioOnlyRequests.push(event),
        onVideoRestoreRequested: event => restoreRequests.push(event),
    });
    return {media, controller, modes, seeks, audioOnlyRequests, restoreRequests};
}

function attempt(subject, index) {
    const start = 10 + index;
    const target = 11 + index;
    subject.media.currentTime = start;
    subject.controller.reportDamage(damage({
        startTimeUs: BigInt(start * 1_000_000),
        endTimeUs: BigInt(start * 1_000_000 + 500_000),
        recoveryTimeUs: BigInt(target * 1_000_000),
        startInputOffset: BigInt(100 + index * 10),
        endInputOffset: BigInt(200 + index * 10),
        recoveryInputOffset: BigInt(300 + index * 10),
        recoveryRestartOffset: BigInt(280 + index * 10),
    }));
    subject.controller.notifyWaiting();
}

test('three causal forward RAP failures enter structured audio-only mode', () => {
    const subject = fixture();
    attempt(subject, 0);
    attempt(subject, 1);
    attempt(subject, 2);
    subject.controller.notifyWaiting();

    assert.equal(subject.controller.mode, MsePlaybackMode.AUDIO_ONLY);
    assert.equal(subject.audioOnlyRequests.length, 1);
    assert.equal(subject.audioOnlyRequests[0].code, TLV_VIDEO_UNAVAILABLE);
    assert.deepEqual(subject.audioOnlyRequests[0].attemptedRaps, [11, 12, 13]);
    assert.equal(subject.seeks.length, 3);
});

test('pause, unrelated layer, and explicit seek cannot consume stale recovery', () => {
    const subject = fixture({paused: true});
    subject.controller.reportDamage(damage());
    subject.controller.notifyWaiting();
    subject.controller.reportDamage(damage({videoTrackId: 99n, startInputOffset: 101n}));
    assert.deepEqual(subject.seeks, []);

    subject.controller.notifyPlaybackResumed();
    subject.media.paused = false;
    subject.controller.notifyExplicitSeek(8);
    subject.controller.notifyWaiting();
    assert.deepEqual(subject.seeks, []);
    assert.equal(subject.controller.mode, MsePlaybackMode.AUDIO_VIDEO);
});

test('audio-only restores only through a later selected-layer RAP and frame proof', async () => {
    const subject = fixture();
    attempt(subject, 0);
    attempt(subject, 1);
    attempt(subject, 2);
    subject.controller.notifyWaiting();
    assert.equal(subject.controller.mode, MsePlaybackMode.AUDIO_ONLY);

    subject.media.currentTime = 13;
    subject.controller.observeAccessUnit({
        codec: 'hevc', trackId: 99n, randomAccess: true, ptsValue: 14n, ptsTimescale: 1,
    });
    assert.equal(subject.restoreRequests.length, 0);
    subject.controller.observeAccessUnit({
        codec: 'hevc', trackId: 10n, randomAccess: true, ptsValue: 14n, ptsTimescale: 1,
    });
    await Promise.resolve();
    assert.equal(subject.controller.mode, MsePlaybackMode.RESTORING_VIDEO);
    assert.equal(subject.restoreRequests[0].target, 14);
    subject.controller.observePresentedFrame(13.998);
    assert.equal(subject.controller.mode, MsePlaybackMode.RESTORING_VIDEO);
    subject.controller.observePresentedFrame(14);
    assert.equal(subject.controller.mode, MsePlaybackMode.AUDIO_VIDEO);
});
