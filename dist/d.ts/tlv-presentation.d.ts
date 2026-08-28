import * as aribb62js from 'aribb62.js';
import type createTlvDemuxModule from 'tlvdemux';
export declare function createTLVSubtitleRenderer(options: {
    previous: aribb62js.B62TTMLRenderer | null;
    previousOverlay: HTMLElement | null;
    mediaPlane: HTMLElement;
    media: HTMLVideoElement;
    live: boolean;
    visible: boolean;
    rendererOptions?: aribb62js.B62TTMLRendererOptions;
}): {
    renderer: aribb62js.B62TTMLRenderer;
    overlay: HTMLElement;
};
export declare function effectiveTLVToneMappingMode(options: {
    mode: createTlvDemuxModule.MseToneMappingMode;
    sourceTransfer?: number;
    outputState?: {
        connected: boolean;
        edidValid: boolean;
        hlgEotf: boolean;
        pqEotf: boolean;
    } | null;
}): createTlvDemuxModule.MseToneMappingMode;
//# sourceMappingURL=tlv-presentation.d.ts.map