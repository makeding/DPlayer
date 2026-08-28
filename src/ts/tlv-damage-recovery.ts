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
    let presentationStartUs = 0n;
    let waitingForRecovery = false;
    const createSdk = () => createMsePlaybackDamageRecovery({
        media: options.media,
        presentationStartUs,
        isActive: options.isActive,
        isCurrentLayer: damage => options.isCurrentLayer(
            damage as unknown as createTlvDemuxModule.PlaybackDamage,
        ),
        switchInFlight: options.switchInFlight,
        seek: options.seek,
    });
    let sdk = createSdk();

    const recoverWhenReady = (): boolean => {
        if (!waitingForRecovery || !pending || options.media.paused || options.media.seeking) return false;
        const recovery = Number(BigInt(pending.recoveryTimeUs!) - presentationStartUs) / 1000000;
        if (!Number.isFinite(recovery) || recovery < 0) return false;
        const buffered = commonBufferedRanges(options.queues()).some(range =>
            range.start <= recovery + 0.05 && range.end - recovery >= 0.5);
        if (!buffered) return false;
        const reported = sdk.reportDamage(
            pending as unknown as Parameters<typeof sdk.reportDamage>[0],
        );
        const recovered = reported ?? sdk.notifyWaiting();
        if (!recovered) return false;
        pending = null;
        waitingForRecovery = false;
        return true;
    };

    return {
        setPresentationStartUs(value: bigint): void {
            if (presentationStartUs === value) return;
            presentationStartUs = value;
            pending = null;
            waitingForRecovery = false;
            sdk.reset();
            sdk = createSdk();
        },
        reportDamage(damage: createTlvDemuxModule.PlaybackDamage): boolean {
            if (damage.action !== 'seek' || damage.recoveryTimeUs === null ||
                !options.isActive() || !options.isCurrentLayer(damage)) return false;
            pending = damage;
            return true;
        },
        notifyWaiting(): boolean {
            waitingForRecovery = true;
            return recoverWhenReady();
        },
        update: recoverWhenReady,
        reset(): void {
            pending = null;
            waitingForRecovery = false;
            sdk.reset();
        },
    };
}
