export function visibleQualityCount(items: ArrayLike<{hidden: boolean}>): number {
    return Array.from(items).filter(item => !item.hidden).length;
}
