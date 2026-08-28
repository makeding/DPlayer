import * as aribb62js from 'aribb62.js';
import type createTlvDemuxModule from 'tlvdemux';
import type {MseAppendQueue} from 'tlvdemux/mse-append-queue';
import {createMseOutputPipeline} from 'tlvdemux/mse-output-pipeline';
import type {MseOutputPipeline} from 'tlvdemux/mse-output-pipeline';
import {
    createMsePlaybackFlowControl,
    createMseRecordedSeekSession,
    startMsePlayback,
} from 'tlvdemux/mse-playback';
import type {MseRecordedSeekSession} from 'tlvdemux/mse-playback';
import type {RecordedSource} from 'tlvdemux/recorded-source';
import {coalesceReadableStream} from 'tlvdemux/stream-input';
import {correspondingAudioTrack, sameVideoLayerGroup, selectionLevel} from 'tlvdemux/track-selection';
import {createWorkerTlvDemuxModule} from 'tlvdemux/worker-client';
import type {WorkerDemuxer, WorkerTlvDemuxModule} from 'tlvdemux/worker-client';
import tlvDemuxRuntimeSource from 'tlvdemux-runtime-source?runtime-source';
import InlineTlvWorker from 'worker-loader?inline=no-fallback!./tlv-worker-entry';

import type * as DPlayerType from './types';
import HlgSdrRenderer from './hlg-sdr-player-renderer';
import {createTLVDamageRecovery} from './tlv-damage-recovery';
import {startTLVLayerSwitch, tlvPlaybackEntryKind} from './tlv-playback-entry';
import {createTLVSubtitleRenderer, effectiveTLVToneMappingMode} from './tlv-presentation';
import {openTLVRecordedSource, probeTLVRecordedDuration} from './tlv-recorded-source';
import {
    availableMptTracks,
    configureAutomaticTLVLayer,
    resolveTLVLayerPair,
    selectAutomaticTLVLayer,
    selectManualTLVLayer,
} from './tlv-layer-selection';

const MiB = 1024n * 1024n;
const CHUNK_SIZE = 2n * MiB;
const SOURCE_QUEUE_HIGH_BYTES = 4 * 1024 * 1024;
const LIVE_CHUNK_TARGET_BYTES = 512 * 1024;
const LIVE_CHUNK_MAX_DELAY_MILLISECONDS = 25;

type Demuxer = WorkerDemuxer;
type BrowserMediaSourceConstructor = typeof MediaSource;

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
    damageNotice: HTMLElement;
    translate: (text: string) => string;
    invalidateQualitySnapshot: () => void;
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

function timestampMilliseconds(value: bigint | null, timescale: number | null): number | undefined {
    if (value === null || timescale === null || !(timescale > 0)) return undefined;
    return Number(value) * 1000 / timescale;
}

/** Browser MMT/TLV loader, demuxer, MSE bridge, subtitle renderer and receiver host. */
export default class TLVPlayer implements DPlayerType.TLVPlugin {
    readonly tracks: DPlayerType.TLVTrackInfo[] = [];

    private readonly bridge: PlayerBridge;
    private worker: WorkerTlvDemuxModule | null = null;
    private workerRuntimeUrl: string | null = null;
    private workerReady = false;
    private demuxer: Demuxer | null = null;
    private mediaSource: MediaSource | null = null;
    private mediaUrl: string | null = null;
    private queueByType = new Map<string, MseAppendQueue>();
    private renderer: aribb62js.B62TTMLRenderer | null = null;
    private readonly hlgSdrRenderer: HlgSdrRenderer;
    private subtitleOverlay: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private generation = 0;
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
    private automaticLayerConfigurationSequence = 0;
    private currentMptSnapshot: DPlayerType.TLVMptSnapshot | null = null;
    private toneMappingMode: createTlvDemuxModule.MseToneMappingMode = 'auto';
    private hlgSdrColorLut: createTlvDemuxModule.HlgSdrColorLut | null = null;
    private hlgSdrPrototypeColorLut: createTlvDemuxModule.HlgSdrColorLut | null = null;
    private outputState: DPlayerType.TLVOutputState | null = null;
    private pendingOutputEdid: Uint8Array | null = null;
    private pendingOutputConnected: boolean | null = null;
    private videoProperties: createTlvDemuxModule.MseVideoProperties | null = null;
    private readonly damageRecovery;
    private readonly reportedDamage = new Set<string>();
    private readonly waitingListener = (): void => { this.damageRecovery.notifyWaiting(); };
    private readonly playingListener = (): void => {
        if (this.bridge.damageNotice.dataset.state === 'recovered') this.clearDamageNotice();
    };

    constructor(bridge: PlayerBridge) {
        this.bridge = bridge;
        this.preferredVideoPacketId = bridge.source.videoPacketId ?? null;
        this.hlgSdrRenderer = new HlgSdrRenderer(bridge.video, bridge.mediaPlane);
        this.damageRecovery = createTLVDamageRecovery({
            media: bridge.video,
            queues: () => this.queueByType,
            isActive: () => !this.destroyed,
            isCurrentLayer: damage => damage.videoTrackId === this.selectedTrackIds.get('video'),
            switchInFlight: () => this.layerSwitchPending !== null,
            seek: target => {
                bridge.video.currentTime = target;
                this.showDamageNotice('recovered', bridge.translate(
                    'Playback recovered. [TLV_SOURCE_DAMAGE]',
                ));
            },
        });
        bridge.video.addEventListener('waiting', this.waitingListener);
        bridge.video.addEventListener('playing', this.playingListener);
        void this.initialize();
    }

    layerPair(
        tracks: readonly DPlayerType.TLVTrackInfo[] = this.currentMptSnapshot?.tracks ?? [],
    ): DPlayerType.TLVLayerPair | null {
        const currentVideo = this.tracks.find(track =>
            track.kind === 'video' && track.trackId === this.selectedTrackIds.get('video'));
        const currentAudio = this.tracks.find(track =>
            track.kind === 'audio' && track.trackId === this.selectedTrackIds.get('audio'));
        if (!currentVideo || !currentAudio) return null;
        return resolveTLVLayerPair(availableMptTracks(tracks, this.tracks), currentVideo, currentAudio);
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
        this.resetPlaybackDamage();
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
        if (this.layerSwitchPending) throw new Error('Another A/V layer switch is still in progress.');
        if (this.audioSwitchPending) throw new Error('Another audio track switch is still in progress.');
        const demuxer = this.demuxer;
        if (!demuxer) throw new Error('TLV playback is not ready yet.');

        const wasAutomatic = this.preferredVideoPacketId === null;
        await selectManualTLVLayer(
            async () => {
                const sequence = ++this.automaticLayerConfigurationSequence;
                await demuxer.clearAutomaticLayerSwitch();
                if (sequence === this.automaticLayerConfigurationSequence && demuxer === this.demuxer) {
                    this.automaticLayerPairSignature = 'disabled';
                }
            },
            async () => {
                if (this.selectedTrackIds.get('video') === videoTrack.trackId &&
                    this.selectedTrackIds.get('audio') === audioTrack.trackId) return;
                await this.switchLayer(demuxer, videoTrack, audioTrack);
            },
            wasAutomatic ? () => this.configureAutomaticLayerSwitch(true) : undefined,
        );
        this.preferredVideoPacketId = videoTrack.packetId;
        this.preferredAudioPacketId = audioTrack.packetId;
    }

    async selectAutomaticLayer(): Promise<void> {
        const demuxer = this.demuxer;
        if (!demuxer) throw new Error('TLV playback is not ready yet.');
        const previousVideoPacketId = this.preferredVideoPacketId;
        const previousAudioPacketId = this.preferredAudioPacketId;
        const previousVideo = previousVideoPacketId === null ? undefined :
            this.trackByPacket('video', previousVideoPacketId);
        const previousAudio = previousAudioPacketId === null ? undefined :
            this.trackByPacket('audio', previousAudioPacketId);
        await selectAutomaticTLVLayer({
            pair: this.layerPair(),
            currentVideoTrackId: this.selectedTrackIds.get('video'),
            currentAudioTrackId: this.selectedTrackIds.get('audio'),
            previousLayer: previousVideo && previousAudio ? {video: previousVideo, audio: previousAudio} : null,
            switchLayer: layer => this.switchLayer(demuxer, layer.video, layer.audio),
            setAutomaticMode: () => {
                this.preferredVideoPacketId = null;
                this.preferredAudioPacketId = null;
            },
            enableAutomatic: () => this.configureAutomaticLayerSwitch(true),
            setPreviousMode: () => {
                this.preferredVideoPacketId = previousVideoPacketId;
                this.preferredAudioPacketId = previousAudioPacketId;
            },
            disableAutomatic: async () => {
                const sequence = ++this.automaticLayerConfigurationSequence;
                await demuxer.clearAutomaticLayerSwitch();
                if (sequence === this.automaticLayerConfigurationSequence && demuxer === this.demuxer) {
                    this.automaticLayerPairSignature = 'disabled';
                }
            },
        });
    }

    private async switchLayer(
        demuxer: WorkerDemuxer,
        videoTrack: DPlayerType.TLVTrackInfo,
        audioTrack: DPlayerType.TLVTrackInfo,
    ): Promise<void> {

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
            if (!await startTLVLayerSwitch({
                demuxer,
                queuesReady: this.queueByType.has('video') && this.queueByType.has('audio'),
                videoTrackId: videoTrack.trackId,
                audioTrackId: audioTrack.trackId,
                presentationTimeUs: earliestPresentationTimeUs,
            })) {
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
        const effectiveMode = this.effectiveToneMappingMode();
        const demuxer = this.demuxer;
        if (!demuxer) {
            this.updateHlgSdrRenderer();
            return;
        }
        void demuxer.setMseToneMappingMode(effectiveMode).then(() => {
            if (this.demuxer === demuxer && !this.destroyed) this.updateHlgSdrRenderer();
        }).catch(error => {
            if (this.demuxer === demuxer && !this.destroyed) this.fail(error);
        });
    }

    setOutputEdid(edid: Uint8Array): void {
        this.pendingOutputEdid = edid.slice();
        const demuxer = this.demuxer;
        if (!demuxer) return;
        void demuxer.setMseEdid(this.pendingOutputEdid).catch(error => {
            if (this.demuxer === demuxer && !this.destroyed) this.fail(error);
        });
    }

    setOutputConnected(connected: boolean): void {
        this.pendingOutputConnected = connected;
        const demuxer = this.demuxer;
        if (!demuxer) return;
        void demuxer.setMseOutputConnected(connected).catch(error => {
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
        this.bridge.video.removeEventListener('waiting', this.waitingListener);
        this.bridge.video.removeEventListener('playing', this.playingListener);
        this.resetPlaybackDamage();
        this.generation += 1;
        this.abortController?.abort();
        this.demuxer?.delete();
        this.demuxer = null;
        this.worker?.close();
        this.worker = null;
        if (this.workerRuntimeUrl) URL.revokeObjectURL(this.workerRuntimeUrl);
        this.workerRuntimeUrl = null;
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
            this.workerRuntimeUrl = URL.createObjectURL(new Blob(
                [tlvDemuxRuntimeSource],
                {type: 'text/javascript'},
            ));
            const worker = await createWorkerTlvDemuxModule({
                workerUrl: 'about:blank',
                wasmUrl: this.workerRuntimeUrl,
                workerFactory: () => new InlineTlvWorker(),
            });
            if (this.destroyed) {
                worker.close();
                return;
            }
            this.worker = worker;
            this.workerReady = true;
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
            if (this.workerRuntimeUrl) URL.revokeObjectURL(this.workerRuntimeUrl);
            this.workerRuntimeUrl = null;
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
        this.resetPlaybackDamage();
        this.abortController?.abort();
        const controller = new AbortController();
        this.abortController = controller;
        this.demuxer?.delete();
        this.demuxer = null;
        this.releaseMediaSource();
        this.tracks.length = 0;
        this.selectedTrackIds.clear();
        this.currentMptSnapshot = null;
        this.automaticLayerConfigurationSequence += 1;
        this.automaticLayerPairSignature = null;
        this.bridge.invalidateQualitySnapshot();
        this.videoProperties = null;
        this.updateHlgSdrRenderer();
        this.playingStarted = false;
        this.createSubtitleRenderer();

        try {
            let recordedSource: RecordedSource | null = null;
            if (!this.bridge.live) {
                recordedSource = await this.openRecordedSource(controller.signal);
                if (this.bridge.source.fileSize !== undefined &&
                    BigInt(this.bridge.source.fileSize) !== recordedSource.size) {
                    throw new Error(
                        `Recorded TLV size changed: expected ${this.bridge.source.fileSize}, received ${recordedSource.size}.`,
                    );
                }
                if (this.durationUs === null) this.durationUs = await this.probeDuration(recordedSource, controller.signal);
            }
            if (generation !== this.generation) return;
            await this.openMediaSource();
            if (this.mediaSource && !this.bridge.live && this.durationUs !== null) {
                this.mediaSource.duration = Number(this.durationUs) / 1000000;
            } else if (this.mediaSource && this.bridge.live) {
                this.mediaSource.duration = Infinity;
            }
            await this.consumeSource(startTimeSeconds, generation, controller.signal, recordedSource);
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

    private async consumeSource(startTimeSeconds: number, generation: number, signal: AbortSignal,
                                recordedSource: RecordedSource | null): Promise<void> {
        let callbackError: unknown = null;
        let incompleteInputTail = false;
        let discardPlaybackData = startTimeSeconds > 0;
        let seekSession: MseRecordedSeekSession | null = null;
        const active = (): boolean => generation === this.generation && !this.destroyed;
        const entryKind = tlvPlaybackEntryKind(this.bridge.live, startTimeSeconds);
        const pipeline = createMseOutputPipeline({
            mediaSource: this.mediaSource!,
            media: this.bridge.video,
            queues: this.queueByType,
            freshRecordedEntryAlignment: entryKind === 'startup',
            onUpdateEnd: () => this.handleQueueUpdate(),
            onQueueCreated: () => this.handleQueueUpdate(),
            forceReinitialize: () => this.layerSwitchPending !== null,
            queueOptions: {
                backBufferSeconds: this.bridge.options.backBufferSeconds ?? (this.bridge.live ? 45 : 8),
                forwardBufferHighSeconds: this.bridge.options.forwardBufferSeconds ?? (this.bridge.live ? 8 : 15),
            },
        });
        const flowControl = createMsePlaybackFlowControl({
            media: this.bridge.video,
            queues: this.queueByType,
            entryKind,
            entryTimeSeconds: startTimeSeconds,
            highSeconds: this.bridge.options.forwardBufferSeconds ?? (this.bridge.live ? 8 : 15),
            lowSeconds: Math.min(8, this.bridge.options.forwardBufferSeconds ?? (this.bridge.live ? 8 : 15)),
            queueHighBytes: SOURCE_QUEUE_HIGH_BYTES,
            backBufferSeconds: this.bridge.options.backBufferSeconds ?? (this.bridge.live ? 45 : 8),
        });

        const callbacks: createTlvDemuxModule.TlvDemuxOptions = {
            onMseVideoProperties: properties => {
                if (!active()) return;
                this.videoProperties = properties;
                this.updateHlgSdrRenderer();
                this.bridge.emit('tlv_video_properties', properties);
            },
            onMseOutputState: state => {
                if (!active()) return;
                this.outputState = state;
                this.updateHlgSdrRenderer();
                this.bridge.emit('tlv_output_state', state);
            },
            onMseInit: init => {
                if (!active()) return;
                try {
                    pipeline.onMseInit(init as unknown as Parameters<MseOutputPipeline['onMseInit']>[0]);
                } catch (error) { callbackError = error; }
            },
            onMseSegment: segment => {
                if (!active()) return;
                try {
                    pipeline.onMseSegment(segment as unknown as Parameters<MseOutputPipeline['onMseSegment']>[0]);
                } catch (error) { callbackError = error; }
            },
            onMseVideoSplice: splice => {
                if (!active()) return;
                try {
                    pipeline.onMseVideoSplice(
                        splice as unknown as Parameters<MseOutputPipeline['onMseVideoSplice']>[0],
                    );
                } catch (error) {
                    const normalized = error instanceof Error ? error : new Error(String(error));
                    this.rejectLayerSwitch(normalized);
                    callbackError = normalized;
                }
            },
            onMseAudioSplice: splice => {
                if (!active()) return;
                try {
                    pipeline.onMseAudioSplice(
                        splice as unknown as Parameters<MseOutputPipeline['onMseAudioSplice']>[0],
                    );
                } catch (error) {
                    this.audioSwitchError = error instanceof Error ? error : new Error(String(error));
                    this.rejectLayerSwitch(this.audioSwitchError);
                    callbackError = this.audioSwitchError;
                }
            },
            onMseLayerSwitch: layer => {
                if (!active()) return;
                this.resetPlaybackDamage();
                const pending = this.layerSwitchPending;
                const matchesPending = pending?.demuxer === demuxer && pending.generation === generation &&
                    pending.videoTrack.trackId === layer.videoTrackId &&
                    pending.audioTrack.trackId === layer.audioTrackId;
                const videoTrack = matchesPending ? pending.videoTrack :
                    this.tracks.find(track => track.kind === 'video' && track.trackId === layer.videoTrackId);
                const audioTrack = matchesPending ? pending.audioTrack :
                    this.tracks.find(track => track.kind === 'audio' && track.trackId === layer.audioTrackId);
                if (!videoTrack || !audioTrack) return;
                if (matchesPending) this.layerSwitchPending = null;
                this.selectedTrackIds.set('video', videoTrack.trackId);
                this.selectedTrackIds.set('audio', audioTrack.trackId);
                if (matchesPending) pending.resolve();
                this.bridge.emit('tlv_track_change', {kind: 'video', track: videoTrack});
                this.bridge.emit('tlv_track_change', {kind: 'audio', track: audioTrack});
                this.bridge.emit('tlv_layer_change', {
                    videoTrack,
                    audioTrack,
                    videoPresentationTimeUs: layer.videoPresentationTimeUs,
                    audioPresentationTimeUs: layer.audioPresentationTimeUs,
                } satisfies DPlayerType.TLVLayerChange);
            },
            onMseLayerSwitchCancelled: cancelled => {
                if (!active()) return;
                const pending = this.layerSwitchPending;
                if (pending?.demuxer === demuxer && pending.generation === generation &&
                    pending.videoTrack.trackId === cancelled.videoTrackId &&
                    pending.audioTrack.trackId === cancelled.audioTrackId) {
                    this.rejectLayerSwitch(new Error(`The A/V layer switch was cancelled: ${cancelled.reason}.`));
                }
            },
            onTrack: track => {
                if (!active()) return;
                seekSession?.observeTrack(
                    track as unknown as Parameters<MseRecordedSeekSession['observeTrack']>[0],
                );
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
                void this.configureAutomaticLayerSwitch().catch(error => this.fail(error));
            },
            onTrackRemoved: track => {
                if (!active()) return;
                seekSession?.observeTrackRemoved(
                    track as unknown as Parameters<MseRecordedSeekSession['observeTrackRemoved']>[0],
                );
                const index = this.tracks.findIndex(candidate => candidate.trackId === track.trackId);
                if (index !== -1) this.tracks.splice(index, 1);
                this.bridge.emit('tlv_tracks', [...this.tracks]);
            },
            onMptSnapshot: snapshot => {
                if (!active()) return;
                this.currentMptSnapshot = snapshot;
                void this.configureAutomaticLayerSwitch().catch(error => this.fail(error));
                this.bridge.emit('tlv_mpt_snapshot', snapshot);
            },
            onPlaybackDamage: damage => {
                if (!active()) return;
                this.bridge.emit('tlv_playback_damage', damage);
                this.handlePlaybackDamage(damage);
            },
            onPlaybackAccessUnitView: unit => {
                if (!active()) return;
                try {
                    seekSession?.observeAccessUnit(
                        unit as unknown as Parameters<MseRecordedSeekSession['observeAccessUnit']>[0],
                    );
                    const subtitleTrack = this.tracks.find(track => track.trackId === unit.trackId &&
                        track.kind === 'subtitle' && track.codec === 'ttml');
                    if (!discardPlaybackData && subtitleTrack) {
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
                    if (!discardPlaybackData && shouldRenderSubtitle && subtitleTrack && this.renderer) {
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
            onApplicationResourceView: resource => {
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
        };
        const demuxer = new this.worker!.TlvDemuxer(callbacks, {
            videoPacketId: this.preferredVideoPacketId,
            audioPacketId: this.preferredAudioPacketId,
            subtitlePacketId: this.preferredSubtitlePacketId,
            mseMaxAudioChannels: 8,
            indexDurationUs: this.durationUs,
        });
        this.demuxer = demuxer;
        await demuxer.initialized();
        // Apply host display state before the first media initialization is
        // emitted, so Auto can preserve HDR signalling for a real HDR sink.
        if (this.pendingOutputEdid) await demuxer.setMseEdid(this.pendingOutputEdid.slice());
        if (this.pendingOutputConnected !== null) {
            await demuxer.setMseOutputConnected(this.pendingOutputConnected);
        }
        [this.hlgSdrColorLut, this.hlgSdrPrototypeColorLut] = await Promise.all([
            demuxer.hlgSdrColorLut(), demuxer.hlgSdrPrototypeColorLut(),
        ]);
        await demuxer.setMseToneMappingMode(this.effectiveToneMappingMode());
        this.updateHlgSdrRenderer();
        // データ放送は通常字幕と文字スーパーを component_tag ごとに購読するため、
        // 画面字幕の選択とは独立して全 TTML track をイベントへ流す。
        await demuxer.setSubtitlePassthroughEnabled(true);
        if (!this.bridge.live) await demuxer.startIndex(false);

        let offset = 0n;
        if (!this.bridge.live && startTimeSeconds > 0 && recordedSource && this.durationUs !== null) {
            seekSession = createMseRecordedSeekSession({
                targetTimeSeconds: startTimeSeconds,
                source: recordedSource,
                durationUs: this.durationUs,
                demuxer,
                media: this.bridge.video,
                queues: this.queueByType,
                flowControl,
                signal,
                isActive: active,
                headReady: () => this.selectedTrackIds.has('video'),
                candidateVideoTrack: track => {
                    if (track.kind !== 'video') return false;
                    const candidate = this.tracks.find(item => item.trackId === track.trackId);
                    if (!candidate) return false;
                    const current = this.tracks.find(item =>
                        item.kind === 'video' && item.trackId === this.selectedTrackIds.get('video'));
                    return current === undefined || candidate.trackId === current.trackId ||
                        sameVideoLayerGroup(current as unknown as Parameters<typeof sameVideoLayerGroup>[0],
                            candidate as unknown as Parameters<typeof sameVideoLayerGroup>[1]);
                },
                videoTrackPriority: track => {
                    const candidate = this.tracks.find(item => item.trackId === track.trackId);
                    return selectionLevel(
                        candidate as unknown as Parameters<typeof selectionLevel>[0],
                    ) ?? 0xff;
                },
                activateVideoTrack: async track => {
                    const candidate = this.tracks.find(item => item.trackId === track.trackId);
                    if (!candidate) throw new Error(`Seek selected unknown video track ${track.trackId}.`);
                    if (candidate.trackId === this.selectedTrackIds.get('video')) return;
                    await demuxer.selectTrack('video', candidate.trackId);
                    this.selectedTrackIds.set('video', candidate.trackId);
                    const currentAudio = this.tracks.find(item =>
                        item.kind === 'audio' && item.trackId === this.selectedTrackIds.get('audio')) ?? null;
                    const matchingAudio = correspondingAudioTrack(
                        this.tracks.filter(item => item.kind === 'audio') as unknown as Parameters<
                            typeof correspondingAudioTrack
                        >[0],
                        currentAudio as unknown as Parameters<typeof correspondingAudioTrack>[1],
                        selectionLevel(candidate as unknown as Parameters<typeof selectionLevel>[0]),
                    );
                    const audioTrack = matchingAudio?.track as unknown as DPlayerType.TLVTrackInfo | undefined;
                    if (audioTrack && this.isMseCompatibleAudioTrack(audioTrack)) {
                        await demuxer.selectTrack('audio', audioTrack.trackId);
                        this.selectedTrackIds.set('audio', audioTrack.trackId);
                    }
                },
                beforeLanding: () => {
                    pipeline.clearPendingMedia();
                    this.renderer?.reset();
                    discardPlaybackData = false;
                    this.bridge.video.currentTime = startTimeSeconds;
                },
                waitForAppends: () => pipeline.waitStable(),
                checkError: () => { if (callbackError) throw callbackError; },
            });
            const result = await seekSession.run();
            offset = result.nextOffset;
            seekSession = null;
        } else {
            discardPlaybackData = false;
        }

        if (this.bridge.live) {
            const response = await this.fetch(this.bridge.url, {}, signal);
            if (!response.ok || !response.body) throw new Error(`TLV live request failed: HTTP ${response.status}`);
            const reader = response.body.getReader();
            for await (const data of coalesceReadableStream(reader, {
                targetBytes: LIVE_CHUNK_TARGET_BYTES,
                maxDelayMilliseconds: LIVE_CHUNK_MAX_DELAY_MILLISECONDS,
            })) {
                if (generation !== this.generation) break;
                if (!await demuxer.push(data)) throw new Error('TLV live demux failed.');
                if (callbackError) throw callbackError;
                await flowControl.afterPush(data.byteLength, active);
            }
        } else if (recordedSource) {
            while (offset < recordedSource.size && generation === this.generation) {
                const size = recordedSource.size - offset < CHUNK_SIZE ? recordedSource.size - offset : CHUNK_SIZE;
                const data = await recordedSource.read(offset, size);
                if (!await demuxer.push(data)) {
                    throw new Error(`TLV demux failed at ${offset}.`);
                }
                offset += size;
                if (callbackError) throw callbackError;
                await flowControl.afterPush(data.byteLength, active);
            }
        }
        if (generation !== this.generation) return;
        await demuxer.flush();
        if (this.layerSwitchPending?.demuxer === demuxer) {
            this.rejectLayerSwitch(new Error('The input ended before the A/V layer switch completed.'));
        }
        if (!this.bridge.live) await demuxer.finalizeIndex();
        await pipeline.finalize({truncateToCommonEnd: !this.bridge.live && incompleteInputTail});
    }

    private openRecordedSource(signal: AbortSignal): Promise<RecordedSource> {
        return openTLVRecordedSource({
            url: this.bridge.url,
            fetchOptions: this.bridge.options.fetch,
            signal,
        });
    }

    private probeDuration(source: RecordedSource, signal: AbortSignal): Promise<bigint> {
        return probeTLVRecordedDuration({
            source,
            probe: new this.worker!.DurationProbe(),
            signal,
            isActive: () => !this.destroyed,
        });
    }

    private fetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
        const configured = this.bridge.options.fetch ?? {};
        const headers = new Headers(configured.headers);
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        return window.fetch(url, {...configured, ...init, headers, signal});
    }

    private createSubtitleRenderer(): void {
        const result = createTLVSubtitleRenderer({
            previous: this.renderer,
            previousOverlay: this.subtitleOverlay,
            mediaPlane: this.bridge.mediaPlane,
            media: this.bridge.video,
            live: this.bridge.live,
            visible: this.bridge.subtitleVisible(),
            rendererOptions: this.bridge.subtitleOptions,
        });
        this.renderer = result.renderer;
        this.subtitleOverlay = result.overlay;
    }

    private updateHlgSdrRenderer(): void {
        const sourceIsHlg = this.videoProperties?.sourceColor?.transfer === 18;
        const effectiveMode = this.effectiveToneMappingMode();
        const lut = effectiveMode === 'prototype' ? this.hlgSdrPrototypeColorLut : this.hlgSdrColorLut;
        if (lut) this.hlgSdrRenderer.setColorLut(lut);
        this.hlgSdrRenderer.setComparisonEnabled(this.toneMappingMode === 'on_compare');
        const enabled = sourceIsHlg && effectiveMode !== 'off' &&
            (effectiveMode === 'force' || effectiveMode === 'prototype' ||
             this.videoProperties?.sdrInHlg === true);
        this.hlgSdrRenderer.setEnabled(enabled);
    }

    private effectiveToneMappingMode(): createTlvDemuxModule.MseToneMappingMode {
        return effectiveTLVToneMappingMode({
            mode: this.toneMappingMode,
            sourceTransfer: this.videoProperties?.sourceColor?.transfer,
            outputState: this.outputState,
        });
    }

    private maybeStartPlayback(): void {
        if (this.playingStarted || this.queueByType.size < 2) return;
        const started = startMsePlayback({
            media: this.bridge.video,
            queues: this.queueByType,
            liveMode: this.bridge.live,
            minimumLiveBufferSeconds: 0.5,
        });
        if (!started) return;
        this.playingStarted = true;
        started.playResult.catch(() => undefined);
    }

    private handleQueueUpdate(): void {
        this.maybeStartPlayback();
        this.damageRecovery.update();
    }

    private handlePlaybackDamage(damage: createTlvDemuxModule.PlaybackDamage): void {
        const key = `${damage.videoTrackId}:${damage.startInputOffset}:${damage.endInputOffset}`;
        if (this.reportedDamage.has(key)) return;
        this.reportedDamage.add(key);
        if (damage.severity !== 'severe') return;

        if (damage.action === 'seek' && damage.recoveryTimeUs !== null) {
            this.damageRecovery.reportDamage(damage);
            const start = Number(damage.startTimeUs ?? damage.endTimeUs) / 1000000;
            const recovery = Number(damage.recoveryTimeUs) / 1000000;
            const seconds = Math.max(0, recovery - start).toFixed(1);
            const message = this.bridge.translate(
                'Recording damaged. If playback stops, it will skip ahead {{seconds}} seconds. [TLV_SOURCE_DAMAGE]',
            )
                .replace('{{seconds}}', seconds);
            this.showDamageNotice('recoverable', message);
        } else if (damage.action === 'wait-for-recovery') {
            this.showDamageNotice(
                this.bridge.live ? 'waiting' : 'terminal',
                this.bridge.translate(this.bridge.live ?
                    'Stream damaged. Waiting for recovery. [TLV_SOURCE_DAMAGE]' :
                    'Recording tail damaged. Cannot continue; return to an earlier position. [TLV_SOURCE_DAMAGE]'),
            );
        }
    }

    private showDamageNotice(state: 'recoverable' | 'waiting' | 'terminal' | 'recovered', message: string): void {
        this.bridge.damageNotice.dataset.state = state;
        this.bridge.damageNotice.textContent = message;
    }

    private clearDamageNotice(): void {
        this.bridge.damageNotice.dataset.state = 'empty';
        this.bridge.damageNotice.textContent = '';
    }

    private resetPlaybackDamage(): void {
        this.damageRecovery.reset();
        this.reportedDamage.clear();
        this.clearDamageNotice();
    }

    private isMseCompatibleAudioTrack(track: DPlayerType.TLVTrackInfo): boolean {
        // ARIB の 22.2ch トラック (channel_configuration=14) は fMP4 上 13 channels の AAC になるが、
        // 現行ブラウザの MSE audio decoder は受け付けない。8K 放送に併送される 5.1ch/2ch を使う。
        return track.audio?.channelLayout !== 14;
    }

    private async configureAutomaticLayerSwitch(force = false): Promise<void> {
        const demuxer = this.demuxer;
        if (!demuxer) return;
        const sequence = ++this.automaticLayerConfigurationSequence;
        const signature = await configureAutomaticTLVLayer(
            demuxer,
            this.layerPair(),
            this.automaticLayerPairSignature,
            this.preferredVideoPacketId !== null,
            force,
        );
        if (sequence === this.automaticLayerConfigurationSequence && demuxer === this.demuxer) {
            this.automaticLayerPairSignature = signature;
        }
    }

    private subtitleTrackKind(track: DPlayerType.TLVTrackInfo): 'caption' | 'superimpose' {
        if (track.subtitle?.type === 0) return 'caption';
        if (track.subtitle?.type === 1) return 'superimpose';
        throw new Error(`TTML packet_id=0x${track.packetId.toString(16)} has invalid subtitle.type.`);
    }

    private releaseMediaSource(): void {
        for (const queue of this.queueByType.values()) queue.stop();
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
