import type DPlayer from './player';
import type * as DPlayerType from './types';

type DynamicRole = 'original' | 'preferred' | 'fallback';

export interface TLVQualityLabels {
    preferred: string;
    fallback: string;
}

export function installDynamicTLVQualities(
    options: DPlayerType.OptionsInternal,
    labels: TLVQualityLabels,
): void {
    const originalQualities = options.video.quality ?? (
        options.video.type === 'tlv' && options.video.url ? [{
            name: 'TLV',
            url: options.video.url,
            type: 'tlv',
            tlv: options.video.tlv,
        }] : []
    );
    if (originalQualities.length === 0) return;

    const originalDefaultQuality = options.video.defaultQuality ?? 0;
    const qualities: DPlayerType.VideoQualityInternal[] = [];
    let defaultQuality = 0;
    for (let index = 0; index < originalQualities.length; index += 1) {
        const quality = originalQualities[index];
        if (index === originalDefaultQuality) defaultQuality = qualities.length;
        const sourceIndex = qualities.length;
        if (quality.tlvDynamicLayer || quality.type !== 'tlv' || quality.tlv?.videoPacketId !== undefined) {
            qualities.push(quality);
            continue;
        }
        qualities.push({
            ...quality,
            name: quality.name,
            tlvDynamicLayer: {role: 'original', sourceIndex},
        });
        qualities.push({
            ...quality,
            name: `${quality.name}（${labels.preferred}）`,
            tlvDynamicLayer: {role: 'preferred', sourceIndex},
        });
        qualities.push({
            ...quality,
            name: `${quality.name}（${labels.fallback}）`,
            tlvDynamicLayer: {role: 'fallback', sourceIndex},
        });
    }
    options.video.quality = qualities;
    options.video.defaultQuality = defaultQuality;
}

export default class TLVQuality {
    private readonly player: DPlayer;
    private pendingRole: DynamicRole | null = null;
    private latestSnapshot: DPlayerType.TLVMptSnapshot | null = null;
    private restoringMissingLayer = false;
    private snapshotSequence = 0;

    constructor(player: DPlayer) {
        this.player = player;
        this.reset();
    }

    reset(): void {
        this.pendingRole = null;
        this.latestSnapshot = null;
        this.restoringMissingLayer = false;
        this.snapshotSequence += 1;
        this.forEachDynamicQuality((quality, index) => {
            quality.tlvDynamicLayer!.videoPacketId = undefined;
            quality.tlvDynamicLayer!.audioPacketId = undefined;
            this.player.setting.setQualityItemVisible(index, quality.tlvDynamicLayer!.role === 'original');
        });
    }

    sync(snapshot: DPlayerType.TLVMptSnapshot): void {
        this.latestSnapshot = snapshot;
        this.snapshotSequence += 1;
        this.reconcileSnapshot();
    }

    tracksChanged(): void {
        if (this.latestSnapshot) this.reconcileSnapshot();
    }

    invalidateSnapshot(): void {
        this.latestSnapshot = null;
        this.snapshotSequence += 1;
        this.forEachDynamicQuality((quality, index) => {
            if (quality.tlvDynamicLayer!.role !== 'original') {
                this.player.setting.setQualityItemVisible(index, false);
            }
        });
    }

    select(index: number): boolean {
        const quality = this.player.options.video.quality?.[index];
        const layer = quality?.tlvDynamicLayer;
        if (!quality || !layer) return false;
        if (this.activeSourceIndex() !== layer.sourceIndex) return false;
        this.player.template.settingBox.classList.remove('dplayer-setting-box-quality');
        if (this.pendingRole !== null || this.restoringMissingLayer) return true;
        if (this.player.qualityIndex === index) return true;

        if (layer.role === 'original') {
            this.pendingRole = 'original';
            void this.player.selectTLVAutomaticLayer().then(() => {
                this.pendingRole = null;
                this.updateSelection(index, false);
            }).catch(error => {
                this.pendingRole = null;
                this.showError(error);
            });
            return true;
        }
        if (layer.videoPacketId === undefined || layer.audioPacketId === undefined) return false;

        this.pendingRole = layer.role;
        void this.player.selectTLVLayer(layer.videoPacketId, layer.audioPacketId).then(() => {
            if (this.pendingRole === layer.role) {
                this.pendingRole = null;
                this.updateSelection(index, true);
            }
        }).catch(error => {
            this.pendingRole = null;
            this.showError(error);
        });
        return true;
    }

    syncSelection(change: DPlayerType.TLVLayerChange): void {
        const sourceIndex = this.activeSourceIndex();
        if (sourceIndex === null) return;
        const target = this.dynamicQualities().find(({quality}) => {
            const layer = quality.tlvDynamicLayer!;
            return layer.sourceIndex === sourceIndex && layer.role !== 'original' &&
                layer.videoPacketId === change.videoTrack.packetId &&
                layer.audioPacketId === change.audioTrack.packetId;
        });
        const manual = target && this.pendingRole === target.quality.tlvDynamicLayer!.role;
        if (manual) {
            this.pendingRole = null;
            this.updateSelection(target.index, true);
            return;
        }

        if (this.selectedRole() !== 'original') return;
        if (target?.quality.tlvDynamicLayer!.role === 'fallback') {
            this.player.notice(
                this.player.tran('Switched to rain broadcast because the broadcast stream was damaged.'),
                undefined, undefined, '#FFA86A',
            );
        } else if (target?.quality.tlvDynamicLayer!.role === 'preferred') {
            this.player.notice(this.player.tran('Returned to the primary broadcast.'));
        }
    }

    private reconcileSnapshot(): void {
        const sourceIndex = this.activeSourceIndex();
        const snapshot = this.latestSnapshot;
        if (sourceIndex === null || !snapshot) return;
        const pair = this.player.plugins.tlv?.layerPair(snapshot.tracks) ?? null;
        const preferred = this.qualityForRole(sourceIndex, 'preferred');
        const fallback = this.qualityForRole(sourceIndex, 'fallback');
        if (!preferred || !fallback) return;

        const complete = pair?.fallback !== null && pair?.fallback !== undefined;
        const selectedRole = this.selectedRole();
        const selectedStillExists = selectedRole === 'preferred' ?
            complete && this.matchesLayer(preferred.quality, pair!.preferred) :
            selectedRole === 'fallback' ? complete && this.matchesLayer(fallback.quality, pair!.fallback!) : true;
        if (!selectedStillExists) {
            this.restoreMissingLayer(sourceIndex);
            return;
        }
        if (!complete) {
            this.clearManualQualities(preferred, fallback);
            return;
        }

        preferred.quality.tlvDynamicLayer!.videoPacketId = pair.preferred.video.packetId;
        preferred.quality.tlvDynamicLayer!.audioPacketId = pair.preferred.audio.packetId;
        fallback.quality.tlvDynamicLayer!.videoPacketId = pair.fallback!.video.packetId;
        fallback.quality.tlvDynamicLayer!.audioPacketId = pair.fallback!.audio.packetId;
        this.player.setting.setQualityItemVisible(preferred.index, true);
        this.player.setting.setQualityItemVisible(fallback.index, true);
    }

    private restoreMissingLayer(sourceIndex: number): void {
        if (this.restoringMissingLayer) return;
        this.restoringMissingLayer = true;
        const restoreSequence = this.snapshotSequence;
        void this.player.selectTLVAutomaticLayer().then(() => {
            this.restoringMissingLayer = false;
            const original = this.qualityForRole(sourceIndex, 'original');
            const preferred = this.qualityForRole(sourceIndex, 'preferred');
            const fallback = this.qualityForRole(sourceIndex, 'fallback');
            if (original) this.updateSelection(original.index, false);
            if (restoreSequence !== this.snapshotSequence) {
                this.reconcileSnapshot();
            } else if (preferred && fallback) {
                this.clearManualQualities(preferred, fallback);
            }
        }).catch(error => {
            this.restoringMissingLayer = false;
            this.showError(error);
        });
    }

    private clearManualQualities(
        preferred: {quality: DPlayerType.VideoQualityInternal; index: number},
        fallback: {quality: DPlayerType.VideoQualityInternal; index: number},
    ): void {
        for (const entry of [preferred, fallback]) {
            entry.quality.tlvDynamicLayer!.videoPacketId = undefined;
            entry.quality.tlvDynamicLayer!.audioPacketId = undefined;
            this.player.setting.setQualityItemVisible(entry.index, false);
        }
    }

    private updateSelection(index: number, showNotice: boolean): void {
        const target = this.player.options.video.quality![index];
        this.player.qualityIndex = index;
        this.player.quality = target;
        this.player.template.qualityValue.textContent = target.name;
        this.player.template.qualityItem.forEach((item) => {
            item.classList.toggle('dplayer-setting-quality-current', Number(item.dataset.index) === index);
        });
        if (showNotice) this.player.notice(`${this.player.tran('Switched to')} ${target.name}`);
    }

    private matchesLayer(quality: DPlayerType.VideoQualityInternal, layer: DPlayerType.TLVLayer): boolean {
        return quality.tlvDynamicLayer!.videoPacketId === layer.video.packetId &&
            quality.tlvDynamicLayer!.audioPacketId === layer.audio.packetId;
    }

    private selectedRole(): DynamicRole | null {
        return this.player.quality?.tlvDynamicLayer?.role ?? null;
    }

    private showError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.player.notice(
            `${this.player.tran('TLV layer switch failed')}: ${message} ${this.player.tran('Select the quality again to retry.')}`,
            -1, undefined, '#FF6F6A',
        );
    }

    private activeSourceIndex(): number | null {
        const layer = this.player.quality?.tlvDynamicLayer;
        return this.player.type === 'tlv' && layer ? layer.sourceIndex : null;
    }

    private qualityForRole(sourceIndex: number, role: DynamicRole):
    {quality: DPlayerType.VideoQualityInternal; index: number} | null {
        return this.dynamicQualities().find(({quality}) =>
            quality.tlvDynamicLayer!.sourceIndex === sourceIndex && quality.tlvDynamicLayer!.role === role) ?? null;
    }

    private dynamicQualities(): Array<{quality: DPlayerType.VideoQualityInternal; index: number}> {
        return (this.player.options.video.quality ?? []).flatMap((quality, index) =>
            quality.tlvDynamicLayer ? [{quality, index}] : []);
    }

    private forEachDynamicQuality(
        callback: (quality: DPlayerType.VideoQualityInternal, index: number) => void,
    ): void {
        for (const {quality, index} of this.dynamicQualities()) callback(quality, index);
    }
}
