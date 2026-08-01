import type createTlvDemuxModule from 'tlvdemux';
type Callbacks = createTlvDemuxModule.TlvDemuxOptions;
type TrackKind = createTlvDemuxModule.TrackKind;
type SelectionOptions = {
    videoPacketId: number | null;
    audioPacketId: number | null;
    subtitlePacketId: number | null;
    mseMaxAudioChannels: number;
    indexDurationUs: bigint | null;
};
type CachedResource = createTlvDemuxModule.ApplicationResource & {
    generation: bigint;
};
type ObjectCache = {
    callbacks: Callbacks;
    entries: Map<number, string>;
    applications: Map<string, createTlvDemuxModule.ApplicationState>;
    resources: Map<string, CachedResource>;
    broadcastClock: createTlvDemuxModule.BroadcastClock | null;
};
declare class WorkerClient {
    readonly ready: Promise<void>;
    private readonly worker;
    private readonly pending;
    private readonly caches;
    private nextRequestId;
    private nextObjectId;
    private closed;
    constructor();
    create(objectType: 'duration-probe' | 'demuxer', callbacks?: Callbacks, options?: Partial<SelectionOptions>): Promise<number>;
    invoke<T>(objectId: number, method: string, args?: unknown[], transfer?: Transferable[]): Promise<T>;
    destroy(objectId: number): void;
    cache(objectId: number): ObjectCache | undefined;
    close(): void;
    private request;
    private receive;
    private updateCache;
    private failAll;
}
declare abstract class WorkerObject {
    protected readonly client: WorkerClient;
    protected objectId: number | null;
    protected readonly ready: Promise<number>;
    private closed;
    constructor(client: WorkerClient, objectType: 'duration-probe' | 'demuxer', callbacks?: Callbacks, options?: Partial<SelectionOptions>);
    protected call<T>(method: string, args?: unknown[], transfer?: Transferable[]): Promise<T>;
    delete(): void;
}
export declare class WorkerDurationProbe extends WorkerObject {
    constructor(client: WorkerClient);
    begin(size: bigint, options: createTlvDemuxModule.DurationProbeOptions): Promise<boolean>;
    nextRange(): Promise<createTlvDemuxModule.RangeRequest | null>;
    pushRange(requestId: bigint, offset: bigint, bytes: Uint8Array, endOfRange: boolean): Promise<boolean>;
    state(): Promise<createTlvDemuxModule.DurationProbeState>;
    failure(): Promise<createTlvDemuxModule.DurationProbeFailure>;
    duration(): Promise<createTlvDemuxModule.DurationInfo | null>;
}
export declare class WorkerDemuxer extends WorkerObject {
    constructor(client: WorkerClient, callbacks: Callbacks, options: SelectionOptions);
    initialized(): Promise<void>;
    push(bytes: Uint8Array): Promise<boolean>;
    flush(): Promise<void>;
    reposition(offset: bigint, preserveTimeline: boolean): Promise<void>;
    selectTrack(kind: TrackKind, trackId: bigint | null): Promise<void>;
    setMseOutputEnabled(enabled: boolean): Promise<void>;
    setSubtitlePassthroughEnabled(enabled: boolean): Promise<void>;
    startIndex(growing: boolean): Promise<void>;
    finalizeIndex(): Promise<boolean>;
    estimateOffset(target: bigint, sourceSize: bigint): Promise<bigint | null>;
    applicationEntry(contextId: number): string | null;
    applications(): createTlvDemuxModule.ApplicationState[];
    broadcastClock(): createTlvDemuxModule.BroadcastClock | null;
    applicationResources(contextId?: number): createTlvDemuxModule.ApplicationResourceMetadata[];
    applicationResource(contextId: number, path: string): createTlvDemuxModule.ApplicationResource | null;
    private currentCache;
}
export declare class TlvWorkerClient extends WorkerClient {
    createDurationProbe(): WorkerDurationProbe;
    createDemuxer(callbacks: Callbacks, options: SelectionOptions): WorkerDemuxer;
}
export {};
//# sourceMappingURL=tlv-worker-client.d.ts.map