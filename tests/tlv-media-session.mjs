import assert from 'node:assert/strict';
import test from 'node:test';

import {createTLVDynamicMedia, promoteTLVMedia} from '../src/ts/tlv-media-session.ts';

test('dynamic TLV media proxy follows atomic element handoff and owns frame callback cancellation', () => {
    const calls = [];
    const first = {
        currentTime: 3,
        paused: false,
        seeking: false,
        ended: false,
        error: null,
        buffered: {length: 0},
        play: async () => { calls.push('first-play'); },
        pause: () => calls.push('first-pause'),
        requestVideoFrameCallback: () => 41,
        cancelVideoFrameCallback: id => calls.push(`first-cancel-${id}`),
    };
    const second = {
        ...first,
        currentTime: 8,
        play: async () => { calls.push('second-play'); },
        pause: () => calls.push('second-pause'),
        requestVideoFrameCallback: () => 82,
        cancelVideoFrameCallback: id => calls.push(`second-cancel-${id}`),
    };
    let current = first;
    const proxy = createTLVDynamicMedia(() => current);
    const firstRequest = proxy.requestVideoFrameCallback(() => undefined);
    current = second;
    assert.equal(proxy.currentTime, 8);
    proxy.currentTime = 9;
    assert.equal(second.currentTime, 9);
    proxy.cancelVideoFrameCallback(firstRequest);
    proxy.pause();
    assert.deepEqual(calls, ['first-cancel-41', 'second-pause']);
});

test('candidate handoff rebinds the current media without pausing the old session first', () => {
    const calls = [];
    const parent = {child: null};
    const media = name => ({
        name,
        className: `class-${name}`,
        poster: `poster-${name}`,
        preload: 'auto',
        crossOrigin: 'anonymous',
        disableRemotePlayback: false,
        controls: true,
        muted: false,
        volume: 1,
        defaultPlaybackRate: 1,
        playbackRate: 1,
        id: name,
        style: {cssText: name === 'old' ? 'position:absolute;width:75%;' : ''},
        parentNode: parent,
        getAttribute(attribute) { return attribute === 'style' && this.style.cssText ? this.style.cssText : null; },
        setAttribute(attribute, value) { if (attribute === 'style') this.style.cssText = value; },
        removeAttribute(attribute) {
            if (attribute === 'id') this.id = '';
            if (attribute === 'style') this.style.cssText = '';
        },
        replaceWith(next) { parent.child = next; this.parentNode = null; next.parentNode = parent; },
        pause() { calls.push(`${name}-pause`); },
    });
    const previous = media('old');
    const candidate = media('candidate');
    candidate.parentNode = null;
    parent.child = previous;
    let current = previous;
    const promoted = promoteTLVMedia(previous, candidate, (next, old) => {
        assert.equal(current, old);
        current = next;
        calls.push('rebind');
    });
    assert.equal(promoted, candidate);
    assert.equal(current, candidate);
    assert.equal(parent.child, candidate);
    assert.equal(candidate.style.cssText, 'position:absolute;width:75%;');
    assert.deepEqual(calls, ['rebind']);
});

test('failed consumer rebind restores the authoritative media element', () => {
    const parent = {
        child: null,
        insertBefore(media) { this.child = media; media.parentNode = this; },
    };
    const media = name => ({
        name,
        className: '', poster: '', preload: 'auto', crossOrigin: null,
        disableRemotePlayback: false, controls: true, muted: false, volume: 1,
        defaultPlaybackRate: 1, playbackRate: 1, id: name, style: {},
        parentNode: parent,
        getAttribute: () => null,
        setAttribute() {},
        removeAttribute(attribute) { if (attribute === 'id') this.id = ''; },
        replaceWith(next) { parent.child = next; this.parentNode = null; next.parentNode = parent; },
    });
    const previous = media('visible');
    const candidate = media('candidate');
    candidate.parentNode = null;
    parent.child = previous;
    assert.throws(() => promoteTLVMedia(previous, candidate, () => {
        throw new Error('stale media');
    }), /stale media/);
    assert.equal(parent.child, previous);
    assert.equal(previous.id, 'visible');
    assert.equal(candidate.parentNode, null);
});
