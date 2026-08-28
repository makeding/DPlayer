import type {WorkerDemuxer} from 'tlvdemux/worker-client';

export function tlvPlaybackEntryKind(live: boolean, startTimeSeconds: number): 'live' | 'seek' | 'startup' {
    if (live) return 'live';
    return startTimeSeconds > 0 ? 'seek' : 'startup';
}

export function startTLVLayerSwitch(options: {
    demuxer: WorkerDemuxer;
    queuesReady: boolean;
    videoTrackId: bigint;
    audioTrackId: bigint;
    mediaTimeUs: bigint;
    presentationStartUs: bigint;
}): Promise<boolean> {
    if (!options.queuesReady) {
        return options.demuxer.switchLayerAtPlaybackEntry(
            options.videoTrackId, options.audioTrackId, options.mediaTimeUs,
        );
    }
    return options.demuxer.switchLayer(
        options.videoTrackId, options.audioTrackId,
        options.presentationStartUs + options.mediaTimeUs,
    );
}
