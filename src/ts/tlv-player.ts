import * as aribb62js from 'aribb62.js';
import type createTlvDemuxModule from 'tlvdemux';
import {MseAppendQueue, finalizeMseMediaSource} from 'tlvdemux/mse-append-queue';

import type * as DPlayerType from './types';
import HlgSdrRenderer from './hlg-sdr-demo-renderer';
import {TlvWorkerClient, WorkerDemuxer} from './tlv-worker-client';

const MiB = 1024n * 1024n;
const CHUNK_SIZE = 2n * MiB;
const INITIAL_PROBE_SIZE = 2n * MiB;
const MAX_PROBE_SIZE = 64n * MiB;
const SEEK_PREROLL_SIZE = 64n * MiB;
const SOURCE_QUEUE_HIGH_BYTES = 4 * 1024 * 1024;
const LIVE_CHUNK_TARGET_BYTES = 512 * 1024;
const LIVE_CHUNK_MAX_DELAY_MILLISECONDS = 25;

type Demuxer = WorkerDemuxer;
type BrowserMediaSourceConstructor = typeof MediaSource;

function joinChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
    if (chunks.length === 1) return chunks[0];
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function* coalesceLiveStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
    let pendingRead = reader.read();
    let chunks: Uint8Array[] = [];
    let chunkBytes = 0;
    let flushDeadline = 0;
    const flush = (): Uint8Array => {
        const output = joinChunks(chunks, chunkBytes);
        chunks = [];
        chunkBytes = 0;
        flushDeadline = 0;
        return output;
    };

    try {
        for (;;) {
            let result: {kind: 'read'; value: ReadableStreamReadResult<Uint8Array>} | {kind: 'deadline'};
            if (chunkBytes === 0) {
                result = {kind: 'read', value: await pendingRead};
            } else {
                const remaining = Math.max(0, flushDeadline - performance.now());
                result = await Promise.race([
                    pendingRead.then(value => ({kind: 'read' as const, value})),
                    new Promise<{kind: 'deadline'}>(resolve => window.setTimeout(
                        () => resolve({kind: 'deadline'}), remaining,
                    )),
                ]);
            }
            if (result.kind === 'deadline') {
                yield flush();
                continue;
            }

            const {done, value} = result.value;
            if (done) {
                if (chunkBytes !== 0) yield flush();
                break;
            }
            pendingRead = reader.read();
            if (!value.byteLength) continue;
            if (chunkBytes === 0 && value.byteLength >= LIVE_CHUNK_TARGET_BYTES) {
                yield value;
                continue;
            }
            if (chunkBytes === 0) flushDeadline = performance.now() + LIVE_CHUNK_MAX_DELAY_MILLISECONDS;
            chunks.push(value);
            chunkBytes += value.byteLength;
            if (chunkBytes >= LIVE_CHUNK_TARGET_BYTES) yield flush();
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

// iOS/iPadOS expose MSE through ManagedMediaSource instead of MediaSource.
// Both APIs implement the same SourceBuffer-facing surface used below.
const BrowserManagedMediaSource = (globalThis as typeof globalThis & {
    ManagedMediaSource?: BrowserMediaSourceConstructor;
}).ManagedMediaSource;
const BrowserMediaSource = BrowserManagedMediaSource ?? globalThis.MediaSource;

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

type LayerSwitchRequest = {
    demuxer: Demuxer;
    generation: number;
    videoTrack: DPlayerType.TLVTrackInfo;
    audioTrack: DPlayerType.TLVTrackInfo;
    resolve: () => void;
    reject: (error: Error) => void;
};

function selectionLevel(track: DPlayerType.TLVTrackInfo, groupIdentification: number | null = null): number | null {
    const group = track.assetGroups.find(candidate =>
        (groupIdentification === null || candidate.groupIdentification === groupIdentification));
    if (group) return group.selectionLevel;
    return track.kind === 'video' && groupIdentification === null && track.assetGroups.length === 0 ? 0 : null;
}

function sameVideoLayerGroup(left: DPlayerType.TLVTrackInfo, right: DPlayerType.TLVTrackInfo): boolean {
    if (left.kind !== 'video' || right.kind !== 'video' || left.contextId !== right.contextId) return false;
    if (!left.assetGroups.length || !right.assetGroups.length) return true;
    return left.assetGroups.some(leftGroup => right.assetGroups.some(rightGroup =>
        leftGroup.groupIdentification === rightGroup.groupIdentification));
}

function correspondingAudioTrack(
    tracks: DPlayerType.TLVTrackInfo[],
    current: DPlayerType.TLVTrackInfo,
    targetLevel: number | null,
): DPlayerType.TLVTrackInfo | null {
    if (targetLevel === null) return null;
    const groupIds = current.assetGroups.map(group => group.groupIdentification);
    for (const groupId of groupIds) {
        const track = tracks.find(candidate => candidate.kind === 'audio' && candidate.assetGroups.some(group =>
            group.groupIdentification === groupId && group.selectionLevel === targetLevel));
        if (track) return track;
    }
    return null;
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
    private worker: TlvWorkerClient | null = null;
    private workerReady = false;
    private demuxer: Demuxer | null = null;
    private mediaSource: MediaSource | null = null;
    private mediaUrl: string | null = null;
    private queues: MseAppendQueue[] = [];
    private queueByType = new Map<string, MseAppendQueue>();
    private renderer: aribb62js.B62TTMLRenderer | null = null;
    private readonly hlgSdrRenderer: HlgSdrRenderer;
    private subtitleOverlay: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private generation = 0;
    private sourceSize: bigint | null = null;
    private durationUs: bigint | null = null;
    private currentLayoutConfiguration: createTlvDemuxModule.LayoutConfiguration | null = null;
    private selectedTrackIds = new Map<createTlvDemuxModule.TrackKind, bigint>();
    private preferredVideoPacketId: number | null;
    private preferredAudioPacketId: number | null = null;
    private preferredSubtitlePacketId: number | null = null;
    private suppressedSubtitleComponentTags = new Set<number>();
    private destroyed = false;
    private playingStarted = false;
    private pendingSeekTime: number | null = null;
    private audioSwitchPending = false;
    private audioSwitchError: Error | null = null;
    private layerSwitchPending: LayerSwitchRequest | null = null;
    private automaticLayerPairSignature: string | null = null;
    private toneMappingMode: createTlvDemuxModule.MseToneMappingMode = 'auto';
    private videoProperties: createTlvDemuxModule.MseVideoProperties | null = null;

    constructor(bridge: PlayerBridge) {
        this.bridge = bridge;
        this.preferredVideoPacketId = bridge.source.videoPacketId ?? null;
        this.hlgSdrRenderer = new HlgSdrRenderer(bridge.video, bridge.mediaPlane);
        void this.initialize();
    }

    async seek(time: number): Promise<void> {
        // TLV のシークは DPlayer の seeking/buffered 状態推測を経由させず、UI から明示された時刻を
        // そのまま TLV ローダーへ 1 回だけ渡す。串流の再構築と Range 制御は TLVPlayer 側だけが所有する。
        if (this.bridge.live || this.destroyed) return;
        // tlvdemux WASM のロード中に受け取った初回位置は捨てず、初回の MSE 構築に直接使う。
        // これにより 0 秒の串流を一度開始してから再シークする競合自体を発生させない。
        if (!this.workerReady) {
            this.pendingSeekTime = time;
            return;
        }
        await this.restart(time);
    }

    selectVideoTrack(packetId: number): void {
        if (this.layerSwitchPending) throw new Error('Another A/V layer switch is still in progress.');
        this.preferredVideoPacketId = packetId;
        const track = this.trackByPacket('video', packetId);
        if (!track || !this.demuxer) return;
        const demuxer = this.demuxer;
        this.selectedTrackIds.set('video', track.trackId);
        void demuxer.selectTrack('video', track.trackId).catch(error => {
            if (this.demuxer === demuxer && !this.destroyed) this.fail(error);
        });
        this.bridge.emit('tlv_track_change', {kind: 'video', track});
    }

    async selectAudioTrack(packetId: number): Promise<void> {
        const track = this.trackByPacket('audio', packetId);
        if (!track) throw new Error(`Audio track packet_id=0x${packetId.toString(16)} is not available.`);
        if (this.isMseCompatibleAudioTrack(track) === false) {
            throw new Error('22.2-channel audio is not supported by browser MSE; use the 5.1 or stereo track.');
        }
        if (this.selectedTrackIds.get('audio') === track.trackId) return;
        if (this.layerSwitchPending) throw new Error('Another A/V layer switch is still in progress.');
        if (this.audioSwitchPending) throw new Error('Another audio track switch is still in progress.');
        const demuxer = this.demuxer;
        if (!demuxer || !this.queueByType.has('audio')) {
            throw new Error('Audio playback is not ready yet. Wait for playback to start and try again.');
        }

        this.audioSwitchPending = true;
        this.audioSwitchError = null;
        const generation = this.generation;
        try {
            // 候補音声は Worker 側ですでに継続して保持されている。ここで加える 100ms は
            // 読み込み待ちではなく、現在位置より少し先に splice 境界を置くための時間差だけ。
            const earliestPresentationTimeUs = BigInt(Math.round((this.bridge.video.currentTime + 0.1) * 1000000));
            const boundary = await demuxer.switchAudioTrack(track.trackId, earliestPresentationTimeUs);
            if (this.audioSwitchError) throw this.audioSwitchError;
            if (this.demuxer !== demuxer || this.generation !== generation || this.destroyed) return;
            if (boundary === null) {
                throw new Error('The selected audio track is not buffered at the current position yet. Wait briefly and try again.');
            }
            this.preferredAudioPacketId = packetId;
            this.selectedTrackIds.set('audio', track.trackId);
            this.bridge.emit('tlv_track_change', {kind: 'audio', track});
        } finally {
            this.audioSwitchPending = false;
            this.audioSwitchError = null;
        }
    }

    async selectLayer(videoPacketId: number, audioPacketId: number): Promise<void> {
        const videoTrack = this.trackByPacket('video', videoPacketId);
        if (!videoTrack) {
            throw new Error(`Video track packet_id=0x${videoPacketId.toString(16)} is not available.`);
        }
        const audioTrack = this.trackByPacket('audio', audioPacketId);
        if (!audioTrack) {
            throw new Error(`Audio track packet_id=0x${audioPacketId.toString(16)} is not available.`);
        }
        if (!this.isMseCompatibleAudioTrack(audioTrack)) {
            throw new Error('22.2-channel audio is not supported by browser MSE; use the 5.1 or stereo track.');
        }
        if (this.selectedTrackIds.get('video') === videoTrack.trackId) {
            await this.selectAudioTrack(audioPacketId);
            return;
        }
        if (this.layerSwitchPending) throw new Error('Another A/V layer switch is still in progress.');
        if (this.audioSwitchPending) throw new Error('Another audio track switch is still in progress.');
        const demuxer = this.demuxer;
        if (!demuxer || !this.queueByType.has('video') || !this.queueByType.has('audio')) {
            throw new Error('A/V playback is not ready yet. Wait for playback to start and try again.');
        }

        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        const pending: LayerSwitchRequest = {
            demuxer,
            generation: this.generation,
            videoTrack,
            audioTrack,
            resolve: resolveCompletion,
            reject: rejectCompletion,
        };
        this.layerSwitchPending = pending;
        try {
            const earliestPresentationTimeUs = BigInt(
                Math.round((this.bridge.video.currentTime + 0.1) * 1000000),
            );
            if (!await demuxer.switchLayer(
                videoTrack.trackId, audioTrack.trackId, earliestPresentationTimeUs,
            )) {
                throw new Error('The A/V layer switch could not be started.');
            }
            await completion;
        } catch (error) {
            if (this.layerSwitchPending === pending) this.layerSwitchPending = null;
            throw error;
        }
    }

    selectSubtitleTrack(packetId: number): void {
        const track = this.trackByPacket('subtitle', packetId);
        if (!track || !this.demuxer) return;
        if (this.subtitleTrackKind(track) !== 'caption') {
            throw new Error('Character superimpose is not a selectable caption track.');
        }
        this.preferredSubtitlePacketId = packetId;
        const previousTrackId = this.selectedTrackIds.get('subtitle');
        const previousTrack = this.tracks.find(candidate => candidate.trackId === previousTrackId);
        const demuxer = this.demuxer;
        this.selectedTrackIds.set('subtitle', track.trackId);
        void demuxer.selectTrack('subtitle', track.trackId).catch(error => {
            if (this.demuxer === demuxer && !this.destroyed) this.fail(error);
        });
        if (previousTrack && previousTrack.trackId !== track.trackId &&
            this.subtitleTrackKind(previousTrack) === 'caption') {
            this.renderer?.clearTrack(previousTrack.packetId);
        }
        this.bridge.emit('tlv_track_change', {kind: 'subtitle', track});
    }

    setToneMappingMode(mode: createTlvDemuxModule.MseToneMappingMode): void {
        this.toneMappingMode = mode;
        const demuxer = this.demuxer;
        if (!demuxer) {
            this.updateHlgSdrRenderer();
            return;
        }
        void demuxer.setMseToneMappingMode(mode).then(() => {
            if (this.demuxer === demuxer && !this.destroyed) this.updateHlgSdrRenderer();
        }).catch(error => {
            if (this.demuxer === demuxer && !this.destroyed) this.fail(error);
        });
    }

    applicationEntry(contextId: number): string | null {
        return this.demuxer?.applicationEntry(contextId) ?? null;
    }

    applications(): createTlvDemuxModule.ApplicationState[] {
        return this.demuxer?.applications() ?? [];
    }

    broadcastClock(): createTlvDemuxModule.BroadcastClock | null {
        return this.demuxer?.broadcastClock() ?? null;
    }

    layoutConfiguration(): createTlvDemuxModule.LayoutConfiguration | null {
        return this.currentLayoutConfiguration;
    }

    applicationResources(contextId?: number): createTlvDemuxModule.ApplicationResourceMetadata[] {
        return this.demuxer?.applicationResources(contextId) ?? [];
    }

    applicationResource(contextId: number, path: string): createTlvDemuxModule.ApplicationResource | null {
        return this.demuxer?.applicationResource(contextId, path) ?? null;
    }

    setSubtitleSuppressedComponentTags(componentTags: number[]): void {
        this.suppressedSubtitleComponentTags = new Set(componentTags
            .map(Number)
            .filter(tag => Number.isInteger(tag) && tag >= 0 && tag <= 0xffff)
            .map(tag => tag & 0xff));
        this.tracks.filter(track => track.kind === 'subtitle' &&
            this.suppressedSubtitleComponentTags.has(track.componentTag & 0xff))
            .forEach(track => this.renderer?.clearTrack(track.packetId));
    }

    setSubtitleVisible(visible: boolean): void {
        this.renderer?.setTrackVisibility('caption', visible);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.rejectLayerSwitch(new DOMException('TLV playback was destroyed.', 'AbortError'));
        this.destroyed = true;
        this.generation += 1;
        this.abortController?.abort();
        this.demuxer?.delete();
        this.demuxer = null;
        this.worker?.close();
        this.worker = null;
        this.renderer?.destroy();
        this.renderer = null;
        this.subtitleOverlay?.remove();
        this.subtitleOverlay = null;
        this.hlgSdrRenderer.destroy();
        this.releaseMediaSource();
    }

    private async initialize(): Promise<void> {
        try {
            if (typeof Worker === 'undefined') throw new Error('This browser does not support Web Workers.');
            this.worker = new TlvWorkerClient();
            await this.worker.ready;
            this.workerReady = true;
            if (this.destroyed) return;
            // WASM のロード中に要求された視聴履歴位置があれば、0 秒を経由せずその位置から開始する。
            const initialSeekTime = this.pendingSeekTime ?? 0;
            this.pendingSeekTime = null;
            await this.restart(initialSeekTime);
            if (!this.destroyed) this.bridge.emit('tlv_ready', this);
        } catch (error) {
            if (this.destroyed) return;
            this.workerReady = false;
            this.worker?.close();
            this.worker = null;
            if (error instanceof DOMException && error.name === 'SecurityError') {
                this.fail(new Error("TLV Worker was blocked by browser policy; allow blob: in Content-Security-Policy worker-src."));
            } else {
                this.fail(error);
            }
        }
    }

    private async restart(startTimeSeconds: number): Promise<void> {
        if (!this.workerReady || this.destroyed) return;
        this.rejectLayerSwitch(new DOMException('TLV playback was restarted.', 'AbortError'));
        const generation = ++this.generation;
        this.abortController?.abort();
        const controller = new AbortController();
        this.abortController = controller;
        this.demuxer?.delete();
        this.demuxer = null;
        this.releaseMediaSource();
        this.tracks.length = 0;
        this.selectedTrackIds.clear();
        this.videoProperties = null;
        this.updateHlgSdrRenderer();
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
        if (!BrowserMediaSource) throw new Error('Media Source Extensions are not supported.');
        const mediaSource = new BrowserMediaSource();
        // Register before attaching the object URL. WebKit may transition to
        // open before code after setting video.src gets another turn.
        const opened = new Promise<void>((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', () => resolve(), {once: true});
            mediaSource.addEventListener('sourceclose', () => reject(new Error('MediaSource closed before opening.')), {once: true});
        });
        this.mediaSource = mediaSource;
        this.mediaUrl = URL.createObjectURL(mediaSource);
        // WebKit only activates ManagedMediaSource when an AirPlay fallback is
        // present or remote playback is explicitly disabled. Raw TLV has no
        // native AirPlay source, so opt out before attaching the object URL.
        if (BrowserManagedMediaSource && mediaSource instanceof BrowserManagedMediaSource) {
            this.bridge.video.disableRemotePlayback = true;
        }
        this.bridge.video.src = this.mediaUrl;
        await opened;
    }

    private async consumeSource(startTimeSeconds: number, generation: number, signal: AbortSignal): Promise<void> {
        const pendingInits = new Map<string, createTlvDemuxModule.MseTrackInit>();
        const pendingSegments = new Map<string, createTlvDemuxModule.MseMediaSegment[]>([
            ['video', []],
            ['audio', []],
        ]);
        let callbackError: unknown = null;
        let incompleteInputTail = false;
        // VOD シークでは先頭をインデックス作成用に読む一方、その区間の media segment は再生してはいけない。
        // ただし MSE 出力全体を無効にすると audio init まで失われ、SourceBuffer を作れないままファイル末尾まで
        // Range 読み込みを続けてしまうため、init だけを保持して media segment は明示的に捨てる。
        let discardPendingSegments = startTimeSeconds > 0;
        let headVideoSeen = false;
        let seekRap: {seconds: number; restartOffset: bigint} | null = null;
        // 先頭解析中の RAP をシーク候補として扱うと、どの要求時刻でもファイル先頭付近から再生してしまう。
        // demo と同じく、推定位置へ reposition() した後の明示的な probe 中だけ RAP を採用する。
        let seekProbe = false;
        const active = (): boolean => generation === this.generation && !this.destroyed;

        const installInits = (): void => {
            if (!this.mediaSource || this.queueByType.size > 0 || !pendingInits.has('video') || !pendingInits.has('audio')) return;
            for (const type of ['video', 'audio']) {
                const init = pendingInits.get(type)!;
                const queue = new MseAppendQueue(
                    this.mediaSource,
                    this.bridge.video,
                    init.mime,
                    () => this.maybeStartPlayback(),
                    {
                        backBufferSeconds: this.bridge.options.backBufferSeconds ?? (this.bridge.live ? 45 : 8),
                        forwardBufferHighSeconds: this.bridge.options.forwardBufferSeconds ?? (this.bridge.live ? 8 : 15),
                    },
                );
                this.queueByType.set(type, queue);
                this.queues.push(queue);
                queue.append(init.data);
                for (const segment of pendingSegments.get(type) ?? []) {
                    queue.append(segment.data, {
                        startTimeSeconds: Number(segment.startTimeUs) / 1000000,
                        endTimeSeconds: Number(segment.endTimeUs) / 1000000,
                    });
                }
                pendingSegments.set(type, []);
            }
        };
        const appendSegment = (segment: createTlvDemuxModule.MseMediaSegment): void => {
            if (discardPendingSegments) return;
            const queue = this.queueByType.get(segment.type);
            if (queue) {
                queue.append(segment.data, {
                    startTimeSeconds: Number(segment.startTimeUs) / 1000000,
                    endTimeSeconds: Number(segment.endTimeUs) / 1000000,
                });
            } else {
                pendingSegments.get(segment.type)?.push(segment);
            }
        };

        const demuxer = this.worker!.createDemuxer({
            onMseVideoStart: () => {
                if (!active()) return;
                if (!seekProbe) headVideoSeen = true;
            },
            onMseVideoProperties: properties => {
                if (!active()) return;
                this.videoProperties = properties;
                this.updateHlgSdrRenderer();
            },
            onMseInit: init => {
                if (!active()) return;
                try {
                    const queue = this.queueByType.get(init.type);
                    if (queue) {
                        queue.appendInitialization(init.data, init.mime);
                    } else {
                        pendingInits.set(init.type, init);
                        installInits();
                    }
                } catch (error) {
                    callbackError = error;
                }
            },
            onMseSegment: segment => {
                if (!active()) return;
                try {
                    appendSegment(segment);
                } catch (error) {
                    callbackError = error;
                }
            },
            onMseVideoSplice: splice => {
                if (!active()) return;
                try {
                    const queue = this.queueByType.get('video');
                    if (!queue) throw new Error('Video SourceBuffer is not initialized.');
                    queue.replaceFrom(Number(splice.presentationTimeUs) / 1000000);
                } catch (error) {
                    const normalized = error instanceof Error ? error : new Error(String(error));
                    this.rejectLayerSwitch(normalized);
                    callbackError = normalized;
                }
            },
            onMseAudioSplice: splice => {
                if (!active()) return;
                try {
                    const queue = this.queueByType.get('audio');
                    if (!queue) throw new Error('Audio SourceBuffer is not initialized.');
                    queue.replaceFrom(Number(splice.presentationTimeUs) / 1000000);
                } catch (error) {
                    this.audioSwitchError = error instanceof Error ? error : new Error(String(error));
                    this.rejectLayerSwitch(this.audioSwitchError);
                    callbackError = this.audioSwitchError;
                }
            },
            onMseLayerSwitch: layer => {
                if (!active()) return;
                const pending = this.layerSwitchPending;
                if (!pending || pending.demuxer !== demuxer || pending.generation !== generation ||
                    pending.videoTrack.trackId !== layer.videoTrackId ||
                    pending.audioTrack.trackId !== layer.audioTrackId) return;
                this.layerSwitchPending = null;
                this.preferredVideoPacketId = pending.videoTrack.packetId;
                this.preferredAudioPacketId = pending.audioTrack.packetId;
                this.selectedTrackIds.set('video', pending.videoTrack.trackId);
                this.selectedTrackIds.set('audio', pending.audioTrack.trackId);
                pending.resolve();
                this.bridge.emit('tlv_track_change', {kind: 'video', track: pending.videoTrack});
                this.bridge.emit('tlv_track_change', {kind: 'audio', track: pending.audioTrack});
                this.bridge.emit('tlv_layer_change', {
                    videoTrack: pending.videoTrack,
                    audioTrack: pending.audioTrack,
                    videoPresentationTimeUs: layer.videoPresentationTimeUs,
                    audioPresentationTimeUs: layer.audioPresentationTimeUs,
                } satisfies DPlayerType.TLVLayerChange);
            },
            onTrack: track => {
                if (!active()) return;
                // MMT のテーブル更新で同じトラックが再通知されることがある。
                // packet_id は同一 service 内のトラック識別子なので、既存項目を更新して重複させない。
                const track_index = this.tracks.findIndex(candidate => candidate.packetId === track.packetId);
                if (track_index === -1) this.tracks.push(track);
                else this.tracks[track_index] = track;
                if (track.kind === 'video' && !this.selectedTrackIds.has('video') &&
                    (this.preferredVideoPacketId === null || track.packetId === this.preferredVideoPacketId)) {
                    this.selectedTrackIds.set('video', track.trackId);
                } else if (track.kind === 'audio' && !this.selectedTrackIds.has('audio') &&
                    (this.preferredAudioPacketId === null ? this.isMseCompatibleAudioTrack(track) :
                        track.packetId === this.preferredAudioPacketId)) {
                    this.selectedTrackIds.set('audio', track.trackId);
                } else if (track.kind === 'subtitle' && track.codec === 'ttml') {
                    const trackKind = this.subtitleTrackKind(track);
                    const currentSubtitleTrackId = this.selectedTrackIds.get('subtitle');
                    const currentSubtitleTrack = this.tracks.find(candidate => candidate.trackId === currentSubtitleTrackId);
                    // 文字スーパーは常時 passthrough される独立平面で、字幕選択の対象にはしない。
                    const shouldSelectSubtitle = trackKind === 'caption' &&
                        (this.preferredSubtitlePacketId !== null ?
                            track.packetId === this.preferredSubtitlePacketId :
                            currentSubtitleTrack === undefined);
                    if (shouldSelectSubtitle) {
                        if (currentSubtitleTrack && currentSubtitleTrack.trackId !== track.trackId &&
                            this.subtitleTrackKind(currentSubtitleTrack) === 'caption') {
                            this.renderer?.clearTrack(currentSubtitleTrack.packetId);
                        }
                        this.selectedTrackIds.set('subtitle', track.trackId);
                    }
                }
                this.bridge.emit('tlv_tracks', [...this.tracks]);
                this.configureAutomaticLayerSwitch();
            },
            onAccessUnitView: unit => {
                if (!active()) return;
                try {
                    if (unit.trackId === this.selectedTrackIds.get('video')) {
                        if (seekProbe && unit.randomAccess && seekRap === null) {
                            seekRap = {
                                seconds: Number(unit.ptsValue) / unit.ptsTimescale,
                                restartOffset: unit.restartOffset,
                            };
                        } else if (!seekProbe) {
                            headVideoSeen = true;
                        }
                    }
                    // VOD シーク前の先頭解析・RAP 探索中の字幕は、映像と同様に再生対象ではない。
                    // これを renderer へ渡すと古い字幕時刻が残り、シーク先の字幕が表示されなくなる。
                    const subtitleTrack = this.tracks.find(track => track.trackId === unit.trackId &&
                        track.kind === 'subtitle' && track.codec === 'ttml');
                    if (!discardPendingSegments && subtitleTrack) {
                        this.bridge.emit('tlv_caption_data', {
                            trackId: unit.trackId,
                            packetId: subtitleTrack.packetId,
                            componentTag: unit.componentTag,
                            subtitleType: subtitleTrack.subtitle!.type,
                            subtitleOperationMode: subtitleTrack.subtitle!.operationMode,
                            subtitleTimingMode: unit.subtitleTimingMode,
                            subtitleDisplayMode: subtitleTrack.subtitle!.displayMode,
                            mpuSequenceNumber: unit.mpuSequenceNumber,
                            ptsValue: unit.ptsValue,
                            ptsTimescale: unit.ptsTimescale,
                            dtsValue: unit.dtsValue,
                            dtsTimescale: unit.dtsTimescale,
                            subtitleReferenceStartPtsValue: unit.subtitleReferenceStartPtsValue,
                            subtitleReferenceStartPtsTimescale: unit.subtitleReferenceStartPtsTimescale,
                            // AccessUnit の主 payload は callback-lifetime の WASM view なので、
                            // DPlayer event として公開する前に所有権をブラウザ側へ移す。
                            data: unit.data.slice(),
                            subtitleResources: unit.subtitleResources.map(resource => ({
                                ...resource,
                                data: resource.data.slice(),
                            })),
                            discontinuity: unit.discontinuity,
                        } satisfies DPlayerType.TLVCaptionData);
                    }
                    const shouldRenderSubtitle = subtitleTrack &&
                        (unit.trackId === this.selectedTrackIds.get('subtitle') ||
                            this.subtitleTrackKind(subtitleTrack) === 'superimpose');
                    if (!discardPendingSegments && shouldRenderSubtitle && subtitleTrack && this.renderer) {
                        if (this.suppressedSubtitleComponentTags.has(unit.componentTag & 0xff)) return;
                        if (unit.discontinuity) this.renderer.clearTrack(subtitleTrack.packetId);
                        this.renderer.push({
                            packetId: subtitleTrack.packetId,
                            trackKind: this.subtitleTrackKind(subtitleTrack),
                            componentTag: unit.componentTag,
                            subtitleType: subtitleTrack.subtitle!.type,
                            mpuSequenceNumber: unit.mpuSequenceNumber ?? undefined,
                            pts: timestampMilliseconds(unit.ptsValue, unit.ptsTimescale),
                            dts: timestampMilliseconds(unit.dtsValue, unit.dtsTimescale),
                            subtitleOperationMode: subtitleTrack.subtitle!.operationMode,
                            subtitleTimingMode: subtitleTrack.subtitle!.timingMode,
                            subtitleDisplayMode: subtitleTrack.subtitle!.displayMode,
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
            onBroadcastClock: clock => {
                if (active()) this.bridge.emit('tlv_broadcast_clock', clock);
            },
            onLayoutConfiguration: layout => {
                if (!active()) return;
                this.currentLayoutConfiguration = layout;
                this.bridge.emit('tlv_layout_configuration', layout);
            },
            onServiceStateReset: () => {
                if (!active()) return;
                this.currentLayoutConfiguration = null;
                this.bridge.emit('tlv_layout_configuration', null);
            },
            onEventInfo: event => {
                if (active()) this.bridge.emit('tlv_event_info', event);
            },
            onStreamEvent: event => {
                if (active()) this.bridge.emit('tlv_stream_event', event);
            },
            onViewerParticipationNotification: notification => {
                if (active()) this.bridge.emit('tlv_viewer_participation', notification);
            },
            onApplicationResource: resource => {
                if (active()) this.bridge.emit('tlv_application_resource', resource);
            },
            onApplicationState: state => {
                if (active()) this.bridge.emit('tlv_application_state', state);
            },
            onApplicationResourcesReset: () => {
                if (active()) this.bridge.emit('tlv_application_resources_reset');
            },
            onError: error => {
                if (!active()) return;
                if (!error.recoverable) callbackError = new Error(error.message);
                else if (/^incomplete TLV (header|payload) at end of input$/.test(error.message)) {
                    incompleteInputTail = true;
                }
            },
        }, {
            videoPacketId: this.preferredVideoPacketId,
            audioPacketId: this.preferredAudioPacketId,
            subtitlePacketId: this.preferredSubtitlePacketId,
            mseMaxAudioChannels: 8,
            indexDurationUs: this.durationUs,
        });
        this.demuxer = demuxer;
        await demuxer.initialized();
        this.hlgSdrRenderer.setLut(await demuxer.hlgSdrToneMappingLut());
        await demuxer.setMseToneMappingMode(this.toneMappingMode);
        // データ放送は通常字幕と文字スーパーを component_tag ごとに購読するため、
        // 画面字幕の選択とは独立して全 TTML track をイベントへ流す。
        await demuxer.setSubtitlePassthroughEnabled(true);
        if (!this.bridge.live) await demuxer.startIndex(false);

        let offset = 0n;
        if (!this.bridge.live && startTimeSeconds > 0 && this.sourceSize !== null && this.durationUs !== null) {
            const headSize = this.sourceSize < 64n * MiB ? this.sourceSize : 64n * MiB;
            for (let headOffset = 0n;
                 headOffset < headSize &&
                    (!pendingInits.has('video') || !pendingInits.has('audio') || !headVideoSeen);
                 headOffset += CHUNK_SIZE) {
                const size = headSize - headOffset < CHUNK_SIZE ? headSize - headOffset : CHUNK_SIZE;
                if (!await demuxer.push(await this.fetchRange(headOffset, size, signal))) {
                    throw new Error('TLV head parsing failed.');
                }
                if (callbackError) throw callbackError;
            }
            if (!pendingInits.has('video') || !pendingInits.has('audio') || !headVideoSeen) {
                throw new Error('TLV head parsing found no MSE audio/video initialization pair or video access unit.');
            }
            await demuxer.setMseOutputEnabled(false);
            const targetUs = BigInt(Math.round(startTimeSeconds * 1000000));
            const estimate = await demuxer.estimateOffset(targetUs, this.sourceSize);
            if (estimate === null) throw new Error('TLV seek offset could not be estimated.');
            const candidate = estimate > SEEK_PREROLL_SIZE ? estimate - SEEK_PREROLL_SIZE : 0n;
            seekRap = null;
            seekProbe = true;
            await demuxer.reposition(candidate, true);
            let probeOffset = candidate;
            const probeEnd = candidate + SEEK_PREROLL_SIZE < this.sourceSize ? candidate + SEEK_PREROLL_SIZE : this.sourceSize;
            while (seekRap === null && probeOffset < probeEnd) {
                const size = probeEnd - probeOffset < CHUNK_SIZE ? probeEnd - probeOffset : CHUNK_SIZE;
                if (!await demuxer.push(await this.fetchRange(probeOffset, size, signal))) {
                    throw new Error('TLV seek probe failed.');
                }
                probeOffset += size;
            }
            const resolvedSeekRap = seekRap as {seconds: number; restartOffset: bigint} | null;
            if (resolvedSeekRap === null) throw new Error('TLV seek found no random access point.');
            offset = resolvedSeekRap.restartOffset;
            seekProbe = false;
            await demuxer.reposition(offset, true);
            // 探索中に構築された字幕内部状態を破棄し、シーク先の字幕だけを新しい時刻軸で受け取る。
            this.renderer?.reset();
            discardPendingSegments = false;
            await demuxer.setMseOutputEnabled(true);
            this.bridge.video.currentTime = startTimeSeconds;
        }

        if (this.bridge.live) {
            const response = await this.fetch(this.bridge.url, {}, signal);
            if (!response.ok || !response.body) throw new Error(`TLV live request failed: HTTP ${response.status}`);
            const reader = response.body.getReader();
            for await (const data of coalesceLiveStream(reader)) {
                if (generation !== this.generation) break;
                if (!await demuxer.push(data)) throw new Error('TLV live demux failed.');
                if (callbackError) throw callbackError;
                await this.applyBackpressure();
            }
        } else if (this.sourceSize !== null) {
            while (offset < this.sourceSize && generation === this.generation) {
                const size = this.sourceSize - offset < CHUNK_SIZE ? this.sourceSize - offset : CHUNK_SIZE;
                if (!await demuxer.push(await this.fetchRange(offset, size, signal))) {
                    throw new Error(`TLV demux failed at ${offset}.`);
                }
                offset += size;
                if (callbackError) throw callbackError;
                await this.applyBackpressure();
            }
        }
        if (generation !== this.generation) return;
        await demuxer.flush();
        if (this.layerSwitchPending?.demuxer === demuxer) {
            this.rejectLayerSwitch(new Error('The input ended before the A/V layer switch completed.'));
        }
        if (!this.bridge.live) await demuxer.finalizeIndex();
        if (this.mediaSource) {
            await finalizeMseMediaSource(this.mediaSource, this.queues, {
                truncateToCommonEnd: !this.bridge.live && incompleteInputTail,
            });
        }
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
        const probe = this.worker!.createDurationProbe();
        try {
            if (!await probe.begin(sourceSize, {initialRangeSize: INITIAL_PROBE_SIZE, maxRangeSize: MAX_PROBE_SIZE})) {
                throw new Error('TLV duration probe could not start.');
            }
            for (;;) {
                const request = await probe.nextRange();
                if (request === null) break;
                // Some browser/worker combinations deserialize WebAssembly i64
                // object fields as numbers even though direct embind calls return
                // bigint. Normalize the RPC boundary before doing BigInt arithmetic.
                const requestId = BigInt(request.requestId);
                const offset = BigInt(request.offset);
                const length = BigInt(request.length);
                const bytes = await this.fetchRange(offset, length, signal);
                if (!await probe.pushRange(requestId, offset, bytes, true)) {
                    throw new Error('TLV duration probe rejected a byte range.');
                }
            }
            const duration = await probe.duration();
            const state = await probe.state();
            if (!duration || state !== 'complete') {
                throw new Error(`TLV duration is unavailable: ${await probe.failure()}`);
            }
            return duration.value * 1000000n / BigInt(duration.timescale);
        } finally {
            probe.delete();
        }
    }

    private async fetchRange(offsetValue: bigint | number, lengthValue: bigint | number,
                             signal: AbortSignal): Promise<Uint8Array> {
        const offset = BigInt(offsetValue);
        const length = BigInt(lengthValue);
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
        });
        this.bridge.mediaPlane.append(overlay);
        this.subtitleOverlay = overlay;
        this.renderer = new aribb62js.B62TTMLRenderer({
            ...(this.bridge.subtitleOptions ?? {}),
            mediaElement: this.bridge.video,
            overlayElement: overlay,
            isLive: this.bridge.live,
        });
        this.renderer.setTrackVisibility('caption', this.bridge.subtitleVisible());
        this.renderer.render();
    }

    private updateHlgSdrRenderer(): void {
        const sourceIsHlg = this.videoProperties?.sourceColor?.transfer === 18;
        const enabled = sourceIsHlg && this.toneMappingMode !== 'off' &&
            (this.toneMappingMode === 'force' || this.videoProperties?.sdrInHlg === true);
        this.hlgSdrRenderer.setEnabled(enabled);
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

    private configureAutomaticLayerSwitch(): void {
        const demuxer = this.demuxer;
        if (!demuxer) return;
        if (this.preferredVideoPacketId !== null) {
            if (this.automaticLayerPairSignature !== 'disabled') {
                this.automaticLayerPairSignature = 'disabled';
                void demuxer.clearAutomaticLayerSwitch();
            }
            return;
        }
        const selectedVideo = this.tracks.find(track =>
            track.kind === 'video' && track.trackId === this.selectedTrackIds.get('video'));
        const selectedAudio = this.tracks.find(track =>
            track.kind === 'audio' && track.trackId === this.selectedTrackIds.get('audio'));
        if (!selectedVideo || !selectedAudio) return;
        const videos = this.tracks
            .filter(track => sameVideoLayerGroup(selectedVideo, track))
            .sort((left, right) =>
                (selectionLevel(left) ?? 0xff) - (selectionLevel(right) ?? 0xff));
        const preferredVideo = videos[0];
        const fallbackVideo = videos.find(track =>
            selectionLevel(track) !== null && selectionLevel(track)! > (selectionLevel(preferredVideo) ?? 0xff));
        if (!preferredVideo || !fallbackVideo) return;
        const preferredAudio = correspondingAudioTrack(this.tracks, selectedAudio, selectionLevel(preferredVideo));
        const fallbackAudio = correspondingAudioTrack(this.tracks, selectedAudio, selectionLevel(fallbackVideo));
        if (!preferredAudio || !fallbackAudio) return;
        const signature = [preferredVideo.trackId, preferredAudio.trackId, fallbackVideo.trackId, fallbackAudio.trackId].join(':');
        if (signature === this.automaticLayerPairSignature) return;
        this.automaticLayerPairSignature = signature;
        void demuxer.configureAutomaticLayerSwitch(
            preferredVideo.trackId, preferredAudio.trackId,
            fallbackVideo.trackId, fallbackAudio.trackId,
        );
    }

    private subtitleTrackKind(track: DPlayerType.TLVTrackInfo): 'caption' | 'superimpose' {
        if (track.subtitle?.type === 0) return 'caption';
        if (track.subtitle?.type === 1) return 'superimpose';
        throw new Error(`TTML packet_id=0x${track.packetId.toString(16)} has invalid subtitle.type.`);
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

    private fail(error: unknown): void {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.rejectLayerSwitch(normalized);
        this.bridge.emit('tlv_error', normalized);
        this.bridge.notice(normalized.message);
    }

    private rejectLayerSwitch(error: Error): void {
        const pending = this.layerSwitchPending;
        if (!pending) return;
        this.layerSwitchPending = null;
        pending.reject(error);
    }
}
