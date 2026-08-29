import { MsePlaybackMode } from 'tlvdemux/mse-playback';
import type { MsePlaybackModeValue } from 'tlvdemux/mse-playback';
export type TLVRequiredTrack = 'video' | 'audio';
/** Apply one required-track invariant to both MSE buffering layers. */
export declare function applyTLVRequiredTracks(options: {
    pipeline: {
        setRequiredTracks(required: readonly TLVRequiredTrack[]): void;
    } | null;
    flow: {
        setRequiredTracks(required: readonly TLVRequiredTrack[], currentTime: number): void;
    } | null;
    required: readonly TLVRequiredTrack[];
    currentTime: number;
    restartPlayback(): void;
}): void;
/**
 * Enter audio-only without ever mutating the authoritative MediaSource after a
 * detached candidate fails. A later RAP is responsible for the next attempt.
 */
export declare function requestTLVAudioOnlyTransition(options: {
    setRequiredTracks(required: readonly TLVRequiredTrack[]): void;
    activateInPlace(): Promise<{
        changed: boolean;
    }>;
    currentMode(): MsePlaybackModeValue | null;
    transition: ((mode: typeof MsePlaybackMode.AUDIO_ONLY, target: number) => Promise<unknown>) | null;
    currentTime(): number;
}): Promise<void>;
//# sourceMappingURL=tlv-playback-transition.d.ts.map