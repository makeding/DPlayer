import type createTlvDemuxModule from 'tlvdemux';

type BufferedRange = {start: number; end: number};
type Queue = {bufferedRanges(): BufferedRange[]};
type Media = Pick<HTMLMediaElement, 'currentTime' | 'paused' | 'seeking' | 'play'>;

export function commonBufferedRanges(queues: Map<string, Queue>): BufferedRange[];

export function createTlvPlaybackDamageRecovery(options: {
    media: Media;
    queues: () => Map<string, Queue>;
    seek: (target: number, previous: number) => void;
    onRecovered?: (target: number, previous: number) => void;
}): {
    reportDamage(damage: createTlvDemuxModule.PlaybackDamage): boolean;
    notifyWaiting(): BufferedRange | null;
    update(): BufferedRange | null;
    clear(): void;
};
