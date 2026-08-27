import DPlayer from './player';
import * as DPlayerType from './types';
declare class Setting {
    player: DPlayer;
    loop: boolean;
    showDanmaku: boolean;
    unlimitDanmaku: boolean;
    currentAudio: DPlayerType.AudioChannel;
    toneMappingMode: DPlayerType.ToneMappingMode;
    toneMappingModeBeforeComparison: DPlayerType.ToneMappingMode;
    resizeObserver: ResizeObserver;
    constructor(player: DPlayer);
    private updateToneMappingMode;
    setQualityItemVisible(index: number, visible: boolean): void;
    private syncQualityPanelHeight;
    /**
     * Reflect the selected broadcast audio channel in the settings UI
     * @param audio Selected audio channel
     */
    setCurrentAudio(audio: DPlayerType.AudioChannel): void;
    hide(): void;
    show(): void;
    destroy(): void;
}
export default Setting;
//# sourceMappingURL=setting.d.ts.map