import assert from 'node:assert/strict';
import test from 'node:test';

import {adoptRecordedTLVDemuxer} from '../src/ts/tlv-recorded-transition.ts';

test('recorded candidate adoption advances offset but retires the old demuxer only after commit', () => {
    const oldDemuxer = {deleted: 0, delete() { this.deleted += 1; }};
    const newDemuxer = {deleted: 0, delete() { this.deleted += 1; }};
    let current = oldDemuxer;
    let offset = 10n;
    let candidateCommitted = false;
    const result = adoptRecordedTLVDemuxer({
        current: () => current,
        candidate: () => ({
            demuxer: newDemuxer,
            tracks: [],
            commit: () => { candidateCommitted = true; },
        }),
        callbacks: {},
        nextOffset: 42n,
        adopt: demuxer => { current = demuxer; },
        setOffset: value => { offset = value; },
    });
    assert.equal(candidateCommitted, true);
    assert.equal(current, newDemuxer);
    assert.equal(offset, 42n);
    assert.equal(oldDemuxer.deleted, 0);
    result.previous.delete();
    assert.equal(oldDemuxer.deleted, 1);
});
