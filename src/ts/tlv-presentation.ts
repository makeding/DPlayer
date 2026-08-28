import * as aribb62js from 'aribb62.js';
import type createTlvDemuxModule from 'tlvdemux';

export function createTLVSubtitleRenderer(options: {
    previous: aribb62js.B62TTMLRenderer | null;
    previousOverlay: HTMLElement | null;
    mediaPlane: HTMLElement;
    media: HTMLVideoElement;
    live: boolean;
    visible: boolean;
    rendererOptions?: aribb62js.B62TTMLRendererOptions;
}): {renderer: aribb62js.B62TTMLRenderer; overlay: HTMLElement} {
    options.previous?.destroy();
    options.previousOverlay?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'dplayer-aribb62-subtitle';
    Object.assign(overlay.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        overflow: 'hidden',
    });
    options.mediaPlane.append(overlay);
    const renderer = new aribb62js.B62TTMLRenderer({
        ...(options.rendererOptions ?? {}),
        mediaElement: options.media,
        overlayElement: overlay,
        isLive: options.live,
    });
    renderer.setTrackVisibility('caption', options.visible);
    renderer.render();
    return {renderer, overlay};
}

export function effectiveTLVToneMappingMode(options: {
    mode: createTlvDemuxModule.MseToneMappingMode;
    sourceTransfer?: number;
    outputState?: {connected: boolean; edidValid: boolean; hlgEotf: boolean; pqEotf: boolean} | null;
}): createTlvDemuxModule.MseToneMappingMode {
    if (options.mode === 'force' || options.mode === 'on_compare') return 'prototype';
    if (options.mode === 'off') return 'off';
    if (options.sourceTransfer !== undefined && options.outputState?.connected && options.outputState.edidValid) {
        const sinkSupportsSource = options.sourceTransfer === 18
            ? options.outputState.hlgEotf
            : options.sourceTransfer === 16 && options.outputState.pqEotf;
        return sinkSupportsSource ? 'off' : 'prototype';
    }
    const hdrOutput = matchMedia('(video-dynamic-range: high)').matches ||
        matchMedia('(dynamic-range: high)').matches;
    return hdrOutput ? 'off' : 'prototype';
}
