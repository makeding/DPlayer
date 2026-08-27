import type DPlayer from './player';
import type * as DPlayerType from './types';
export interface TLVQualityLabels {
    preferred: string;
    fallback: string;
}
export declare function installDynamicTLVQualities(options: DPlayerType.OptionsInternal, labels: TLVQualityLabels): void;
export default class TLVQuality {
    private readonly player;
    private pendingRole;
    private latestSnapshot;
    private restoringMissingLayer;
    private snapshotSequence;
    constructor(player: DPlayer);
    reset(): void;
    sync(snapshot: DPlayerType.TLVMptSnapshot): void;
    tracksChanged(): void;
    invalidateSnapshot(): void;
    select(index: number): boolean;
    syncSelection(change: DPlayerType.TLVLayerChange): void;
    private reconcileSnapshot;
    private restoreMissingLayer;
    private clearManualQualities;
    private updateSelection;
    private matchesLayer;
    private selectedRole;
    private showError;
    private activeSourceIndex;
    private qualityForRole;
    private dynamicQualities;
    private forEachDynamicQuality;
}
//# sourceMappingURL=tlv-quality.d.ts.map