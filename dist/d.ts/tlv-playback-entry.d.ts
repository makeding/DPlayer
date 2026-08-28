import type { WorkerDemuxer } from 'tlvdemux/worker-client';
export declare function tlvPlaybackEntryKind(live: boolean, startTimeSeconds: number): 'live' | 'seek' | 'startup';
export declare function startTLVLayerSwitch(options: {
    demuxer: WorkerDemuxer;
    queuesReady: boolean;
    videoTrackId: bigint;
    audioTrackId: bigint;
    mediaTimeUs: bigint;
    presentationStartUs: bigint;
}): Promise<boolean>;
//# sourceMappingURL=tlv-playback-entry.d.ts.map