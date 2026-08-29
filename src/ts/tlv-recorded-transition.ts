import type {MseAppendQueue} from 'tlvdemux/mse-append-queue';
import type {MseOutputPipeline} from 'tlvdemux/mse-output-pipeline';
import {createLiveMseTransitionManager} from 'tlvdemux/mse-live-transition';
import type {MseLiveTransitionCommit, MseLiveTransitionManager} from 'tlvdemux/mse-live-transition';
import {MsePlaybackMode, createMseRecordedSeekSession} from 'tlvdemux/mse-playback';
import type {RecordedSource} from 'tlvdemux/recorded-source';
import type {WorkerDemuxer, WorkerTlvDemuxModule} from 'tlvdemux/worker-client';
import type createTlvDemuxModule from 'tlvdemux';

type RecordedCandidate = MseLiveTransitionCommit & {
    cleanup: (() => void) | null;
    seekResult?: Awaited<ReturnType<ReturnType<typeof createMseRecordedSeekSession>['run']>>;
    prepareDemuxerAdoption?: (callbacks: createTlvDemuxModule.TlvDemuxOptions) => {
        demuxer: WorkerDemuxer;
        tracks: createTlvDemuxModule.TrackInfo[];
        commit(): void;
    };
};

export function adoptRecordedTLVDemuxer(options: {
    current: () => WorkerDemuxer;
    candidate: NonNullable<RecordedCandidate['prepareDemuxerAdoption']>;
    callbacks: createTlvDemuxModule.TlvDemuxOptions;
    nextOffset: bigint;
    adopt(demuxer: WorkerDemuxer): void;
    setOffset(offset: bigint): void;
}): {previous: WorkerDemuxer; adopted: WorkerDemuxer} {
    const previous = options.current();
    const adoption = options.candidate(options.callbacks);
    options.adopt(adoption.demuxer);
    options.setOffset(options.nextOffset);
    adoption.commit();
    return {previous, adopted: adoption.demuxer};
}

export function createRecordedTLVTransitionManager(options: {
    worker: WorkerTlvDemuxModule;
    MediaSourceClass: typeof MediaSource;
    source: RecordedSource;
    durationSeconds: number;
    durationUs: bigint;
    presentationStartUs: bigint;
    presentationEndUs: bigint;
    media: HTMLMediaElement;
    queueOptions: {backBufferSeconds: number; forwardBufferHighSeconds: number};
    isActive: () => boolean;
    openMediaSource: Parameters<typeof createLiveMseTransitionManager>[0]['openMediaSource'];
    commit: (candidate: RecordedCandidate) => unknown | Promise<unknown>;
    selectedVideoTrackId: () => bigint | null;
    selectedAudioTrackId: () => bigint | null;
    selectedVideoPacketId: () => number | null;
    selectedAudioPacketId: () => number | null;
    toneMappingMode: () => createTlvDemuxModule.MseToneMappingMode;
    estimateOffset: (targetUs: bigint, sourceSize: bigint) => Promise<bigint | null>;
}): MseLiveTransitionManager {
    const manager: MseLiveTransitionManager = createLiveMseTransitionManager({
        MediaSourceClass: options.MediaSourceClass,
        media: options.media,
        queueOptions: options.queueOptions,
        isActive: options.isActive,
        openMediaSource: options.openMediaSource,
        commit: candidate => options.commit(candidate as RecordedCandidate),
        appendLog: () => undefined,
        liveMode: false,
        duration: options.durationSeconds,
        async prepareCandidate(baseCandidate) {
            const candidate = baseCandidate as RecordedCandidate;
            const abort = new AbortController();
            const tracks = new Map<bigint, createTlvDemuxModule.TrackInfo>();
            let seekSession: ReturnType<typeof createMseRecordedSeekSession> | null = null;
            let callbackError: unknown = null;
            let demuxer: WorkerDemuxer | null = null;
            const callbacks: createTlvDemuxModule.TlvDemuxOptions = {
                onMseInit: init => manager.observeInit(init as unknown as Parameters<
                    MseLiveTransitionManager['observeInit']
                >[0]),
                onMseSegment: segment => manager.observeSegment(segment as unknown as Parameters<
                    MseLiveTransitionManager['observeSegment']
                >[0]),
                onMseAudioSplice: splice => manager.observeSplice('audio', splice as unknown as Parameters<
                    MseLiveTransitionManager['observeSplice']
                >[1]),
                onMseVideoSplice: splice => manager.observeSplice('video', splice as unknown as Parameters<
                    MseLiveTransitionManager['observeSplice']
                >[1]),
                onTrack: track => {
                    tracks.set(track.trackId, track);
                    seekSession?.observeTrack(track as unknown as Parameters<
                        NonNullable<typeof seekSession>['observeTrack']
                    >[0]);
                },
                onTrackRemoved: track => {
                    tracks.delete(track.trackId);
                    seekSession?.observeTrackRemoved(track as unknown as Parameters<
                        NonNullable<typeof seekSession>['observeTrackRemoved']
                    >[0]);
                },
                onPlaybackAccessUnitView: unit => seekSession?.observeAccessUnit(
                    unit as unknown as Parameters<NonNullable<typeof seekSession>['observeAccessUnit']>[0],
                ),
                onError: error => {
                    if (!error.recoverable) callbackError = new Error(error.message);
                },
            };
            demuxer = new options.worker.TlvDemuxer(callbacks, {
                videoPacketId: options.selectedVideoPacketId(),
                audioPacketId: options.selectedAudioPacketId(),
                mseMaxAudioChannels: 8,
                indexDurationUs: options.presentationEndUs,
            });
            candidate.cleanup = () => {
                abort.abort();
                demuxer?.delete();
                demuxer = null;
            };
            candidate.prepareDemuxerAdoption = nextCallbacks => {
                if (!demuxer) throw new Error('Recorded transition demuxer is unavailable.');
                Object.assign(callbacks, nextCallbacks);
                const adopted = demuxer;
                return {
                    demuxer: adopted,
                    tracks: [...tracks.values()],
                    commit() {
                        if (demuxer !== adopted) return;
                        demuxer = null;
                        candidate.cleanup = null;
                    },
                };
            };

            await demuxer.initialized();
            await demuxer.setMseToneMappingMode(options.toneMappingMode());
            await demuxer.setSubtitlePassthroughEnabled(true);
            await demuxer.setMseTimestampOffset(-options.presentationStartUs);
            await demuxer.startIndex(false);

            const audioOnly = candidate.mode === MsePlaybackMode.AUDIO_ONLY;
            const requiredTracks = audioOnly ? ['audio'] as const : ['video', 'audio'] as const;
            seekSession = createMseRecordedSeekSession({
                targetTimeSeconds: candidate.target,
                source: options.source,
                durationUs: options.durationUs,
                presentationStartUs: options.presentationStartUs,
                presentationEndUs: options.presentationEndUs,
                demuxer,
                media: candidate.probeMedia,
                queues: candidate.queues as Map<string, MseAppendQueue>,
                flowControl: candidate.flow as Parameters<typeof createMseRecordedSeekSession>[0]['flowControl'],
                signal: abort.signal,
                isActive: options.isActive,
                requiredTracks,
                headReady: () => audioOnly
                    ? options.selectedAudioTrackId() !== null
                    : options.selectedVideoTrackId() !== null && options.selectedAudioTrackId() !== null,
                candidateTrack: track => audioOnly
                    ? track.kind === 'audio' && track.trackId === options.selectedAudioTrackId()
                    : track.kind === 'video' && track.trackId === options.selectedVideoTrackId(),
                activateTrack: async track => {
                    await demuxer!.selectTrack(audioOnly ? 'audio' : 'video', BigInt(track.trackId));
                },
                estimateOffset: options.estimateOffset,
                waitForAppends: () => (candidate.pipeline as MseOutputPipeline).waitStable(),
                checkError: () => { if (callbackError) throw callbackError; },
            });
            for (const track of tracks.values()) {
                seekSession.observeTrack(track as unknown as Parameters<typeof seekSession.observeTrack>[0]);
            }
            candidate.seekResult = await seekSession.run();
        },
    });
    return manager;
}
