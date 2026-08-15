import type createTlvDemuxModule from 'tlvdemux';
type ColorLut = createTlvDemuxModule.HlgSdrColorLut;
export default class HlgSdrRenderer {
    private readonly webGpuCanvas;
    private readonly webGlCanvas;
    private readonly webGl;
    private readonly webGpu;
    private readonly layoutObserver;
    private readonly resizeObserver;
    private webGpuRequested;
    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement);
    setColorLut(lut: ColorLut): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
    private preferWebGpu;
    private syncLayout;
}
export {};
//# sourceMappingURL=hlg-sdr-renderer.d.ts.map