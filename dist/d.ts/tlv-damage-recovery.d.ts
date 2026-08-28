import type createTlvDemuxModule from 'tlvdemux';
import type { MseAppendQueue } from 'tlvdemux/mse-append-queue';
type Media = HTMLMediaElement & {
    play(): Promise<void>;
};
/** DPlayer's product gate around tlvdemux's selected-layer recovery action. */
export declare function createTLVDamageRecovery(options: {
    media: Media;
    queues: () => Map<string, MseAppendQueue>;
    isActive: () => boolean;
    isCurrentLayer: (damage: createTlvDemuxModule.PlaybackDamage) => boolean;
    switchInFlight: () => boolean;
    seek: (targetSeconds: number, previousTimeSeconds: number) => void;
}): {
    setPresentationStartUs(value: bigint): void;
    reportDamage(damage: createTlvDemuxModule.PlaybackDamage): boolean;
    notifyWaiting(): boolean;
    update: () => boolean;
    reset(): void;
};
export {};
//# sourceMappingURL=tlv-damage-recovery.d.ts.map