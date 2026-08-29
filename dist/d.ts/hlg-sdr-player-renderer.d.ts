import type createTlvDemuxModule from 'tlvdemux';
export default class HlgSdrPlayerRenderer {
    private readonly webGpuCanvas;
    private readonly webGlCanvas;
    private readonly renderer;
    private readonly layoutObserver;
    private video;
    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement);
    setVideoElement(video: HTMLVideoElement): void;
    setColorLut(lut: createTlvDemuxModule.HlgSdrColorLut): void;
    setComparisonEnabled(enabled: boolean): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
    private syncLayout;
}
//# sourceMappingURL=hlg-sdr-player-renderer.d.ts.map