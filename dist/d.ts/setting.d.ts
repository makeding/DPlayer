import DPlayer from './player';
import * as DPlayerType from './types';
declare class Setting {
    player: DPlayer;
    loop: boolean;
    showDanmaku: boolean;
    unlimitDanmaku: boolean;
    currentAudio: 'primary' | 'secondary';
    toneMappingMode: DPlayerType.ToneMappingMode;
    toneMappingModeBeforeComparison: DPlayerType.ToneMappingMode;
    resizeObserver: ResizeObserver;
    constructor(player: DPlayer);
    private updateToneMappingMode;
    setQualityItemVisible(index: number, visible: boolean): void;
    private syncQualityPanelHeight;
    hide(): void;
    show(): void;
    destroy(): void;
}
export default Setting;
//# sourceMappingURL=setting.d.ts.map