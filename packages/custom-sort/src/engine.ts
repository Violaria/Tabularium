// The sorting engine without the plug-in, for sorting outside Obsidian (Tabularium web notes): the same rule parser
// and the same comparisons, so the order matches the plug-in.
export { SortingSpecProcessor } from './custom-sort/sorting-spec-processor';
export type { SortSpecsCollection } from './custom-sort/sorting-spec-processor';
export { sortFolderItems } from './custom-sort/custom-sort';
export type { ProcessingContext } from './custom-sort/custom-sort';
export type { CustomSortSpec } from './custom-sort/custom-sort-types';
