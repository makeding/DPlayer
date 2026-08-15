import type createTlvDemuxModule from 'tlvdemux';

export type HlgSdrRendererBackend = 'WebGPU' | 'WebGL';

export interface HlgSdrRendererOptions {
    video: HTMLVideoElement;
    webGpuCanvas: HTMLCanvasElement;
    webGlCanvas: HTMLCanvasElement;
    onError?: (backend: HlgSdrRendererBackend, error: unknown) => void;
    onBackendChange?: (backend: HlgSdrRendererBackend) => void;
}

export class HlgSdrRenderer {
    constructor(options: HlgSdrRendererOptions);
    setColorLut(lut: createTlvDemuxModule.HlgSdrColorLut): void;
    setComparisonEnabled(enabled: boolean): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
}
