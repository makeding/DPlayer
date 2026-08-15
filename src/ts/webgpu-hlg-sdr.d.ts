export type WebGpuHlgSdrRendererOptions = {
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement;
    onError?: (error: unknown) => void;
    onLost?: () => void;
};

export class WebGpuHlgSdrRenderer {
    constructor(options: WebGpuHlgSdrRendererOptions);
    setEnabled(enabled: boolean): Promise<boolean>;
    setLut(lut: Uint8Array): void;
    destroy(): void;
}
