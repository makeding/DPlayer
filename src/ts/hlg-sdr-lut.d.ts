export type HlgSdrRendererOptions = {
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement;
    onError?: (error: unknown) => void;
};

export class HlgSdrRenderer {
    constructor(options: HlgSdrRendererOptions);
    setEnabled(enabled: boolean): void;
    setLut(lut: Uint8Array): void;
    destroy(): void;
}
