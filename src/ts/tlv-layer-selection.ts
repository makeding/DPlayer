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
    return snapshotTracks.filter(snapshotTrack => selectableTracks.some(selectable =>
        selectable.kind === snapshotTrack.kind && selectable.trackId === snapshotTrack.trackId &&
        selectable.packetId === snapshotTrack.packetId && selectable.contextId === snapshotTrack.contextId));
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

export async function configureAutomaticTLVLayer(
    demuxer: {
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
    if (manual) {
        if (force || previousSignature !== 'disabled') await demuxer.clearAutomaticLayerSwitch();
        return 'disabled';
    }
    if (!pair?.fallback) {
        if (force || previousSignature !== 'unavailable') await demuxer.clearAutomaticLayerSwitch();
        return 'unavailable';
    }
    const signature = [
        pair.preferred.video.trackId,
        pair.preferred.audio.trackId,
        pair.fallback.video.trackId,
        pair.fallback.audio.trackId,
    ].join(':');
    if (force || signature !== previousSignature) {
        await demuxer.configureAutomaticLayerSwitch(
            pair.preferred.video.trackId, pair.preferred.audio.trackId,
            pair.fallback.video.trackId, pair.fallback.audio.trackId,
        );
    }
    return signature;
}

export function selectionLevel(
    track: DPlayerType.TLVTrackInfo,
    groupIdentification: number | null = null,
): number | null {
    const group = track.assetGroups.find(candidate =>
        groupIdentification === null || candidate.groupIdentification === groupIdentification);
    if (group) return group.selectionLevel;
    return track.kind === 'video' && groupIdentification === null && track.assetGroups.length === 0 ? 0 : null;
}

export function sameVideoLayerGroup(
    left: DPlayerType.TLVTrackInfo,
    right: DPlayerType.TLVTrackInfo,
): boolean {
    if (left.kind !== 'video' || right.kind !== 'video' || left.contextId !== right.contextId) return false;
    if (!left.assetGroups.length || !right.assetGroups.length) return true;
    return left.assetGroups.some(leftGroup => right.assetGroups.some(rightGroup =>
        leftGroup.groupIdentification === rightGroup.groupIdentification));
}

function correspondingAudioTrack(
    tracks: readonly DPlayerType.TLVTrackInfo[],
    current: DPlayerType.TLVTrackInfo,
    targetLevel: number | null,
): DPlayerType.TLVTrackInfo | null {
    if (targetLevel === null) return null;
    const groupIds = current.assetGroups.map(group => group.groupIdentification);
    for (const groupId of groupIds) {
        const track = tracks.find(candidate => candidate.kind === 'audio' && candidate.assetGroups.some(group =>
            group.groupIdentification === groupId && group.selectionLevel === targetLevel));
        if (track) return track;
    }
    return null;
}

export function resolveTLVLayerPair(
    tracks: readonly DPlayerType.TLVTrackInfo[],
    currentVideo: DPlayerType.TLVTrackInfo,
    currentAudio: DPlayerType.TLVTrackInfo,
): TLVLayerPair | null {
    const videos = tracks
        .filter(track => sameVideoLayerGroup(currentVideo, track))
        .sort((left, right) =>
            (selectionLevel(left) ?? 0xff) - (selectionLevel(right) ?? 0xff));
    const preferredVideo = videos[0];
    if (!preferredVideo) return null;
    const preferredLevel = selectionLevel(preferredVideo);
    const preferredAudio = correspondingAudioTrack(tracks, currentAudio, preferredLevel);
    if (!preferredAudio) return null;
    const fallbackVideo = videos.find(track =>
        selectionLevel(track) !== null && selectionLevel(track)! > (preferredLevel ?? 0xff));
    const fallbackLevel = fallbackVideo ? selectionLevel(fallbackVideo) : null;
    const fallbackAudio = fallbackVideo ? correspondingAudioTrack(tracks, currentAudio, fallbackLevel) : null;
    return {
        preferred: {video: preferredVideo, audio: preferredAudio},
        fallback: fallbackVideo && fallbackAudio ? {video: fallbackVideo, audio: fallbackAudio} : null,
    };
}
