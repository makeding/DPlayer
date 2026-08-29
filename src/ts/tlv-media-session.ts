import {promoteMseCandidateMedia} from 'tlvdemux/mse-live-transition';

export type TLVDynamicMedia = HTMLMediaElement & {
    readonly videoFrameCallbackSupported: boolean;
};

/** Keep SDK recovery and transition controllers bound to the currently visible media element. */
export function createTLVDynamicMedia(getMedia: () => HTMLVideoElement): TLVDynamicMedia {
    return {
        get currentTime() { return getMedia().currentTime; },
        set currentTime(value) { getMedia().currentTime = value; },
        get paused() { return getMedia().paused; },
        get seeking() { return getMedia().seeking; },
        get ended() { return getMedia().ended; },
        get error() { return getMedia().error; },
        get buffered() { return getMedia().buffered; },
        get videoFrameCallbackSupported() {
            return typeof getMedia().requestVideoFrameCallback === 'function';
        },
        play() { return getMedia().play(); },
        pause() { getMedia().pause(); },
        requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
            const media = getMedia();
            const id = media.requestVideoFrameCallback(callback);
            return {media, id} as unknown as number;
        },
        cancelVideoFrameCallback(request: number) {
            const owned = request as unknown as {media?: HTMLVideoElement; id?: number};
            if (owned.media && owned.id !== undefined) owned.media.cancelVideoFrameCallback?.(owned.id);
        },
    } as unknown as TLVDynamicMedia;
}

export async function openDetachedTLVMediaSource(
    MediaSourceClass: typeof MediaSource,
    media: HTMLMediaElement,
    lifecycle: {waitUntilPlaybackResumed(): Promise<void>},
): Promise<{mediaSource: MediaSource; url: string}> {
    const mediaSource = new MediaSourceClass();
    const opened = mediaSource.readyState === 'open' ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        mediaSource.addEventListener('sourceopen', () => resolve(), {once: true});
        mediaSource.addEventListener('sourceclose', () => reject(
            new Error('MediaSource closed before opening.'),
        ), {once: true});
    });
    const url = URL.createObjectURL(mediaSource);
    const ManagedMediaSourceClass = (globalThis as typeof globalThis & {
        ManagedMediaSource?: typeof MediaSource;
    }).ManagedMediaSource;
    if (ManagedMediaSourceClass && mediaSource instanceof ManagedMediaSourceClass) {
        media.disableRemotePlayback = true;
    }
    media.src = url;
    media.load();
    try {
        if (ManagedMediaSourceClass && mediaSource instanceof ManagedMediaSourceClass) {
            await lifecycle.waitUntilPlaybackResumed();
            await media.play();
        }
        await opened;
    } catch (error) {
        media.pause();
        media.removeAttribute('src');
        media.load();
        URL.revokeObjectURL(url);
        throw error;
    }
    return {mediaSource, url};
}

export function promoteTLVMedia(
    previous: HTMLVideoElement,
    candidate: HTMLVideoElement,
    rebind: (candidate: HTMLVideoElement, previous: HTMLVideoElement) => void,
): HTMLVideoElement {
    const previousStyle = previous.getAttribute('style');
    candidate.className = previous.className;
    candidate.poster = previous.poster;
    candidate.preload = previous.preload;
    candidate.crossOrigin = previous.crossOrigin;
    candidate.disableRemotePlayback = previous.disableRemotePlayback;
    const previousId = previous.id;
    const parent = previous.parentNode;
    const nextSibling = previous.nextSibling;
    try {
        return promoteMseCandidateMedia({
            previousMedia: previous,
            candidateMedia: candidate,
            rebind: (next, old) => {
                if (previousStyle === null) next.removeAttribute('style');
                else next.setAttribute('style', previousStyle);
                rebind(next as HTMLVideoElement, old as HTMLVideoElement);
            },
        }) as HTMLVideoElement;
    } catch (error) {
        // Upstream promotion replaces the DOM node before calling rebind. Restore
        // the authoritative element if a consumer callback rejects the commit.
        candidate.removeAttribute('id');
        previous.id = previousId;
        if (candidate.parentNode) candidate.replaceWith(previous);
        else if (parent && !previous.parentNode) parent.insertBefore(previous, nextSibling);
        throw error;
    }
}

/** Restore the old visible element when a consumer-side commit step fails. */
export function restoreTLVMedia(
    previous: HTMLVideoElement,
    candidate: HTMLVideoElement,
    rebind: (previous: HTMLVideoElement, candidate: HTMLVideoElement) => void,
): void {
    const id = candidate.id;
    candidate.removeAttribute('id');
    previous.id = id;
    if (candidate.parentNode) candidate.replaceWith(previous);
    rebind(previous, candidate);
}
