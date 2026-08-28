import type { WorkerDurationProbe } from 'tlvdemux/worker-client';
import type { RecordedSource } from 'tlvdemux/recorded-source';
export interface TLVRecordedPresentationRange {
    durationUs: bigint;
    presentationStartUs: bigint;
    presentationEndUs: bigint;
    selectedVideoPacketId: number | null;
    presentationEndVideoPacketId: number | null;
}
export declare function openTLVRecordedSource(options: {
    url: string;
    fetchOptions?: Omit<RequestInit, 'signal' | 'headers'> & {
        headers?: HeadersInit;
    };
    signal: AbortSignal;
}): Promise<RecordedSource>;
export declare function probeTLVRecordedDuration(options: {
    source: RecordedSource;
    probe: WorkerDurationProbe;
    signal: AbortSignal;
    isActive: () => boolean;
    videoPacketId?: number | null;
}): Promise<TLVRecordedPresentationRange>;
//# sourceMappingURL=tlv-recorded-source.d.ts.map