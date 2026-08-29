import { createLiveMseTransitionManager } from 'tlvdemux/mse-live-transition';
import type { MseLiveTransitionCommit, MseLiveTransitionManager } from 'tlvdemux/mse-live-transition';
import { createMseRecordedSeekSession } from 'tlvdemux/mse-playback';
import type { RecordedSource } from 'tlvdemux/recorded-source';
import type { WorkerDemuxer, WorkerTlvDemuxModule } from 'tlvdemux/worker-client';
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
export declare function adoptRecordedTLVDemuxer(options: {
    current: () => WorkerDemuxer;
    candidate: NonNullable<RecordedCandidate['prepareDemuxerAdoption']>;
    callbacks: createTlvDemuxModule.TlvDemuxOptions;
    nextOffset: bigint;
    adopt(demuxer: WorkerDemuxer): void;
    setOffset(offset: bigint): void;
}): {
    previous: WorkerDemuxer;
    adopted: WorkerDemuxer;
};
export declare function createRecordedTLVTransitionManager(options: {
    worker: WorkerTlvDemuxModule;
    MediaSourceClass: typeof MediaSource;
    source: RecordedSource;
    durationSeconds: number;
    durationUs: bigint;
    presentationStartUs: bigint;
    presentationEndUs: bigint;
    media: HTMLMediaElement;
    queueOptions: {
        backBufferSeconds: number;
        forwardBufferHighSeconds: number;
    };
    isActive: () => boolean;
    openMediaSource: Parameters<typeof createLiveMseTransitionManager>[0]['openMediaSource'];
    commit: (candidate: RecordedCandidate) => unknown | Promise<unknown>;
    selectedVideoTrackId: () => bigint | null;
    selectedAudioTrackId: () => bigint | null;
    selectedVideoPacketId: () => number | null;
    selectedAudioPacketId: () => number | null;
    toneMappingMode: () => createTlvDemuxModule.MseToneMappingMode;
    estimateOffset: (targetUs: bigint, sourceSize: bigint) => Promise<bigint | null>;
}): MseLiveTransitionManager;
export {};
//# sourceMappingURL=tlv-recorded-transition.d.ts.map