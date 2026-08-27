const damageLeadToleranceSeconds = 2;
const recoveryEndMarginSeconds = 0.05;
const minimumRecoveryBufferSeconds = 0.5;
const maximumDamageIntervals = 64;

export function commonBufferedRanges(queues) {
    const video = queues.get('video')?.bufferedRanges() ?? [];
    const audio = queues.get('audio')?.bufferedRanges() ?? [];
    const result = [];
    for (const videoRange of video) {
        for (const audioRange of audio) {
            const start = Math.max(videoRange.start, audioRange.start);
            const end = Math.min(videoRange.end, audioRange.end);
            if (end > start) result.push({start, end});
        }
    }
    return result;
}

export function createTlvPlaybackDamageRecovery({media, queues, seek, onRecovered}) {
    let waiting = false;
    const intervals = [];
    const keys = new Set();

    const update = () => {
        if (!waiting || media.paused || media.seeking) return null;
        const damage = intervals.find(interval =>
            interval.start <= media.currentTime + damageLeadToleranceSeconds &&
            media.currentTime < interval.recovery - recoveryEndMarginSeconds);
        if (!damage) return null;
        const range = commonBufferedRanges(queues()).find(candidate =>
            candidate.start <= damage.recovery + recoveryEndMarginSeconds &&
            candidate.end - damage.recovery >= minimumRecoveryBufferSeconds);
        if (!range) return null;

        const target = Math.max(range.start, damage.recovery);
        const previous = media.currentTime;
        waiting = false;
        intervals.splice(intervals.indexOf(damage), 1);
        keys.delete(damage.key);
        seek(target, previous);
        Promise.resolve(media.play()).catch(() => undefined);
        onRecovered?.(target, previous);
        return {start: target, end: range.end};
    };

    return {
        reportDamage(damage) {
            if (damage.action !== 'seek' || damage.recoveryTimeUs === null) return false;
            const start = Number(damage.startTimeUs ?? damage.endTimeUs) / 1000000;
            const recovery = Number(damage.recoveryTimeUs) / 1000000;
            if (!Number.isFinite(start) || !Number.isFinite(recovery) || recovery <= start) return false;
            const key = `${damage.videoTrackId}:${damage.startInputOffset}:${damage.endInputOffset}`;
            if (keys.has(key)) return false;
            keys.add(key);
            intervals.push({key, start, recovery});
            intervals.sort((left, right) => left.start - right.start);
            while (intervals.length > maximumDamageIntervals) {
                keys.delete(intervals.shift().key);
            }
            update();
            return true;
        },
        notifyWaiting() {
            waiting = true;
            return update();
        },
        update,
        clear() {
            waiting = false;
            intervals.length = 0;
            keys.clear();
        },
    };
}
