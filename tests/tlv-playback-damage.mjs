import assert from 'node:assert/strict';
import test from 'node:test';

import {createTLVDamageRecovery} from '../src/ts/tlv-damage-recovery.ts';

const damage = overrides => ({
    code: 'TLV_SOURCE_DAMAGE',
    videoTrackId: 10n,
    startTimeUs: 10000000n,
    endTimeUs: 14400000n,
    recoveryTimeUs: 14400000n,
    startInputOffset: 100n,
    endInputOffset: 200n,
    recoveryInputOffset: 300n,
    recoveryRestartOffset: 280n,
    severity: 'severe',
    action: 'seek',
    ...overrides,
});

function fixture({currentTime = 10, video = [], audio = []} = {}) {
    let videoRanges = video;
    let audioRanges = audio;
    const jumps = [];
    const media = {
        currentTime,
        paused: false,
        seeking: false,
        playCount: 0,
        play() {
            this.playCount += 1;
            return Promise.resolve();
        },
    };
    const queues = new Map([
        ['video', {bufferedRanges: () => videoRanges}],
        ['audio', {bufferedRanges: () => audioRanges}],
    ]);
    const recovery = createTLVDamageRecovery({
        media,
        queues: () => queues,
        isActive: () => true,
        isCurrentLayer: event => event.videoTrackId === 10n,
        switchInFlight: () => false,
        seek(target, previous) {
            jumps.push({target, previous});
            media.currentTime = target;
        },
    });
    return {
        media,
        jumps,
        recovery,
        setRanges(nextVideo, nextAudio) {
            videoRanges = nextVideo;
            audioRanges = nextAudio;
        },
    };
}

test('damage report does not seek until the media element is waiting', () => {
    const subject = fixture({video: [{start: 0, end: 30}], audio: [{start: 0, end: 30}]});
    subject.recovery.reportDamage(damage());
    assert.deepEqual(subject.jumps, []);
    subject.recovery.notifyWaiting();
    assert.deepEqual(subject.jumps, [{target: 14.4, previous: 10}]);
    assert.equal(subject.media.playCount, 1);
});

test('waiting recovery requires common audio and video data after the recovery point', () => {
    const subject = fixture({
        video: [{start: 14.4, end: 20}],
        audio: [{start: 14.4, end: 14.7}],
    });
    subject.recovery.reportDamage(damage());
    subject.recovery.notifyWaiting();
    assert.deepEqual(subject.jumps, []);
    subject.setRanges([{start: 14.4, end: 20}], [{start: 14.4, end: 20}]);
    subject.recovery.update();
    assert.deepEqual(subject.jumps, [{target: 14.4, previous: 10}]);
});

test('repeated pending damage still recovers the selected interval once', () => {
    const subject = fixture({video: [{start: 0, end: 30}], audio: [{start: 0, end: 30}]});
    const event = damage();
    assert.equal(subject.recovery.reportDamage(event), true);
    assert.equal(subject.recovery.reportDamage(event), true);
    subject.recovery.notifyWaiting();
    subject.recovery.notifyWaiting();
    assert.deepEqual(subject.jumps, [{target: 14.4, previous: 10}]);
});

test('paused, seeking, warning, and wait-for-recovery states never jump', () => {
    const subject = fixture({video: [{start: 0, end: 30}], audio: [{start: 0, end: 30}]});
    assert.equal(subject.recovery.reportDamage(damage({action: 'none', severity: 'warning'})), false);
    assert.equal(subject.recovery.reportDamage(damage({action: 'wait-for-recovery', recoveryTimeUs: null})), false);
    subject.recovery.reportDamage(damage({startInputOffset: 101n}));
    subject.media.paused = true;
    subject.recovery.notifyWaiting();
    subject.media.paused = false;
    subject.media.seeking = true;
    subject.recovery.update();
    assert.deepEqual(subject.jumps, []);
    subject.recovery.reset();
    subject.media.seeking = false;
    subject.recovery.update();
    assert.deepEqual(subject.jumps, []);
});
