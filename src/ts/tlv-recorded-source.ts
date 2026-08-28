import type {WorkerDurationProbe} from 'tlvdemux/worker-client';
import {openHttpRecordedSource, probeRecordedDuration} from 'tlvdemux/recorded-source';
import type {RecordedSource} from 'tlvdemux/recorded-source';

const MiB = 1024n * 1024n;
const INITIAL_PROBE_SIZE = 2n * MiB;
const MAX_PROBE_SIZE = 64n * MiB;

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
}): Promise<bigint> {
    const result = await probeRecordedDuration({
        ...options,
        options: {initialRangeSize: INITIAL_PROBE_SIZE, maxRangeSize: MAX_PROBE_SIZE},
    });
    return BigInt(result.duration.value) * 1000000n / BigInt(result.duration.timescale);
}
