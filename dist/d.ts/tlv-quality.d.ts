import type DPlayer from './player';
import type * as DPlayerType from './types';
export declare function installDynamicTLVQualities(options: DPlayerType.OptionsInternal, fallbackLabel: string): void;
export default class TLVQuality {
    private readonly player;
    private pendingRole;
    constructor(player: DPlayer);
    reset(): void;
    sync(snapshot: DPlayerType.TLVMptSnapshot): void;
    select(index: number): boolean;
    syncSelection(change: DPlayerType.TLVLayerChange): void;
    private activeSourceIndex;
    private qualityForRole;
    private dynamicQualities;
    private forEachDynamicQuality;
}
//# sourceMappingURL=tlv-quality.d.ts.map