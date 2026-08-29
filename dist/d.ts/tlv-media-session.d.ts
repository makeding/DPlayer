export type TLVDynamicMedia = HTMLMediaElement & {
    readonly videoFrameCallbackSupported: boolean;
};
/** Keep SDK recovery and transition controllers bound to the currently visible media element. */
export declare function createTLVDynamicMedia(getMedia: () => HTMLVideoElement): TLVDynamicMedia;
export declare function openDetachedTLVMediaSource(MediaSourceClass: typeof MediaSource, media: HTMLMediaElement, lifecycle: {
    waitUntilPlaybackResumed(): Promise<void>;
}): Promise<{
    mediaSource: MediaSource;
    url: string;
}>;
export declare function promoteTLVMedia(previous: HTMLVideoElement, candidate: HTMLVideoElement, rebind: (candidate: HTMLVideoElement, previous: HTMLVideoElement) => void): HTMLVideoElement;
/** Restore the old visible element when a consumer-side commit step fails. */
export declare function restoreTLVMedia(previous: HTMLVideoElement, candidate: HTMLVideoElement, rebind: (previous: HTMLVideoElement, candidate: HTMLVideoElement) => void): void;
//# sourceMappingURL=tlv-media-session.d.ts.map