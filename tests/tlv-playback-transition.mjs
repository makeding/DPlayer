import assert from 'node:assert/strict';
import test from 'node:test';

import {MsePlaybackMode} from 'tlvdemux/mse-playback';
import {
    applyTLVRequiredTracks,
    requestTLVAudioOnlyTransition,
} from '../src/ts/tlv-playback-transition.ts';

test('audio-only and restored A/V required tracks move pipeline and flow together', () => {
    const calls = [];
    const fixture = required => applyTLVRequiredTracks({
        pipeline: {setRequiredTracks: value => calls.push(['pipeline', [...value]])},
        flow: {setRequiredTracks: (value, time) => calls.push(['flow', [...value], time])},
        required,
        currentTime: 12.5,
        restartPlayback: () => calls.push(['restart']),
    });
    fixture(['audio']);
    fixture(['video', 'audio']);
    assert.deepEqual(calls, [
        ['pipeline', ['audio']],
        ['flow', ['audio'], 12.5],
        ['restart'],
        ['pipeline', ['video', 'audio']],
        ['flow', ['video', 'audio'], 12.5],
        ['restart'],
    ]);
});

test('rejected detached audio-only candidate never mutates the authoritative media session', async () => {
    const active = {
        media: {currentTime: 18},
        url: 'blob:authoritative',
        audioQueue: {id: 'audio'},
        videoQueue: {
            quiesce() { throw new Error('active video queue must not be quiesced'); },
        },
        source: {
            removeSourceBuffer() { throw new Error('active SourceBuffer must not be removed'); },
        },
    };
    const required = [];
    let attempts = 0;
    await requestTLVAudioOnlyTransition({
        setRequiredTracks: value => required.push([...value]),
        activateInPlace: async () => ({changed: false}),
        currentMode: () => MsePlaybackMode.AUDIO_ONLY,
        transition: async () => { attempts += 1; throw new Error('candidate decode failed'); },
        currentTime: () => active.media.currentTime,
    });
    assert.deepEqual(required, [['audio']]);
    assert.equal(attempts, 1);
    assert.equal(active.url, 'blob:authoritative');
    assert.equal(active.audioQueue.id, 'audio');
    assert.equal(active.media.currentTime, 18);
});
