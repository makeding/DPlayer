import {
    configureAutomaticLayerPair,
    currentMptTracks,
    resolveLayerPair,
} from 'tlvdemux/track-selection';
import type {LayerPair, PlaybackTrack} from 'tlvdemux/track-selection';

import type * as DPlayerType from './types';

export interface TLVLayer {
    video: DPlayerType.TLVTrackInfo;
    audio: DPlayerType.TLVTrackInfo;
}

export interface TLVLayerPair {
    preferred: TLVLayer;
    fallback: TLVLayer | null;
}

export function availableMptTracks(
    snapshotTracks: readonly DPlayerType.TLVTrackInfo[],
    selectableTracks: readonly DPlayerType.TLVTrackInfo[],
): DPlayerType.TLVTrackInfo[] {
    return currentMptTracks(
        snapshotTracks as unknown as Iterable<PlaybackTrack>,
        selectableTracks as unknown as Iterable<PlaybackTrack>,
    ) as unknown as DPlayerType.TLVTrackInfo[];
}

export async function selectManualTLVLayer(
    disableAutomatic: () => Promise<void>,
    switchLayer: () => Promise<void>,
    restoreAutomatic?: () => Promise<void>,
): Promise<void> {
    await disableAutomatic();
    try {
        await switchLayer();
    } catch (error) {
        if (restoreAutomatic) {
            try {
                await restoreAutomatic();
            } catch (restoreError) {
                const switchMessage = error instanceof Error ? error.message : String(error);
                const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
                throw new Error(`${switchMessage} Automatic mode rollback failed: ${restoreMessage}`);
            }
        }
        throw error;
    }
}

export async function selectAutomaticTLVLayer(options: {
    pair: TLVLayerPair | null;
    currentVideoTrackId?: bigint;
    currentAudioTrackId?: bigint;
    previousLayer: TLVLayer | null;
    switchLayer: (layer: TLVLayer) => Promise<void>;
    setAutomaticMode: () => void;
    enableAutomatic: () => Promise<void>;
    setPreviousMode: () => void;
    disableAutomatic: () => Promise<void>;
}): Promise<void> {
    try {
        if (options.pair && (options.currentVideoTrackId !== options.pair.preferred.video.trackId ||
            options.currentAudioTrackId !== options.pair.preferred.audio.trackId)) {
            await options.switchLayer(options.pair.preferred);
        }
        options.setAutomaticMode();
        await options.enableAutomatic();
    } catch (error) {
        options.setPreviousMode();
        try {
            await options.disableAutomatic();
            if (options.previousLayer) await options.switchLayer(options.previousLayer);
        } catch (restoreError) {
            const message = error instanceof Error ? error.message : String(error);
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(`${message} Manual mode rollback failed: ${restoreMessage}`);
        }
        throw error;
    }
}

export function configureAutomaticTLVLayer(
    demuxer: {
        suspendAutomaticLayerSwitch(
            preferredVideoTrackId: bigint,
            preferredAudioTrackId: bigint,
            fallbackVideoTrackId: bigint,
            fallbackAudioTrackId: bigint,
        ): Promise<void>;
        clearAutomaticLayerSwitch(): Promise<void>;
        configureAutomaticLayerSwitch(
            preferredVideoTrackId: bigint,
            preferredAudioTrackId: bigint,
            fallbackVideoTrackId: bigint,
            fallbackAudioTrackId: bigint,
        ): Promise<void>;
    },
    pair: TLVLayerPair | null,
    previousSignature: string | null,
    manual: boolean,
    force = false,
): Promise<string> {
    return configureAutomaticLayerPair(
        demuxer as unknown as Parameters<typeof configureAutomaticLayerPair>[0],
        pair as unknown as LayerPair,
        previousSignature,
        {manual, force},
    );
}

export function resolveTLVLayerPair(
    tracks: readonly DPlayerType.TLVTrackInfo[],
    currentVideo: DPlayerType.TLVTrackInfo,
    currentAudio: DPlayerType.TLVTrackInfo,
): TLVLayerPair | null {
    return resolveLayerPair(
        tracks as unknown as Iterable<PlaybackTrack>,
        currentVideo as unknown as PlaybackTrack,
        currentAudio as unknown as PlaybackTrack,
    ) as unknown as TLVLayerPair | null;
}
