import type createTlvDemuxModule from 'tlvdemux';
import type {MseAppendQueue} from 'tlvdemux/mse-append-queue';
import {commonBufferedRanges, createMsePlaybackDamageRecovery} from 'tlvdemux/mse-playback';

type Media = HTMLMediaElement & {play(): Promise<void>};

/** DPlayer's product gate around tlvdemux's selected-layer recovery action. */
export function createTLVDamageRecovery(options: {
    media: Media;
    queues: () => Map<string, MseAppendQueue>;
    isActive: () => boolean;
    isCurrentLayer: (damage: createTlvDemuxModule.PlaybackDamage) => boolean;
    switchInFlight: () => boolean;
    seek: (targetSeconds: number, previousTimeSeconds: number) => void;
}) {
    let pending: createTlvDemuxModule.PlaybackDamage | null = null;
    const sdk = createMsePlaybackDamageRecovery({
        media: options.media,
        isActive: options.isActive,
        isCurrentLayer: damage => options.isCurrentLayer(
            damage as unknown as createTlvDemuxModule.PlaybackDamage,
        ),
        switchInFlight: options.switchInFlight,
        seek: options.seek,
    });

    const recoverWhenReady = (): boolean => {
        if (!pending || options.media.paused || options.media.seeking) return false;
        const recovery = Number(pending.recoveryTimeUs) / 1000000;
        const buffered = commonBufferedRanges(options.queues()).some(range =>
            range.start <= recovery + 0.05 && range.end - recovery >= 0.5);
        if (!buffered) return false;
        const recovered = sdk.reportDamage(
            pending as unknown as Parameters<typeof sdk.reportDamage>[0],
        );
        if (!recovered) return false;
        pending = null;
        return true;
    };

    return {
        reportDamage(damage: createTlvDemuxModule.PlaybackDamage): boolean {
            if (damage.action !== 'seek' || damage.recoveryTimeUs === null ||
                !options.isActive() || !options.isCurrentLayer(damage)) return false;
            pending = damage;
            return true;
        },
        notifyWaiting: recoverWhenReady,
        update: recoverWhenReady,
        reset(): void {
            pending = null;
            sdk.reset();
        },
    };
}
