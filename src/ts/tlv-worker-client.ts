import type createTlvDemuxModule from 'tlvdemux';
import InlineTlvWorker from 'worker-loader?inline=no-fallback!./tlv-worker';

type ViewerParticipationNotification = {
    contextId: number;
    sourcePacketId: number;
    eventMessageTag: number;
    dataEventId: number;
    messageGroupId: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    inputOffset: bigint;
};
type Callbacks = createTlvDemuxModule.TlvDemuxOptions & {
    onViewerParticipationNotification?: (notification: ViewerParticipationNotification) => void;
};
type TrackKind = createTlvDemuxModule.TrackKind;

type SelectionOptions = {
    videoPacketId: number | null;
    audioPacketId: number | null;
    subtitlePacketId: number | null;
    mseMaxAudioChannels: number;
    indexDurationUs: bigint | null;
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
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

type WorkerMessage = {
    type: 'ready' | 'result' | 'event' | 'failure';
    requestId?: number;
    objectId?: number;
    name?: string;
    value?: unknown;
    error?: {name?: string; message?: string; stack?: string};
};

function remoteError(value: WorkerMessage['error']): Error {
    const error = new Error(value?.message ?? 'tlvdemux worker failed');
    error.name = value?.name ?? 'Error';
    if (value?.stack) error.stack = value.stack;
    return error;
}

function applicationKey(state: createTlvDemuxModule.ApplicationState): string {
    return `${state.contextId}:${state.organizationId}:${state.applicationId}`;
}

function resourceKey(contextId: number, path: string): string {
    return `${contextId}:${path}`;
}

class WorkerClient {
    readonly ready: Promise<void>;
    private readonly worker = new InlineTlvWorker();
    private readonly pending = new Map<number, PendingRequest>();
    private readonly caches = new Map<number, ObjectCache>();
    private nextRequestId = 1;
    private nextObjectId = 1;
    private closed = false;

    constructor() {
        this.worker.onmessage = event => this.receive(event.data as WorkerMessage);
        this.worker.onerror = event => this.failAll(new Error(event.message || 'tlvdemux worker crashed'));
        this.ready = this.request('init').then(() => undefined);
    }

    async create(objectType: 'duration-probe' | 'demuxer', callbacks?: Callbacks,
                 options?: Partial<SelectionOptions>): Promise<number> {
        await this.ready;
        const objectId = this.nextObjectId++;
        if (callbacks) {
            this.caches.set(objectId, {
                callbacks,
                entries: new Map(),
                applications: new Map(),
                resources: new Map(),
                broadcastClock: null,
            });
        }
        await this.request('create', {objectId, objectType, options: options ?? {}});
        return objectId;
    }

    async invoke<T>(objectId: number, method: string, args: unknown[] = [],
                    transfer: Transferable[] = []): Promise<T> {
        await this.ready;
        return this.request('invoke', {objectId, method, args}, transfer) as Promise<T>;
    }

    destroy(objectId: number): void {
        this.caches.delete(objectId);
        if (!this.closed) void this.request('destroy', {objectId}).catch(() => undefined);
    }

    cache(objectId: number): ObjectCache | undefined {
        return this.caches.get(objectId);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.worker.terminate();
        this.failAll(new DOMException('tlvdemux worker closed', 'AbortError'));
        this.caches.clear();
    }

    private request(type: string, fields: Record<string, unknown> = {},
                    transfer: Transferable[] = []): Promise<unknown> {
        if (this.closed) return Promise.reject(new DOMException('tlvdemux worker closed', 'AbortError'));
        const requestId = this.nextRequestId++;
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, {resolve, reject});
        });
        this.worker.postMessage({type, requestId, ...fields}, transfer);
        return promise;
    }

    private receive(message: WorkerMessage): void {
        if (message.type === 'event' && message.objectId !== undefined && message.name) {
            const cache = this.caches.get(message.objectId);
            if (!cache) return;
            this.updateCache(cache, message.name, message.value);
            const callback = (cache.callbacks as unknown as Record<string, unknown>)[message.name];
            if (typeof callback === 'function') (callback as (value: unknown) => void)(message.value);
            return;
        }
        if (message.requestId === undefined) return;
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (message.type === 'failure') pending.reject(remoteError(message.error));
        // null is a meaningful RPC result (for example DurationProbe.nextRange()
        // returns null when probing is complete), so only synthesize true when
        // the worker omitted the value field entirely.
        else pending.resolve(message.value === undefined ? true : message.value);
    }

    private updateCache(cache: ObjectCache, name: string, value: unknown): void {
        if (name === 'onApplicationState') {
            const augmented = value as createTlvDemuxModule.ApplicationState & {applicationEntry?: string | null};
            cache.applications.set(applicationKey(augmented), augmented);
            if (augmented.applicationEntry) cache.entries.set(augmented.contextId, augmented.applicationEntry);
            else cache.entries.delete(augmented.contextId);
        } else if (name === 'onApplicationResource') {
            const resource = value as CachedResource;
            cache.resources.set(resourceKey(resource.contextId, resource.path), resource);
        } else if (name === 'onApplicationResourcesReset') {
            cache.entries.clear();
            cache.applications.clear();
            cache.resources.clear();
        } else if (name === 'onBroadcastClock') {
            cache.broadcastClock = value as createTlvDemuxModule.BroadcastClock;
        }
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}

abstract class WorkerObject {
    protected objectId: number | null = null;
    protected readonly ready: Promise<number>;
    private closed = false;

    constructor(protected readonly client: WorkerClient, objectType: 'duration-probe' | 'demuxer',
                callbacks?: Callbacks, options?: Partial<SelectionOptions>) {
        this.ready = client.create(objectType, callbacks, options).then(objectId => {
            this.objectId = objectId;
            return objectId;
        });
    }

    protected async call<T>(method: string, args: unknown[] = [],
                            transfer: Transferable[] = []): Promise<T> {
        const objectId = await this.ready;
        if (this.closed) throw new DOMException('tlvdemux worker object is closed', 'InvalidStateError');
        return this.client.invoke<T>(objectId, method, args, transfer);
    }

    delete(): void {
        if (this.closed) return;
        this.closed = true;
        void this.ready.then(objectId => this.client.destroy(objectId));
    }
}

export class WorkerDurationProbe extends WorkerObject {
    constructor(client: WorkerClient) { super(client, 'duration-probe'); }
    begin(size: bigint, options: createTlvDemuxModule.DurationProbeOptions): Promise<boolean> {
        return this.call('begin', [size, options]);
    }
    nextRange(): Promise<createTlvDemuxModule.RangeRequest | null> { return this.call('nextRange'); }
    pushRange(requestId: bigint, offset: bigint, bytes: Uint8Array, endOfRange: boolean): Promise<boolean> {
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
        return this.call('pushRange', [requestId, offset, data, endOfRange], [data.buffer as ArrayBuffer]);
    }
    state(): Promise<createTlvDemuxModule.DurationProbeState> { return this.call('state'); }
    failure(): Promise<createTlvDemuxModule.DurationProbeFailure> { return this.call('failure'); }
    duration(): Promise<createTlvDemuxModule.DurationInfo | null> { return this.call('duration'); }
}

export class WorkerDemuxer extends WorkerObject {
    constructor(client: WorkerClient, callbacks: Callbacks, options: SelectionOptions) {
        super(client, 'demuxer', callbacks, options);
    }

    initialized(): Promise<void> { return this.ready.then(() => undefined); }
    push(bytes: Uint8Array): Promise<boolean> {
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
        return this.call('push', [data], [data.buffer as ArrayBuffer]);
    }
    flush(): Promise<void> { return this.call('flush'); }
    reposition(offset: bigint, preserveTimeline: boolean): Promise<void> {
        return this.call('reposition', [offset, preserveTimeline]);
    }
    selectTrack(kind: TrackKind, trackId: bigint | null): Promise<void> {
        return this.call('selectTrack', [kind, trackId]);
    }
    setMseOutputEnabled(enabled: boolean): Promise<void> { return this.call('setMseOutputEnabled', [enabled]); }
    setSubtitlePassthroughEnabled(enabled: boolean): Promise<void> {
        return this.call('setSubtitlePassthroughEnabled', [enabled]);
    }
    startIndex(growing: boolean): Promise<void> { return this.call('startIndex', [growing]); }
    finalizeIndex(): Promise<boolean> { return this.call('finalizeIndex'); }
    estimateOffset(target: bigint, sourceSize: bigint): Promise<bigint | null> {
        return this.call('estimateOffset', [target, sourceSize]);
    }

    applicationEntry(contextId: number): string | null {
        return this.currentCache()?.entries.get(contextId) ?? null;
    }
    applications(): createTlvDemuxModule.ApplicationState[] {
        return [...(this.currentCache()?.applications.values() ?? [])];
    }
    broadcastClock(): createTlvDemuxModule.BroadcastClock | null {
        return this.currentCache()?.broadcastClock ?? null;
    }
    applicationResources(contextId?: number): createTlvDemuxModule.ApplicationResourceMetadata[] {
        const resources = [...(this.currentCache()?.resources.values() ?? [])];
        return resources.filter(resource => contextId === undefined || resource.contextId === contextId)
            .map(resource => ({
                contextId: resource.contextId,
                componentTag: resource.componentTag,
                transactionId: resource.transactionId,
                downloadId: resource.downloadId,
                mpuSequenceNumber: resource.mpuSequenceNumber,
                itemId: resource.itemId,
                version: resource.version,
                path: resource.path,
                contentType: resource.contentType,
                size: resource.data.byteLength,
                generation: resource.generation,
            }));
    }
    applicationResource(contextId: number, path: string): createTlvDemuxModule.ApplicationResource | null {
        const resource = this.currentCache()?.resources.get(resourceKey(contextId, path));
        if (!resource) return null;
        return {...resource, data: resource.data.slice()};
    }

    private currentCache(): ObjectCache | undefined {
        return this.objectId === null ? undefined : this.client.cache(this.objectId);
    }
}

export class TlvWorkerClient extends WorkerClient {
    createDurationProbe(): WorkerDurationProbe { return new WorkerDurationProbe(this); }
    createDemuxer(callbacks: Callbacks, options: SelectionOptions): WorkerDemuxer {
        return new WorkerDemuxer(this, callbacks, options);
    }
}
