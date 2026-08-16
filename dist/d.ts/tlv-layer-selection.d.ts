import type * as DPlayerType from './types';
export interface TLVLayer {
    video: DPlayerType.TLVTrackInfo;
    audio: DPlayerType.TLVTrackInfo;
}
export interface TLVLayerPair {
    preferred: TLVLayer;
    fallback: TLVLayer | null;
}
export declare function selectionLevel(track: DPlayerType.TLVTrackInfo, groupIdentification?: number | null): number | null;
export declare function sameVideoLayerGroup(left: DPlayerType.TLVTrackInfo, right: DPlayerType.TLVTrackInfo): boolean;
export declare function resolveTLVLayerPair(tracks: readonly DPlayerType.TLVTrackInfo[], currentVideo: DPlayerType.TLVTrackInfo, currentAudio: DPlayerType.TLVTrackInfo): TLVLayerPair | null;
//# sourceMappingURL=tlv-layer-selection.d.ts.map