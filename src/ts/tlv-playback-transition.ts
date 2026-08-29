import {MsePlaybackMode} from 'tlvdemux/mse-playback';
import type {MsePlaybackModeValue} from 'tlvdemux/mse-playback';

export type TLVRequiredTrack = 'video' | 'audio';

/** Apply one required-track invariant to both MSE buffering layers. */
export function applyTLVRequiredTracks(options: {
    pipeline: {setRequiredTracks(required: readonly TLVRequiredTrack[]): void} | null;
    flow: {setRequiredTracks(required: readonly TLVRequiredTrack[], currentTime: number): void} | null;
    required: readonly TLVRequiredTrack[];
    currentTime: number;
    restartPlayback(): void;
}): void {
    options.pipeline?.setRequiredTracks(options.required);
    options.flow?.setRequiredTracks(options.required, options.currentTime);
    options.restartPlayback();
}

/**
 * Enter audio-only without ever mutating the authoritative MediaSource after a
 * detached candidate fails. A later RAP is responsible for the next attempt.
 */
export async function requestTLVAudioOnlyTransition(options: {
    setRequiredTracks(required: readonly TLVRequiredTrack[]): void;
    activateInPlace(): Promise<{changed: boolean}>;
    currentMode(): MsePlaybackModeValue | null;
    transition: ((mode: typeof MsePlaybackMode.AUDIO_ONLY, target: number) => Promise<unknown>) | null;
    currentTime(): number;
}): Promise<void> {
    options.setRequiredTracks(['audio']);
    const result = await options.activateInPlace();
    if (options.currentMode() !== MsePlaybackMode.AUDIO_ONLY || result.changed) return;
    if (!options.transition) return;
    try {
        await options.transition(MsePlaybackMode.AUDIO_ONLY, options.currentTime());
    } catch {
        // Candidate isolation is the contract: keep the current audio pipeline
        // untouched and allow the controller to retry at a later selected RAP.
    }
}
