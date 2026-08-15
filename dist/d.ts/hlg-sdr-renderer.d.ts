export default class HlgSdrRenderer {
    private readonly webGpuCanvas;
    private readonly webGlCanvas;
    private readonly webGpu;
    private readonly webGl;
    private readonly layoutObserver;
    private readonly resizeObserver;
    private enabled;
    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement);
    setLut(lut: Uint8Array): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
    private syncLayout;
}
//# sourceMappingURL=hlg-sdr-renderer.d.ts.map