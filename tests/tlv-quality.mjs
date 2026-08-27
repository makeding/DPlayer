import assert from 'node:assert/strict';
import test from 'node:test';

import TLVQuality, {installDynamicTLVQualities} from '../src/ts/tlv-quality.ts';
import {
    availableMptTracks,
    resolveTLVLayerPair,
    selectManualTLVLayer,
} from '../src/ts/tlv-layer-selection.ts';
import {visibleQualityCount} from '../src/ts/quality-visibility.ts';
import I18n from '../src/ts/i18n.ts';

const labels = {
    original: 'original',
    preferred: '通常放送',
    fallback: '降雨放送',
};

function track(kind, packetId, trackId, selectionLevel) {
    return {
        kind,
        packetId,
        trackId: BigInt(trackId),
        contextId: 1,
        codec: kind === 'video' ? 'hevc' : 'aac',
        componentTag: packetId & 0xff,
        assetGroups: [{groupIdentification: kind === 'video' ? 0 : 16, selectionLevel}],
        audio: kind === 'audio' ? {channelLayout: 2} : undefined,
    };
}

const preferredVideo = track('video', 0xf300, 1, 0);
const fallbackVideo = track('video', 0xf301, 2, 1);
const preferredAudio = track('audio', 0xf310, 3, 0);
const fallbackAudio = track('audio', 0xf314, 4, 1);
const allTracks = [preferredVideo, fallbackVideo, preferredAudio, fallbackAudio];

function dynamicOptions() {
    return {
        video: {
            type: 'tlv',
            quality: [{name: 'BS4K', url: '/raw.mmts', type: 'tlv'}],
            defaultQuality: 0,
        },
    };
}

function makePlayer() {
    const options = dynamicOptions();
    installDynamicTLVQualities(options, labels);
    const visibility = new Map();
    const notices = [];
    const player = {
        options,
        type: 'tlv',
        qualityIndex: 0,
        quality: options.video.quality[0],
        plugins: {tlv: {
            layerPair: tracks => resolveTLVLayerPair(tracks, preferredVideo, preferredAudio),
        }},
        setting: {setQualityItemVisible: (index, visible) => visibility.set(index, visible)},
        template: {
            qualityValue: {textContent: ''},
            qualityItem: options.video.quality.map((_, index) => ({
                dataset: {index: String(index)},
                classList: {toggle() {}},
            })),
            settingBox: {classList: {remove() {}}},
        },
        selectTLVLayer: async () => {},
        selectTLVAutomaticLayer: async () => {},
        notice: message => notices.push(message),
        tran: text => text,
    };
    const quality = new TLVQuality(player);
    return {player, quality, visibility, notices};
}

test('dynamic TLV sources expand to original/preferred/fallback while explicit packet IDs do not', () => {
    const options = dynamicOptions();
    options.video.quality.push({
        name: 'Fixed', url: '/fixed.mmts', type: 'tlv', tlv: {videoPacketId: 0xf300},
    });
    installDynamicTLVQualities(options, labels);
    assert.deepEqual(options.video.quality.map(quality => quality.name), [
        'BS4K (original)', 'BS4K（通常放送）', 'BS4K（降雨放送）', 'Fixed',
    ]);
    assert.deepEqual(options.video.quality.map(quality => quality.tlvDynamicLayer?.role), [
        'original', 'preferred', 'fallback', undefined,
    ]);
    assert.equal(options.video.defaultQuality, 0);
});

test('only original is initially visible and an MPT-first sequence waits for selectable tracks', () => {
    const {quality, visibility, player} = makePlayer();
    player.plugins.tlv.layerPair = () => null;
    quality.sync({tracks: allTracks, version: 1});
    assert.deepEqual([...visibility], [[0, true], [1, false], [2, false]]);

    player.plugins.tlv.layerPair = tracks => resolveTLVLayerPair(tracks, preferredVideo, preferredAudio);
    quality.tracksChanged();
    assert.deepEqual([...visibility], [[0, true], [1, true], [2, true]]);
});

test('automatic layer changes keep Original selected while manual changes select the fixed row', async () => {
    const {quality, player} = makePlayer();
    quality.sync({tracks: allTracks, version: 1});
    quality.syncSelection({videoTrack: fallbackVideo, audioTrack: fallbackAudio});
    assert.equal(player.qualityIndex, 0);

    assert.equal(quality.select(2), true);
    quality.syncSelection({videoTrack: fallbackVideo, audioTrack: fallbackAudio});
    assert.equal(player.qualityIndex, 2);

    let automaticCalls = 0;
    player.selectTLVAutomaticLayer = async () => { automaticCalls += 1; };
    assert.equal(quality.select(0), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(automaticCalls, 1);
    assert.equal(player.qualityIndex, 0);
});

test('a missing fixed layer restores Original before hiding both manual rows', async () => {
    const {quality, player, visibility} = makePlayer();
    quality.sync({tracks: allTracks, version: 1});
    assert.equal(quality.select(2), true);
    quality.syncSelection({videoTrack: fallbackVideo, audioTrack: fallbackAudio});

    let restored = false;
    player.selectTLVAutomaticLayer = async () => { restored = true; };
    quality.sync({tracks: [preferredVideo, preferredAudio], version: 2});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(restored, true);
    assert.equal(player.qualityIndex, 0);
    assert.deepEqual([...visibility], [[0, true], [1, false], [2, false]]);
});

test('a failed missing-layer restore preserves the visible manual state and reports the error', async () => {
    const {quality, player, visibility, notices} = makePlayer();
    quality.sync({tracks: allTracks, version: 1});
    assert.equal(quality.select(2), true);
    quality.syncSelection({videoTrack: fallbackVideo, audioTrack: fallbackAudio});
    player.selectTLVAutomaticLayer = async () => { throw new Error('automatic restore rejected'); };

    quality.sync({tracks: [preferredVideo, preferredAudio], version: 2});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(player.qualityIndex, 2);
    assert.deepEqual([...visibility], [[0, true], [1, true], [2, true]]);
    assert.match(notices.at(-1), /automatic restore rejected/);
});

test('reset discards the cached MPT and packet IDs', () => {
    const {quality, player, visibility} = makePlayer();
    quality.sync({tracks: allTracks, version: 1});
    quality.reset();
    quality.tracksChanged();
    assert.deepEqual([...visibility], [[0, true], [1, false], [2, false]]);
    for (const entry of player.options.video.quality) {
        assert.equal(entry.tlvDynamicLayer?.videoPacketId, undefined);
        assert.equal(entry.tlvDynamicLayer?.audioPacketId, undefined);
    }
});

test('current MPT tracks are gated by the DPlayer selectable inventory', () => {
    assert.deepEqual(
        availableMptTracks(allTracks, [preferredVideo, preferredAudio]).map(item => item.packetId),
        [0xf300, 0xf310],
    );
});

test('manual selection disables automatic switching and rolls it back after a failed switch', async () => {
    const calls = [];
    await assert.rejects(selectManualTLVLayer(
        async () => { calls.push('disable'); },
        async () => { calls.push('switch'); throw new Error('switch rejected'); },
        async () => { calls.push('restore'); },
    ), /switch rejected/);
    assert.deepEqual(calls, ['disable', 'switch', 'restore']);
});

test('quality menu height counts only visible entries', () => {
    assert.equal(visibleQualityCount([{hidden: false}, {hidden: true}, {hidden: true}]), 1);
    assert.equal(visibleQualityCount([{hidden: false}, {hidden: false}, {hidden: false}]), 3);
});

test('all supported product locales define the three dynamic TLV labels', () => {
    const expected = {
        'en': ['original', 'Normal broadcast', 'Rain broadcast'],
        'zh-cn': ['原始', '通常放送', '降雨放送'],
        'zh-tw': ['原始', '通常放送', '降雨放送'],
        'ja-jp': ['オリジナル', '通常放送', '降雨放送'],
    };
    for (const [locale, labels] of Object.entries(expected)) {
        const translate = new I18n(locale).tran;
        assert.deepEqual(['original', 'Normal broadcast', 'Rain broadcast'].map(translate), labels);
    }
});

test('restart invalidation hides stale rows and cannot revive them from tracks alone', () => {
    const {quality, visibility} = makePlayer();
    quality.sync({tracks: allTracks, version: 1});
    assert.deepEqual([...visibility], [[0, true], [1, true], [2, true]]);
    quality.invalidateSnapshot();
    quality.tracksChanged();
    assert.deepEqual([...visibility], [[0, true], [1, false], [2, false]]);
});
