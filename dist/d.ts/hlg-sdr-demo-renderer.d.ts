export default class HlgSdrDemoRenderer {
    private readonly webGpuCanvas;
    private readonly webGlCanvas;
    private readonly webGl;
    private readonly webGpu;
    private readonly layoutObserver;
    private webGpuRequested;
    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement);
    setLut(lut: Uint8Array): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
    private preferWebGpu;
    private syncLayout;
}
//# sourceMappingURL=hlg-sdr-demo-renderer.d.ts.map