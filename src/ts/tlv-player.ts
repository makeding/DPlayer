import * as aribb62js from 'aribb62.js';
import createTlvDemuxModule from 'tlvdemux';

import type * as DPlayerType from './types';

const MiB = 1024n * 1024n;
const CHUNK_SIZE = 2n * MiB;
const INITIAL_PROBE_SIZE = 2n * MiB;
const MAX_PROBE_SIZE = 64n * MiB;
const SEEK_PREROLL_SIZE = 64n * MiB;
const INTERNAL_SEEK_TOLERANCE_SECONDS = 0.05;
const SOURCE_QUEUE_HIGH_BYTES = 4 * 1024 * 1024;

type Module = createTlvDemuxModule.TlvDemuxModule;
type Demuxer = createTlvDemuxModule.TlvDemuxer;

type PlayerBridge = {
    url: string;
    video: HTMLVideoElement;
    mediaPlane: HTMLElement;
    live: boolean;
    source: DPlayerType.TLVSourceOptions;
    options: DPlayerType.TLVOptions;
    subtitleOptions?: aribb62js.B62TTMLRendererOptions;
    subtitleVisible: () => boolean;
    emit: (name: DPlayerType.PlayerEvents, detail?: unknown) => void;
    notice: (message: string) => void;
};

class AppendQueue {
    readonly mime: string;
    private readonly mediaSource: MediaSource;
    private readonly sourceBuffer: SourceBuffer;
    private readonly media: HTMLMediaElement;
    private readonly pending: Uint8Array[] = [];
    private pendingBytes = 0;
    private stopped = false;
    private waiters: Array<() => void> = [];

    constructor(mediaSource: MediaSource, media: HTMLMediaElement, mime: string, onUpdate: () => void) {
        if (!MediaSource.isTypeSupported(mime)) throw new Error(`Unsupported MSE type: ${mime}`);
        this.mime = mime;
        this.mediaSource = mediaSource;
        this.media = media;
        this.sourceBuffer = mediaSource.addSourceBuffer(mime);
        this.sourceBuffer.mode = 'segments';
        this.sourceBuffer.addEventListener('updateend', () => {
            this.pump();
            onUpdate();
        });
        this.sourceBuffer.addEventListener('error', () => this.stop());
        mediaSource.addEventListener('sourceclose', () => this.stop());
    }

    append(data: Uint8Array): void {
        if (this.stopped) return;
        this.pending.push(data);
        this.pendingBytes += data.byteLength;
        this.pump();
    }

    bufferedRanges(): Array<{start: number; end: number}> {
        const result: Array<{start: number; end: number}> = [];
        for (let index = 0; index < this.sourceBuffer.buffered.length; index += 1) {
            result.push({
                start: this.sourceBuffer.buffered.start(index),
                end: this.sourceBuffer.buffered.end(index),
            });
        }
        return result;
    }

    trimBefore(time: number): void {
        if (this.stopped || this.sourceBuffer.updating || !(time > 0) || this.sourceBuffer.buffered.length === 0) return;
        const start = this.sourceBuffer.buffered.start(0);
        const end = Math.min(time, this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1));
        if (end > start + 0.1) this.sourceBuffer.remove(start, end);
    }

    async waitBelow(limit: number): Promise<void> {
        if (this.pendingBytes <= limit || this.stopped) return;
        await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    async waitIdle(): Promise<void> {
        while (!this.stopped && (this.sourceBuffer.updating || this.pending.length > 0)) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
    }

    stop(): void {
        this.stopped = true;
        this.pending.length = 0;
        this.pendingBytes = 0;
        this.resolveWaiters();
    }

    private pump(): void {
        if (this.stopped || this.sourceBuffer.updating || this.pending.length === 0) {
            if (!this.sourceBuffer.updating && this.pending.length === 0) this.resolveWaiters();
            return;
        }
        // Chromium は decoder 初期化失敗や品質・音声切り替えで MediaSource を閉じた直後にも
        // 古い updateend を配送することがある。親から外れた SourceBuffer へ appendBuffer() しない。
        if (this.mediaSource.readyState !== 'open' ||
            Array.from(this.mediaSource.sourceBuffers).includes(this.sourceBuffer) === false) {
            this.stop();
            return;
        }
        const data = this.pending.shift()!;
        this.pendingBytes -= data.byteLength;
        this.sourceBuffer.appendBuffer(new Uint8Array(data).buffer as ArrayBuffer);
        if (this.pendingBytes <= SOURCE_QUEUE_HIGH_BYTES) this.resolveWaiters();
    }

    private resolveWaiters(): void {
        for (const resolve of this.waiters.splice(0)) resolve();
    }
}

function intersectRanges(
    left: Array<{start: number; end: number}>,
    right: Array<{start: number; end: number}>,
): Array<{start: number; end: number}> {
    const result: Array<{start: number; end: number}> = [];
    for (const first of left) {
        for (const second of right) {
            const start = Math.max(first.start, second.start);
            const end = Math.min(first.end, second.end);
            if (end > start) result.push({start, end});
        }
    }
    return result;
}

function timestampMilliseconds(value: bigint | null, timescale: number | null): number | undefined {
    if (value === null || timescale === null || !(timescale > 0)) return undefined;
    return Number(value) * 1000 / timescale;
}

/** Browser MMT/TLV loader, demuxer, MSE bridge, subtitle renderer and receiver host. */
export default class TLVPlayer implements DPlayerType.TLVPlugin {
    readonly tracks: DPlayerType.TLVTrackInfo[] = [];

    private readonly bridge: PlayerBridge;
    private module: Module | null = null;
    private demuxer: Demuxer | null = null;
    private mediaSource: MediaSource | null = null;
    private mediaUrl: string | null = null;
    private queues: AppendQueue[] = [];
    private queueByType = new Map<string, AppendQueue>();
    private renderer: aribb62js.B62TTMLRenderer | null = null;
    private subtitleOverlay: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private generation = 0;
    private sourceSize: bigint | null = null;
    private durationUs: bigint | null = null;
    private selectedTrackIds = new Map<createTlvDemuxModule.TrackKind, bigint>();
    private preferredVideoPacketId: number | null;
    private preferredAudioPacketId: number | null = null;
    private preferredSubtitlePacketId: number | null = null;
    private destroyed = false;
    private internalSeekTarget: number | null = null;
    private seekTimer: number | null = null;
    private playingStarted = false;

    constructor(bridge: PlayerBridge) {
        this.bridge = bridge;
        this.preferredVideoPacketId = bridge.source.videoPacketId ?? null;
        this.bridge.video.addEventListener('seeking', this.handleSeeking);
        void this.initialize();
    }

    selectVideoTrack(packetId: number): void {
        this.preferredVideoPacketId = packetId;
        const track = this.trackByPacket('video', packetId);
        if (!track || !this.demuxer) return;
        this.selectedTrackIds.set('video', track.trackId);
        this.demuxer.selectTrack('video', track.trackId);
        this.bridge.emit('tlv_track_change', {kind: 'video', track});
    }

    async selectAudioTrack(packetId: number): Promise<void> {
        const track = this.trackByPacket('audio', packetId);
        if (!track) return;
        if (this.isMseCompatibleAudioTrack(track) === false) {
            this.bridge.notice('22.2-channel audio is not supported by browser MSE; use the 5.1 or stereo track.');
            return;
        }
        this.preferredAudioPacketId = packetId;
        if (this.selectedTrackIds.get('audio') === track.trackId) return;
        await this.restart(this.bridge.live ? 0 : this.bridge.video.currentTime);
    }

    selectSubtitleTrack(packetId: number): void {
        this.preferredSubtitlePacketId = packetId;
        const track = this.trackByPacket('subtitle', packetId);
        if (!track || !this.demuxer) return;
        this.selectedTrackIds.set('subtitle', track.trackId);
        this.demuxer.selectTrack('subtitle', track.trackId);
        this.renderer?.reset();
        this.bridge.emit('tlv_track_change', {kind: 'subtitle', track});
    }

    applicationEntry(contextId: number): string | null {
        return this.demuxer?.applicationEntry(contextId) ?? null;
    }

    applications(): createTlvDemuxModule.ApplicationState[] {
        return this.demuxer?.applications() ?? [];
    }

    setSubtitleVisible(visible: boolean): void {
        if (!this.subtitleOverlay) return;
        this.subtitleOverlay.style.display = visible ? '' : 'none';
        if (!visible) this.subtitleOverlay.replaceChildren();
        else this.renderer?.render();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.generation += 1;
        if (this.seekTimer !== null) window.clearTimeout(this.seekTimer);
        this.bridge.video.removeEventListener('seeking', this.handleSeeking);
        this.abortController?.abort();
        this.demuxer?.delete();
        this.demuxer = null;
        this.renderer?.destroy();
        this.renderer = null;
        this.subtitleOverlay?.remove();
        this.subtitleOverlay = null;
        this.releaseMediaSource();
    }

    private async initialize(): Promise<void> {
        try {
            this.module = await createTlvDemuxModule();
            if (this.destroyed) return;
            await this.restart(0);
            if (!this.destroyed) this.bridge.emit('tlv_ready', this);
        } catch (error) {
            this.fail(error);
        }
    }

    private async restart(startTimeSeconds: number): Promise<void> {
        if (!this.module || this.destroyed) return;
        const generation = ++this.generation;
        this.abortController?.abort();
        const controller = new AbortController();
        this.abortController = controller;
        this.demuxer?.delete();
        this.demuxer = null;
        this.releaseMediaSource();
        this.tracks.length = 0;
        this.selectedTrackIds.clear();
        this.playingStarted = false;
        this.createSubtitleRenderer();

        try {
            if (!this.bridge.live) {
                this.sourceSize = this.bridge.source.fileSize ? BigInt(this.bridge.source.fileSize) : await this.discoverSourceSize(controller.signal);
                if (this.durationUs === null) this.durationUs = await this.probeDuration(this.sourceSize, controller.signal);
            }
            if (generation !== this.generation) return;
            await this.openMediaSource();
            if (this.mediaSource && !this.bridge.live && this.durationUs !== null) {
                this.mediaSource.duration = Number(this.durationUs) / 1000000;
            } else if (this.mediaSource && this.bridge.live) {
                this.mediaSource.duration = Infinity;
            }
            await this.consumeSource(startTimeSeconds, generation, controller.signal);
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError') && generation === this.generation) this.fail(error);
        }
    }

    private async openMediaSource(): Promise<void> {
        const mediaSource = new MediaSource();
        this.mediaSource = mediaSource;
        this.mediaUrl = URL.createObjectURL(mediaSource);
        this.bridge.video.src = this.mediaUrl;
        await new Promise<void>((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', () => resolve(), {once: true});
            mediaSource.addEventListener('sourceclose', () => reject(new Error('MediaSource closed before opening.')), {once: true});
        });
    }

    private async consumeSource(startTimeSeconds: number, generation: number, signal: AbortSignal): Promise<void> {
        const pendingInits = new Map<string, createTlvDemuxModule.MseTrackInit>();
        const pendingSegments = new Map<string, Uint8Array[]>([['video', []], ['audio', []]]);
        let callbackError: unknown = null;
        // VOD シークでは先頭をインデックス作成用に読む一方、その区間の media segment は再生してはいけない。
        // ただし MSE 出力全体を無効にすると audio init まで失われ、SourceBuffer を作れないままファイル末尾まで
        // Range 読み込みを続けてしまうため、init だけを保持して media segment は明示的に捨てる。
        let discardPendingSegments = startTimeSeconds > 0;
        let selectedSubtitleTrack: createTlvDemuxModule.TrackInfo | null = null;
        let seekRap: {seconds: number; restartOffset: bigint} | null = null;
        let seekProbe = startTimeSeconds > 0;

        const installInits = (): void => {
            if (!this.mediaSource || this.queueByType.size > 0 || !pendingInits.has('video') || !pendingInits.has('audio')) return;
            for (const type of ['video', 'audio']) {
                const init = pendingInits.get(type)!;
                const queue = new AppendQueue(this.mediaSource, this.bridge.video, init.mime, () => this.maybeStartPlayback());
                this.queueByType.set(type, queue);
                this.queues.push(queue);
                queue.append(init.data);
                for (const segment of pendingSegments.get(type) ?? []) queue.append(segment);
                pendingSegments.set(type, []);
            }
        };
        const appendSegment = (type: string, data: Uint8Array): void => {
            if (discardPendingSegments) return;
            const queue = this.queueByType.get(type);
            if (queue) queue.append(data);
            else pendingSegments.get(type)?.push(data);
        };

        const demuxer = new this.module!.TlvDemuxer({
            onMseInit: init => {
                try {
                    const queue = this.queueByType.get(init.type);
                    if (queue) {
                        if (queue.mime !== init.mime) throw new Error(`TLV codec changed: ${queue.mime} -> ${init.mime}`);
                        queue.append(init.data);
                    } else {
                        pendingInits.set(init.type, init);
                        installInits();
                    }
                } catch (error) {
                    callbackError = error;
                }
            },
            onMseSegment: segment => {
                try {
                    appendSegment(segment.type, segment.data);
                } catch (error) {
                    callbackError = error;
                }
            },
            onTrack: track => {
                // MMT のテーブル更新で同じトラックが再通知されることがある。
                // packet_id は同一 service 内のトラック識別子なので、既存項目を更新して重複させない。
                const track_index = this.tracks.findIndex(candidate => candidate.packetId === track.packetId);
                if (track_index === -1) this.tracks.push(track);
                else this.tracks[track_index] = track;
                if (track.kind === 'video' && !this.selectedTrackIds.has('video') &&
                    (this.preferredVideoPacketId === null || track.packetId === this.preferredVideoPacketId)) {
                    this.selectedTrackIds.set('video', track.trackId);
                    demuxer.selectTrack('video', track.trackId);
                    if (this.durationUs !== null) demuxer.setIndexDuration(this.durationUs);
                } else if (track.kind === 'audio' && !this.selectedTrackIds.has('audio') &&
                    (this.preferredAudioPacketId === null ? this.isMseCompatibleAudioTrack(track) :
                        track.packetId === this.preferredAudioPacketId)) {
                    this.selectedTrackIds.set('audio', track.trackId);
                    demuxer.selectTrack('audio', track.trackId);
                } else if (track.kind === 'subtitle' && track.codec === 'ttml' && !this.selectedTrackIds.has('subtitle') &&
                    (this.preferredSubtitlePacketId === null || track.packetId === this.preferredSubtitlePacketId)) {
                    this.selectedTrackIds.set('subtitle', track.trackId);
                    selectedSubtitleTrack = track;
                    demuxer.selectTrack('subtitle', track.trackId);
                }
                this.bridge.emit('tlv_tracks', [...this.tracks]);
            },
            onAccessUnitView: unit => {
                try {
                    if (seekProbe && unit.trackId === this.selectedTrackIds.get('video') && unit.randomAccess && seekRap === null) {
                        seekRap = {
                            seconds: Number(unit.ptsValue) / unit.ptsTimescale,
                            restartOffset: unit.restartOffset,
                        };
                    }
                    if (unit.trackId === this.selectedTrackIds.get('subtitle') && selectedSubtitleTrack && this.renderer) {
                        if (unit.discontinuity) this.renderer.reset();
                        this.renderer.push({
                            packetId: selectedSubtitleTrack.packetId,
                            mpuSequenceNumber: unit.mpuSequenceNumber ?? undefined,
                            pts: timestampMilliseconds(unit.ptsValue, unit.ptsTimescale),
                            dts: timestampMilliseconds(unit.dtsValue, unit.dtsTimescale),
                            subtitleTimingMode: selectedSubtitleTrack.subtitle?.timingMode,
                            subtitleReferenceStartMediaTime: timestampMilliseconds(
                                unit.subtitleReferenceStartPtsValue,
                                unit.subtitleReferenceStartPtsTimescale,
                            ),
                            data: unit.data,
                            len: unit.data.byteLength,
                            resources: unit.subtitleResources.map(resource => ({
                                index: resource.subsampleNumber,
                                dataType: resource.dataType,
                                data: resource.data,
                            })),
                        });
                    }
                } catch (error) {
                    callbackError = error;
                }
            },
            onBroadcastClock: clock => this.bridge.emit('tlv_broadcast_clock', clock),
            onEventInfo: event => this.bridge.emit('tlv_event_info', event),
            onApplicationResource: resource => this.bridge.emit('tlv_application_resource', resource),
            onApplicationState: state => this.bridge.emit('tlv_application_state', state),
            onApplicationResourcesReset: () => this.bridge.emit('tlv_application_resources_reset'),
            onError: error => {
                if (!error.recoverable) callbackError = new Error(error.message);
            },
        });
        this.demuxer = demuxer;
        demuxer.startIndex(this.bridge.live);

        let offset = 0n;
        if (!this.bridge.live && startTimeSeconds > 0 && this.sourceSize !== null && this.durationUs !== null) {
            const headSize = this.sourceSize < 64n * MiB ? this.sourceSize : 64n * MiB;
            for (let headOffset = 0n;
                 headOffset < headSize && (!pendingInits.has('video') || !pendingInits.has('audio'));
                 headOffset += CHUNK_SIZE) {
                const size = headSize - headOffset < CHUNK_SIZE ? headSize - headOffset : CHUNK_SIZE;
                if (!demuxer.push(await this.fetchRange(headOffset, size, signal))) throw new Error('TLV head parsing failed.');
                this.drainApplications(demuxer, generation);
                if (callbackError) throw callbackError;
            }
            if (!pendingInits.has('video') || !pendingInits.has('audio')) {
                throw new Error('TLV head parsing found no MSE audio/video initialization pair.');
            }
            demuxer.setMseOutputEnabled(false);
            const targetUs = BigInt(Math.round(startTimeSeconds * 1000000));
            const estimate = demuxer.estimateOffset(targetUs, this.sourceSize);
            if (estimate === null) throw new Error('TLV seek offset could not be estimated.');
            const candidate = estimate > SEEK_PREROLL_SIZE ? estimate - SEEK_PREROLL_SIZE : 0n;
            demuxer.reposition(candidate, true);
            let probeOffset = candidate;
            const probeEnd = candidate + SEEK_PREROLL_SIZE < this.sourceSize ? candidate + SEEK_PREROLL_SIZE : this.sourceSize;
            while (seekRap === null && probeOffset < probeEnd) {
                const size = probeEnd - probeOffset < CHUNK_SIZE ? probeEnd - probeOffset : CHUNK_SIZE;
                if (!demuxer.push(await this.fetchRange(probeOffset, size, signal))) throw new Error('TLV seek probe failed.');
                probeOffset += size;
            }
            const resolvedSeekRap = seekRap as {seconds: number; restartOffset: bigint} | null;
            if (resolvedSeekRap === null) throw new Error('TLV seek found no random access point.');
            offset = resolvedSeekRap.restartOffset;
            seekProbe = false;
            demuxer.reposition(offset, true);
            discardPendingSegments = false;
            demuxer.setMseOutputEnabled(true);
            // seeking イベントは currentTime 代入の呼び出しスタックより後で配送される。
            // 真偽値を直後に戻すと内部位置合わせをユーザー操作と誤認して restart() が無限に連鎖するため、
            // 次に届く同じ目標値のイベントを明示的に 1 回だけ無視する。
            this.internalSeekTarget = startTimeSeconds;
            this.bridge.video.currentTime = startTimeSeconds;
        }

        if (this.bridge.live) {
            const response = await this.fetch(this.bridge.url, {}, signal);
            if (!response.ok || !response.body) throw new Error(`TLV live request failed: HTTP ${response.status}`);
            const reader = response.body.getReader();
            for (;;) {
                const result = await reader.read();
                if (result.done || generation !== this.generation) break;
                if (!demuxer.push(result.value)) throw new Error('TLV live demux failed.');
                this.drainApplications(demuxer, generation);
                if (callbackError) throw callbackError;
                await this.applyBackpressure();
            }
        } else if (this.sourceSize !== null) {
            while (offset < this.sourceSize && generation === this.generation) {
                const size = this.sourceSize - offset < CHUNK_SIZE ? this.sourceSize - offset : CHUNK_SIZE;
                if (!demuxer.push(await this.fetchRange(offset, size, signal))) throw new Error(`TLV demux failed at ${offset}.`);
                offset += size;
                this.drainApplications(demuxer, generation);
                if (callbackError) throw callbackError;
                await this.applyBackpressure();
            }
        }
        if (generation !== this.generation) return;
        demuxer.flush();
        while (demuxer.drainApplicationResources(256)) await new Promise(resolve => window.setTimeout(resolve, 0));
        if (!this.bridge.live) demuxer.finalizeIndex();
        await Promise.all(this.queues.map(queue => queue.waitIdle()));
        if (this.mediaSource?.readyState === 'open') this.mediaSource.endOfStream();
    }

    private async discoverSourceSize(signal: AbortSignal): Promise<bigint> {
        const response = await this.fetch(this.bridge.url, {
            headers: {Range: 'bytes=0-0'},
        }, signal);
        const contentRange = response.headers.get('Content-Range');
        const match = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
        if (response.status !== 206 || !match) throw new Error('Recorded TLV source does not support byte ranges.');
        return BigInt(match[1]);
    }

    private async probeDuration(sourceSize: bigint, signal: AbortSignal): Promise<bigint> {
        const probe = new this.module!.DurationProbe();
        try {
            if (!probe.begin(sourceSize, {initialRangeSize: INITIAL_PROBE_SIZE, maxRangeSize: MAX_PROBE_SIZE})) {
                throw new Error('TLV duration probe could not start.');
            }
            for (;;) {
                const request = probe.nextRange();
                if (request === null) break;
                const bytes = await this.fetchRange(request.offset, request.length, signal);
                if (!probe.pushRange(request.requestId, request.offset, bytes, true)) {
                    throw new Error('TLV duration probe rejected a byte range.');
                }
            }
            const duration = probe.duration();
            if (!duration || probe.state() !== 'complete') throw new Error(`TLV duration is unavailable: ${probe.failure()}`);
            return duration.value * 1000000n / BigInt(duration.timescale);
        } finally {
            probe.delete();
        }
    }

    private async fetchRange(offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array> {
        const end = offset + length - 1n;
        const response = await this.fetch(this.bridge.url, {
            headers: {Range: `bytes=${offset}-${end}`},
        }, signal);
        if (response.status !== 206) throw new Error(`TLV Range request failed: HTTP ${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (BigInt(data.byteLength) !== length) throw new Error(`TLV Range length mismatch at ${offset}.`);
        return data;
    }

    private fetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
        const configured = this.bridge.options.fetch ?? {};
        const headers = new Headers(configured.headers);
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        return window.fetch(url, {...configured, ...init, headers, signal});
    }

    private drainApplications(demuxer: Demuxer, generation: number): void {
        const run = (): void => {
            if (generation !== this.generation || this.destroyed) return;
            if (demuxer.drainApplicationResources(32)) window.setTimeout(run, 0);
        };
        window.setTimeout(run, 0);
    }

    private createSubtitleRenderer(): void {
        this.renderer?.destroy();
        this.subtitleOverlay?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'dplayer-aribb62-subtitle';
        Object.assign(overlay.style, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
            overflow: 'hidden',
            display: this.bridge.subtitleVisible() ? '' : 'none',
        });
        this.bridge.mediaPlane.append(overlay);
        this.subtitleOverlay = overlay;
        this.renderer = new aribb62js.B62TTMLRenderer({
            ...(this.bridge.subtitleOptions ?? {}),
            mediaElement: this.bridge.video,
            overlayElement: overlay,
            isLive: this.bridge.live,
        });
        this.renderer.render();
    }

    private maybeStartPlayback(): void {
        if (this.playingStarted || this.queues.length < 2) return;
        let ranges: Array<{start: number; end: number}> | null = null;
        for (const queue of this.queues) {
            ranges = ranges === null ? queue.bufferedRanges() : intersectRanges(ranges, queue.bufferedRanges());
            if (ranges.length === 0) return;
        }
        if (ranges === null) return;
        const range = ranges.find(item => item.end > this.bridge.video.currentTime + 0.001);
        if (!range) return;
        if (this.bridge.live && range.end - Math.max(range.start, this.bridge.video.currentTime) < 0.5) return;
        if (this.bridge.video.currentTime < range.start) {
            this.internalSeekTarget = range.start;
            this.bridge.video.currentTime = range.start;
        }
        this.playingStarted = true;
        void this.bridge.video.play().catch(() => undefined);
    }

    private async applyBackpressure(): Promise<void> {
        const backBuffer = this.bridge.options.backBufferSeconds ?? (this.bridge.live ? 45 : 8);
        for (const queue of this.queues) queue.trimBefore(this.bridge.video.currentTime - backBuffer);
        await Promise.all(this.queues.map(queue => queue.waitBelow(SOURCE_QUEUE_HIGH_BYTES)));
        const high = this.bridge.options.forwardBufferSeconds ?? (this.bridge.live ? 8 : 15);
        while (!this.destroyed && this.bufferedAhead() > high) {
            await new Promise(resolve => window.setTimeout(resolve, 200));
        }
    }

    private bufferedAhead(): number {
        const time = this.bridge.video.currentTime;
        for (let index = 0; index < this.bridge.video.buffered.length; index += 1) {
            if (this.bridge.video.buffered.start(index) <= time && this.bridge.video.buffered.end(index) >= time) {
                return this.bridge.video.buffered.end(index) - time;
            }
        }
        return 0;
    }

    private isMseCompatibleAudioTrack(track: DPlayerType.TLVTrackInfo): boolean {
        // ARIB の 22.2ch トラック (channel_configuration=14) は fMP4 上 13 channels の AAC になるが、
        // 現行ブラウザの MSE audio decoder は受け付けない。8K 放送に併送される 5.1ch/2ch を使う。
        return track.audio?.channelLayout !== 14;
    }

    private releaseMediaSource(): void {
        for (const queue of this.queues) queue.stop();
        this.queues = [];
        this.queueByType.clear();
        if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
        this.mediaUrl = null;
        this.mediaSource = null;
        this.bridge.video.removeAttribute('src');
        this.bridge.video.load();
    }

    private trackByPacket(kind: createTlvDemuxModule.TrackKind, packetId: number): DPlayerType.TLVTrackInfo | undefined {
        return this.tracks.find(track => track.kind === kind && track.packetId === packetId);
    }

    private readonly handleSeeking = (): void => {
        if (this.bridge.live || this.destroyed) return;
        const target = this.bridge.video.currentTime;
        if (this.internalSeekTarget !== null) {
            const internalSeekTarget = this.internalSeekTarget;
            this.internalSeekTarget = null;
            if (Math.abs(target - internalSeekTarget) <= INTERNAL_SEEK_TOLERANCE_SECONDS) return;
        }
        for (let index = 0; index < this.bridge.video.buffered.length; index += 1) {
            if (this.bridge.video.buffered.start(index) <= target && this.bridge.video.buffered.end(index) >= target + 0.1) return;
        }
        if (this.seekTimer !== null) window.clearTimeout(this.seekTimer);
        this.seekTimer = window.setTimeout(() => {
            this.seekTimer = null;
            void this.restart(target);
        }, 100);
    };

    private fail(error: unknown): void {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.bridge.emit('tlv_error', normalized);
        this.bridge.notice(normalized.message);
    }
}
