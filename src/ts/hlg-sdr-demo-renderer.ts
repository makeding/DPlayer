import {HlgSdrRenderer as WebGlHlgSdrRenderer} from './hlg-sdr-lut.js';
import {WebGpuHlgSdrRenderer} from './webgpu-hlg-sdr.js';

export default class HlgSdrDemoRenderer {
    private readonly webGpuCanvas = document.createElement('canvas');
    private readonly webGlCanvas = document.createElement('canvas');
    private readonly webGl: WebGlHlgSdrRenderer;
    private readonly webGpu: WebGpuHlgSdrRenderer;
    private readonly layoutObserver: MutationObserver;
    private webGpuRequested = false;

    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement) {
        for (const canvas of [this.webGpuCanvas, this.webGlCanvas]) {
            canvas.className = 'dplayer-hlg-sdr-canvas';
            canvas.setAttribute('aria-hidden', 'true');
            Object.assign(canvas.style, {
                position: 'absolute',
                zIndex: '2',
                inset: '0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
            });
            mediaPlane.append(canvas);
        }

        this.webGl = new WebGlHlgSdrRenderer({
            video,
            canvas: this.webGlCanvas,
            onError: error => console.warn('[DPlayer] HLG-SDR WebGL unavailable:', error),
        });
        this.webGpu = new WebGpuHlgSdrRenderer({
            video,
            canvas: this.webGpuCanvas,
            onError: error => console.warn('[DPlayer] HLG-SDR WebGPU unavailable:', error),
            onLost: () => {
                if (this.webGpuRequested) this.webGl.setEnabled(true);
            },
        });

        this.layoutObserver = new MutationObserver(() => this.syncLayout(video));
        this.layoutObserver.observe(video, {attributes: true, attributeFilter: ['style']});
        this.syncLayout(video);
    }

    setLut(lut: Uint8Array): void {
        this.webGl.setLut(lut);
        this.webGpu.setLut(lut);
        if (this.webGpuRequested) this.preferWebGpu();
    }

    setEnabled(enabled: boolean): void {
        this.webGpuRequested = enabled;
        if (!enabled) {
            this.webGl.setEnabled(false);
            void this.webGpu.setEnabled(false);
            return;
        }
        this.preferWebGpu();
    }

    destroy(): void {
        this.layoutObserver.disconnect();
        this.webGpu.destroy();
        this.webGl.destroy();
        this.webGpuCanvas.remove();
        this.webGlCanvas.remove();
    }

    private preferWebGpu(): void {
        void this.webGpu.setEnabled(true).then(active => {
            if (!this.webGpuRequested) return;
            this.webGl.setEnabled(!active);
        });
    }

    private syncLayout(video: HTMLVideoElement): void {
        const externalPlane = video.style.position === 'absolute' &&
            video.style.width !== '' && video.style.height !== '';
        for (const canvas of [this.webGpuCanvas, this.webGlCanvas]) {
            Object.assign(canvas.style, externalPlane ? {
                inset: 'auto',
                left: video.style.left,
                top: video.style.top,
                width: video.style.width,
                height: video.style.height,
                zIndex: video.style.zIndex || '1',
            } : {
                inset: '0',
                left: 'auto',
                top: 'auto',
                width: '100%',
                height: '100%',
                zIndex: '2',
            });
        }
    }
}
