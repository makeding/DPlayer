import createTlvDemuxModule from 'tlvdemux';

const scope = globalThis as unknown as {
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
    onmessage: ((event: MessageEvent) => void) | null;
};
const applicationDrainBatch = 32;
const objects = new Map<number, Record<string, any>>();
const modulePromise = createTlvDemuxModule();
let operationQueue = Promise.resolve();

function serializeError(error: unknown): {name: string; message: string; stack: string} {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {name: normalized.name, message: normalized.message, stack: normalized.stack ?? ''};
}

function sendEvent(objectId: number, name: string, value: unknown, transfer: Transferable[] = []): void {
    scope.postMessage({type: 'event', objectId, name, value}, transfer);
}

function copyBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(source.byteLength);
    output.set(source);
    return output;
}

function subtitlePriority(track: createTlvDemuxModule.TrackInfo): number {
    if (track.componentTag >= 0x30 && track.componentTag <= 0x37) return 2;
    if (track.componentTag >= 0x38 && track.componentTag <= 0x3f) return 1;
    return 0;
}

function automaticSelection(record: Record<string, any>, track: createTlvDemuxModule.TrackInfo): void {
    const selection = record.selection;
    if (track.kind === 'video') {
        if (selection.videoPacketId !== null && track.packetId !== selection.videoPacketId) return;
        if (selection.videoTrack !== null) return;
        selection.videoTrack = track.trackId;
        record.instance.selectTrack('video', track.trackId);
        if (record.indexDurationUs !== null) record.instance.setIndexDuration(record.indexDurationUs);
    } else if (track.kind === 'audio') {
        if (selection.audioPacketId !== null && track.packetId !== selection.audioPacketId) return;
        if (selection.audioTrack !== null) return;
        const channels = Number(track.audio?.channels ?? 0);
        if (selection.maxAudioChannels > 0 && channels > selection.maxAudioChannels) return;
        selection.audioTrack = track.trackId;
        record.instance.selectTrack('audio', track.trackId);
    } else if (track.kind === 'subtitle' && track.codec === 'ttml') {
        if (selection.subtitlePacketId !== null && track.packetId !== selection.subtitlePacketId) return;
        if (selection.subtitlePacketId === null &&
            selection.subtitleTrack !== null && subtitlePriority(track) <= selection.subtitlePriority) return;
        selection.subtitleTrack = track.trackId;
        selection.subtitlePriority = subtitlePriority(track);
        record.instance.selectTrack('subtitle', track.trackId);
    }
}

function transferAccessUnit(objectId: number, unit: createTlvDemuxModule.AccessUnit): void {
    const data = unit.codec === 'ttml' ? copyBytes(unit.data) : new Uint8Array(0);
    // Playback access-unit payloads are callback-lifetime WASM views. Copy only
    // the TTML bytes that must cross the worker boundary, then transfer ownership.
    const resources = unit.subtitleResources.map(resource => ({...resource, data: copyBytes(resource.data)}));
    sendEvent(objectId, 'onAccessUnitView', {...unit, data, subtitleResources: resources}, [
        data.buffer,
        ...resources.map(resource => resource.data.buffer as ArrayBuffer),
    ]);
}

async function createDemuxer(objectId: number, options: Record<string, any>): Promise<Record<string, any>> {
    const module = await modulePromise;
    const record: Record<string, any> = {
        type: 'demuxer',
        module,
        instance: null,
        objectId,
        inputAddress: 0,
        inputCapacity: 0,
        applicationDrainScheduled: false,
        applicationDrainError: null,
        indexDurationUs: options.indexDurationUs ?? null,
        selection: {
            videoPacketId: options.videoPacketId ?? null,
            audioPacketId: options.audioPacketId ?? null,
            subtitlePacketId: options.subtitlePacketId ?? null,
            maxAudioChannels: Number(options.mseMaxAudioChannels || 0),
            videoTrack: null,
            audioTrack: null,
            subtitleTrack: null,
            subtitlePriority: -1,
        },
    };
    const event = (name: string) => (value?: unknown): void => sendEvent(objectId, name, value);
    record.instance = new module.TlvDemuxer({
        mseMaxAudioChannels: record.selection.maxAudioChannels,
        onMseVideoStart: event('onMseVideoStart'),
        onMseInit(init) { sendEvent(objectId, 'onMseInit', init, [init.data.buffer]); },
        onMseSegment(segment) { sendEvent(objectId, 'onMseSegment', segment, [segment.data.buffer]); },
        onTrack(track) {
            automaticSelection(record, track);
            sendEvent(objectId, 'onTrack', track);
        },
        onBroadcastClock: event('onBroadcastClock'),
        onEventInfo: event('onEventInfo'),
        onStreamEvent: event('onStreamEvent'),
        onApplicationResourceView(resource) {
            const data = copyBytes(resource.data);
            sendEvent(objectId, 'onApplicationResource', {
                ...resource,
                data,
                generation: record.instance.applicationResourceGeneration(),
            }, [data.buffer]);
        },
        onApplicationState(state) {
            sendEvent(objectId, 'onApplicationState', {
                ...state,
                applicationEntry: record.instance.applicationEntry(state.contextId),
            });
        },
        onApplicationResourcesReset: event('onApplicationResourcesReset'),
        onPlaybackAccessUnitView(unit) { transferAccessUnit(objectId, unit); },
        onError: event('onError'),
    });
    return record;
}

function ensureInputCapacity(record: Record<string, any>, byteLength: number): void {
    if (byteLength <= record.inputCapacity) return;
    const capacity = Math.ceil(byteLength / (64 * 1024)) * 64 * 1024;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError(`Invalid TLV input size: ${byteLength}`);
    const address = record.module._malloc(capacity);
    if (!address) throw new RangeError(`Could not allocate ${capacity} bytes of WASM input memory.`);
    if (record.inputAddress) record.module._free(record.inputAddress);
    record.inputAddress = address;
    record.inputCapacity = capacity;
}

function pushBytes(record: Record<string, any>, bytes: Uint8Array): boolean {
    if (!bytes.byteLength) return record.instance.pushFromHeap(0, 0);
    ensureInputCapacity(record, bytes.byteLength);
    record.module.HEAPU8.set(bytes, record.inputAddress);
    return record.instance.pushFromHeap(record.inputAddress, bytes.byteLength);
}

function scheduleApplicationDrain(record: Record<string, any>): void {
    if (record.applicationDrainScheduled) return;
    record.applicationDrainScheduled = true;
    setTimeout(() => {
        operationQueue = operationQueue.then(() => {
            record.applicationDrainScheduled = false;
            if (objects.get(record.objectId) !== record) return;
            try {
                drainApplications(record, false);
            } catch (error) {
                record.applicationDrainError = error;
            }
        });
    }, 0);
}

function drainApplications(record: Record<string, any>, exhaustive: boolean): void {
    if (record.type !== 'demuxer') return;
    let more = record.instance.drainApplicationResources(applicationDrainBatch);
    if (exhaustive) while (more) more = record.instance.drainApplicationResources(applicationDrainBatch);
    else if (more) scheduleApplicationDrain(record);
}

async function dispatch(message: Record<string, any>): Promise<void> {
    try {
        if (message.type === 'init') {
            await modulePromise;
            scope.postMessage({type: 'ready', requestId: message.requestId, value: true});
            return;
        }
        if (message.type === 'create') {
            const module = await modulePromise;
            const record = message.objectType === 'demuxer'
                ? await createDemuxer(message.objectId, message.options ?? {})
                : {type: 'duration-probe', instance: new module.DurationProbe(), objectId: message.objectId};
            objects.set(message.objectId, record);
            scope.postMessage({type: 'result', requestId: message.requestId, value: true});
            return;
        }
        if (message.type === 'destroy') {
            const record = objects.get(message.objectId);
            if (record) {
                if (record.inputAddress) record.module._free(record.inputAddress);
                record.instance.delete();
                objects.delete(message.objectId);
            }
            scope.postMessage({type: 'result', requestId: message.requestId, value: true});
            return;
        }
        if (message.type !== 'invoke') return;
        const record = objects.get(message.objectId);
        if (!record) throw new Error(`Worker object ${message.objectId} does not exist.`);
        if (record.applicationDrainError) throw record.applicationDrainError;
        const value = record.type === 'demuxer' && message.method === 'push'
            ? pushBytes(record, message.args[0])
            : record.instance[message.method](...(message.args ?? []));
        if (message.method === 'push' || message.method === 'flush') {
            drainApplications(record, message.method === 'flush');
        }
        scope.postMessage({type: 'result', requestId: message.requestId, value});
    } catch (error) {
        scope.postMessage({type: 'failure', requestId: message.requestId, error: serializeError(error)});
    }
}

scope.onmessage = event => {
    operationQueue = operationQueue.then(() => dispatch(event.data));
};
