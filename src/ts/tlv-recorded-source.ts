import type {WorkerDurationProbe} from 'tlvdemux/worker-client';
import {openHttpRecordedSource, probeRecordedDuration} from 'tlvdemux/recorded-source';
import type {RecordedSource} from 'tlvdemux/recorded-source';

const MiB = 1024n * 1024n;
const INITIAL_PROBE_SIZE = 2n * MiB;
const MAX_PROBE_SIZE = 64n * MiB;

export interface TLVRecordedPresentationRange {
    durationUs: bigint;
    presentationStartUs: bigint;
    presentationEndUs: bigint;
    selectedVideoPacketId: number | null;
    presentationEndVideoPacketId: number | null;
}

function timestampMicroseconds(timestamp: {value: bigint | number; timescale: number}): bigint {
    return BigInt(timestamp.value) * 1000000n / BigInt(timestamp.timescale);
}

export function openTLVRecordedSource(options: {
    url: string;
    fetchOptions?: Omit<RequestInit, 'signal' | 'headers'> & {headers?: HeadersInit};
    signal: AbortSignal;
}): Promise<RecordedSource> {
    const {headers, ...requestInit} = options.fetchOptions ?? {};
    return openHttpRecordedSource({
        url: options.url,
        fetch: window.fetch.bind(window),
        headers,
        requestInit,
        signal: options.signal,
    });
}

export async function probeTLVRecordedDuration(options: {
    source: RecordedSource;
    probe: WorkerDurationProbe;
    signal: AbortSignal;
    isActive: () => boolean;
    videoPacketId?: number | null;
}): Promise<TLVRecordedPresentationRange> {
    const result = await probeRecordedDuration({
        ...options,
        options: {
            initialRangeSize: INITIAL_PROBE_SIZE,
            maxRangeSize: MAX_PROBE_SIZE,
            ...(options.videoPacketId === null || options.videoPacketId === undefined ? {} : {
                videoPacketId: options.videoPacketId,
            }),
        },
    });
    return {
        durationUs: timestampMicroseconds(result.duration),
        presentationStartUs: timestampMicroseconds(result.presentationStart),
        presentationEndUs: timestampMicroseconds(result.presentationEnd),
        selectedVideoPacketId: result.selectedVideoPacketId,
        presentationEndVideoPacketId: result.presentationEndVideoPacketId,
    };
}
