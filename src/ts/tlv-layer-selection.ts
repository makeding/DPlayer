import type * as DPlayerType from './types';

export interface TLVLayer {
    video: DPlayerType.TLVTrackInfo;
    audio: DPlayerType.TLVTrackInfo;
}

export interface TLVLayerPair {
    preferred: TLVLayer;
    fallback: TLVLayer | null;
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
