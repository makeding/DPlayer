import type * as DPlayerType from './types';
export interface TLVLayer {
    video: DPlayerType.TLVTrackInfo;
    audio: DPlayerType.TLVTrackInfo;
}
export interface TLVLayerPair {
    preferred: TLVLayer;
    fallback: TLVLayer | null;
}
export declare function availableMptTracks(snapshotTracks: readonly DPlayerType.TLVTrackInfo[], selectableTracks: readonly DPlayerType.TLVTrackInfo[]): DPlayerType.TLVTrackInfo[];
export declare function selectManualTLVLayer(disableAutomatic: () => Promise<void>, switchLayer: () => Promise<void>, restoreAutomatic?: () => Promise<void>): Promise<void>;
export declare function selectAutomaticTLVLayer(options: {
    pair: TLVLayerPair | null;
    currentVideoTrackId?: bigint;
    currentAudioTrackId?: bigint;
    previousLayer: TLVLayer | null;
    switchLayer: (layer: TLVLayer) => Promise<void>;
    setAutomaticMode: () => void;
    enableAutomatic: () => Promise<void>;
    setPreviousMode: () => void;
    disableAutomatic: () => Promise<void>;
}): Promise<void>;
export declare function configureAutomaticTLVLayer(demuxer: {
    clearAutomaticLayerSwitch(): Promise<void>;
    configureAutomaticLayerSwitch(preferredVideoTrackId: bigint, preferredAudioTrackId: bigint, fallbackVideoTrackId: bigint, fallbackAudioTrackId: bigint): Promise<void>;
}, pair: TLVLayerPair | null, previousSignature: string | null, manual: boolean, force?: boolean): Promise<string>;
export declare function selectionLevel(track: DPlayerType.TLVTrackInfo, groupIdentification?: number | null): number | null;
export declare function sameVideoLayerGroup(left: DPlayerType.TLVTrackInfo, right: DPlayerType.TLVTrackInfo): boolean;
export declare function resolveTLVLayerPair(tracks: readonly DPlayerType.TLVTrackInfo[], currentVideo: DPlayerType.TLVTrackInfo, currentAudio: DPlayerType.TLVTrackInfo): TLVLayerPair | null;
//# sourceMappingURL=tlv-layer-selection.d.ts.map