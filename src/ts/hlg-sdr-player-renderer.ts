import type createTlvDemuxModule from 'tlvdemux';
import {HlgSdrRenderer} from 'tlvdemux/hlg-sdr-renderer';

export default class HlgSdrPlayerRenderer {
    private readonly webGpuCanvas = document.createElement('canvas');
    private readonly webGlCanvas = document.createElement('canvas');
    private readonly renderer: HlgSdrRenderer;
    private readonly layoutObserver: MutationObserver;

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

        this.renderer = new HlgSdrRenderer({
            video,
            webGpuCanvas: this.webGpuCanvas,
            webGlCanvas: this.webGlCanvas,
            onError: (backend, error) => console.warn(`[DPlayer] HLG-SDR ${backend} unavailable:`, error),
        });
        this.layoutObserver = new MutationObserver(() => this.syncLayout(video));
        this.layoutObserver.observe(video, {attributes: true, attributeFilter: ['style']});
        this.syncLayout(video);
    }

    setColorLut(lut: createTlvDemuxModule.HlgSdrColorLut): void {
        this.renderer.setColorLut(lut);
    }

    setComparisonEnabled(enabled: boolean): void {
        this.renderer.setComparisonEnabled(enabled);
    }

    setEnabled(enabled: boolean): void {
        this.renderer.setEnabled(enabled);
    }

    destroy(): void {
        this.layoutObserver.disconnect();
        this.renderer.destroy();
        this.webGpuCanvas.remove();
        this.webGlCanvas.remove();
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
