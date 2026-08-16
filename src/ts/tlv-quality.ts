import type DPlayer from './player';
import type * as DPlayerType from './types';

const DYNAMIC_FALLBACK_ROLE = 'fallback';

export function installDynamicTLVQualities(
    options: DPlayerType.OptionsInternal,
    fallbackLabel: string,
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
            tlvDynamicLayer: {role: 'preferred', sourceIndex},
        });
        qualities.push({
            ...quality,
            name: `${quality.name}（${fallbackLabel}）`,
            tlvDynamicLayer: {role: DYNAMIC_FALLBACK_ROLE, sourceIndex},
        });
    }
    options.video.quality = qualities;
    options.video.defaultQuality = defaultQuality;
}

export default class TLVQuality {
    private readonly player: DPlayer;
    private pendingRole: 'preferred' | 'fallback' | null = null;

    constructor(player: DPlayer) {
        this.player = player;
        this.reset();
    }

    reset(): void {
        this.pendingRole = null;
        this.forEachDynamicQuality((quality, index) => {
            quality.tlvDynamicLayer!.videoPacketId = undefined;
            quality.tlvDynamicLayer!.audioPacketId = undefined;
            this.player.setting.setQualityItemVisible(
                index,
                quality.tlvDynamicLayer!.role !== DYNAMIC_FALLBACK_ROLE,
            );
        });
    }

    sync(snapshot: DPlayerType.TLVMptSnapshot): void {
        const pair = this.player.plugins.tlv?.layerPair(snapshot.tracks) ?? null;
        const sourceIndex = this.activeSourceIndex();
        if (sourceIndex === null) return;
        const preferred = this.qualityForRole(sourceIndex, 'preferred');
        const fallback = this.qualityForRole(sourceIndex, DYNAMIC_FALLBACK_ROLE);
        if (!preferred || !fallback || !pair) {
            if (fallback) {
                fallback.quality.tlvDynamicLayer!.videoPacketId = undefined;
                fallback.quality.tlvDynamicLayer!.audioPacketId = undefined;
                this.player.setting.setQualityItemVisible(fallback.index, false);
            }
            return;
        }
        preferred.quality.tlvDynamicLayer!.videoPacketId = pair.preferred.video.packetId;
        preferred.quality.tlvDynamicLayer!.audioPacketId = pair.preferred.audio.packetId;
        fallback.quality.tlvDynamicLayer!.videoPacketId = pair.fallback?.video.packetId;
        fallback.quality.tlvDynamicLayer!.audioPacketId = pair.fallback?.audio.packetId;
        this.player.setting.setQualityItemVisible(fallback.index, pair.fallback !== null);
    }

    select(index: number): boolean {
        const quality = this.player.options.video.quality?.[index];
        const layer = quality?.tlvDynamicLayer;
        if (!quality || !layer) return false;
        if (this.activeSourceIndex() !== layer.sourceIndex) return false;
        if (this.pendingRole !== null) return true;
        if (this.player.qualityIndex === index) return true;
        if (layer.videoPacketId === undefined || layer.audioPacketId === undefined) return false;

        this.pendingRole = layer.role;
        void this.player.selectTLVLayer(layer.videoPacketId, layer.audioPacketId).catch(error => {
            this.pendingRole = null;
            const message = error instanceof Error ? error.message : String(error);
            this.player.notice(
                `${this.player.tran('TLV layer switch failed')}: ${message} ${this.player.tran('Select the quality again to retry.')}`,
                -1,
                undefined,
                '#FF6F6A',
            );
        });
        return true;
    }

    syncSelection(change: DPlayerType.TLVLayerChange): void {
        const sourceIndex = this.activeSourceIndex();
        if (sourceIndex === null) return;
        const target = this.dynamicQualities().find(({quality}) => {
            const layer = quality.tlvDynamicLayer!;
            return layer.sourceIndex === sourceIndex &&
                layer.videoPacketId === change.videoTrack.packetId &&
                layer.audioPacketId === change.audioTrack.packetId;
        });
        if (!target || this.player.qualityIndex === target.index) {
            this.pendingRole = null;
            return;
        }

        const manual = this.pendingRole === target.quality.tlvDynamicLayer!.role;
        this.pendingRole = null;
        this.player.qualityIndex = target.index;
        this.player.quality = target.quality;
        this.player.template.qualityValue.textContent = target.quality.name;
        this.player.template.qualityItem.forEach((item) => {
            item.classList.toggle('dplayer-setting-quality-current', Number(item.dataset.index) === target.index);
        });
        this.player.template.settingBox.classList.remove('dplayer-setting-box-quality');
        if (manual) {
            this.player.notice(`${this.player.tran('Switched to')} ${target.quality.name}`);
        } else if (target.quality.tlvDynamicLayer!.role === DYNAMIC_FALLBACK_ROLE) {
            this.player.notice(this.player.tran('Switched to rain broadcast because the broadcast stream was damaged.'), undefined, undefined, '#FFA86A');
        } else {
            this.player.notice(this.player.tran('Returned to the primary broadcast.'));
        }
    }

    private activeSourceIndex(): number | null {
        const layer = this.player.quality?.tlvDynamicLayer;
        return this.player.type === 'tlv' && layer ? layer.sourceIndex : null;
    }

    private qualityForRole(sourceIndex: number, role: 'preferred' | 'fallback'):
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
