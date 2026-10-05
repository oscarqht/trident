import { cn } from '@/lib/utils';
import { ContextMenu, ContextMenuItem } from '@/components/context-menu';
import { BranchTreeNode, VisibilityMap, getEffectiveVisibility, collectAllBranchRefs } from './branch-tree-utils';
import { BranchOperation, BranchMenuOptions } from './branch-context-menu';
import { BranchTrackingInfo } from '@/lib/types';
import { VisibilityToggle } from './visibility-toggle';

export type BranchRowSelectModifiers = { isMultiSelect: boolean; isRangeSelect: boolean };

// Recursive component to render branch tree
export function BranchTreeItem({
  node,
  currentBranch,
  mainWorktreeBranch,
  expandedFolders,
  onToggleFolder,
  onCheckout,
  onCheckoutToLocal,
  onCreateBranch,
  onDeleteBranch,
  onRenameBranch,
  onRenameRemoteBranch,
  onRebase,
  onMerge,
  onPushToRemote,
  onPullFromRemote,
  getBranchContextMenuItems,
  onBranchClick,
  onBranchContextMenu,
  onDeleteBranchGroup,
  selectedBranches,
  visibilityMap,
  onToggleVisibility,
  parentPath = '',
  depth = 0,
  groupPath,
  isRemote = false,
  trackingInfo,
}: {
  node: BranchTreeNode;
  currentBranch?: string;
  mainWorktreeBranch?: string | null;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onCheckout: (branch: string) => void;
  onCheckoutToLocal: (remoteBranch: string) => void;
  onCreateBranch: () => void;
  onDeleteBranch: (branch: string) => void;
  onRenameBranch: (branch: string) => void;
  onRenameRemoteBranch: (branch: string) => void;
  onRebase: (operation: BranchOperation) => void;
  onMerge: (operation: BranchOperation) => void;
  onPushToRemote: (branch: string) => void;
  onPullFromRemote: (branch: string) => void;
  getBranchContextMenuItems: (options: BranchMenuOptions) => ContextMenuItem[];
  onBranchClick?: (branch: string, modifiers?: BranchRowSelectModifiers) => void;
  onBranchContextMenu?: (branch: string) => void;
  onDeleteBranchGroup: (branches: string[]) => void;
  selectedBranches: Set<string>;
  visibilityMap: VisibilityMap;
  onToggleVisibility: (path: string, type: 'visible' | 'hidden') => void;
  parentPath?: string;
  depth?: number;
  groupPath?: string;
  isRemote?: boolean;
  trackingInfo?: Record<string, BranchTrackingInfo>;
}) {
  const children = Array.from(node.children.values());
  const sortedChildren = children.sort((a, b) => {
    // Folders (non-leaf) come first, then alphabetical
    const aIsFolder = a.children.size > 0 && !a.fullPath;
    const bIsFolder = b.children.size > 0 && !b.fullPath;
    if (aIsFolder && !bIsFolder) return -1;
    if (!aIsFolder && bIsFolder) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sortedChildren.map((child) => {
        const isLeaf = child.fullPath !== undefined;
        const isFolder = child.children.size > 0 && !isLeaf;
        const itemPath = child.fullPath || (parentPath ? `${parentPath}/${child.name}` : child.name);
        const isExpanded = expandedFolders.has(itemPath);
        const isCurrent = isLeaf && child.fullPath === currentBranch;

        // Get visibility state for this item
        const directVisibility = visibilityMap[itemPath];
        const effectiveVisibility = getEffectiveVisibility(itemPath, visibilityMap, groupPath);
        const isInherited = !directVisibility && effectiveVisibility !== null;

        if (isFolder) {
          const childBranchRefs = collectAllBranchRefs(child);
          const deletableChildBranchRefs = childBranchRefs.filter(
            (branchRef) => branchRef !== currentBranch && (!mainWorktreeBranch || branchRef !== mainWorktreeBranch)
          );

          // Render folder
          return (
            <div key={itemPath}>
              <ContextMenu
                items={[
                  {
                    label: 'Delete',
                    icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
                    onClick: () => onDeleteBranchGroup(deletableChildBranchRefs),
                    danger: true,
                    disabled: deletableChildBranchRefs.length === 0,
                  },
                ]}
              >
                <div
                  className={cn(
                    "group flex items-center gap-1 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-base-200 transition-colors opacity-70 select-none",
                  )}
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                >
                  <div className="flex items-center gap-1 flex-1 min-w-0" onClick={() => onToggleFolder(itemPath)}>
                    <span className="text-xs opacity-70">{isExpanded ? '▼' : '▶'}</span>
                    <i className="iconoir-folder text-[16px] shrink-0" aria-hidden="true" />
                    <span className="truncate min-w-0 flex-1">{child.name}</span>
                  </div>
                  <div className="flex items-center gap-0.5 ml-auto">
                    <VisibilityToggle
                      type="visible"
                      isActive={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
                      isInherited={isInherited && effectiveVisibility === 'visible'}
                      onClick={(e) => { e.stopPropagation(); onToggleVisibility(itemPath, 'visible'); }}
                      showOnHover={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
                    />
                    <VisibilityToggle
                      type="hidden"
                      isActive={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
                      isInherited={isInherited && effectiveVisibility === 'hidden'}
                      onClick={(e) => { e.stopPropagation(); onToggleVisibility(itemPath, 'hidden'); }}
                      showOnHover={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
                    />
                  </div>
                </div>
              </ContextMenu>
              {isExpanded && (
                <BranchTreeItem
                  node={child}
                  currentBranch={currentBranch}
                  mainWorktreeBranch={mainWorktreeBranch}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  onCheckout={onCheckout}
                  onCheckoutToLocal={onCheckoutToLocal}
                  onCreateBranch={onCreateBranch}
                  onDeleteBranch={onDeleteBranch}
                  onRenameBranch={onRenameBranch}
                  onRenameRemoteBranch={onRenameRemoteBranch}
                  onRebase={onRebase}
                  onMerge={onMerge}
                  onPushToRemote={onPushToRemote}
                  onPullFromRemote={onPullFromRemote}
                  getBranchContextMenuItems={getBranchContextMenuItems}
                  onBranchClick={onBranchClick}
                  onBranchContextMenu={onBranchContextMenu}
                  onDeleteBranchGroup={onDeleteBranchGroup}
                  selectedBranches={selectedBranches}
                  visibilityMap={visibilityMap}
                  onToggleVisibility={onToggleVisibility}
                  parentPath={itemPath}
                  depth={depth + 1}
                  groupPath={groupPath}
                  isRemote={isRemote}
                  trackingInfo={trackingInfo}
                />
              )}
            </div>
          );
        }

        // Render leaf (actual branch)
        const branchTracking = !isRemote && child.fullPath ? trackingInfo?.[child.fullPath] : undefined;
        const hasDivergence = branchTracking && (branchTracking.ahead > 0 || branchTracking.behind > 0);

        const menuItems = getBranchContextMenuItems({
          branchRef: child.fullPath!,
          branchLeafName: child.name,
          currentBranch,
          mainWorktreeBranch,
          isRemote,
          selectedBranchRefs: selectedBranches.has(child.fullPath!) ? Array.from(selectedBranches) : [child.fullPath!],
        });
        const isSelected = selectedBranches.has(child.fullPath!);


        return (
          <ContextMenu key={child.fullPath} items={menuItems}>
              <div
                className={cn(
                  "group flex items-center gap-2 px-2 py-1.5 text-sm rounded-md cursor-pointer transition-colors select-none",
                  !isSelected && "hover:bg-base-200",
                  isSelected && "bg-primary/10 hover:bg-primary/20",
                  isCurrent && "bg-base-200 font-medium text-primary"
                )}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                onContextMenu={() => onBranchContextMenu?.(child.fullPath!)}
              >
                <div 
                  className="flex items-center gap-2 flex-1 min-w-0" 
                  onClick={(e) => onBranchClick?.(child.fullPath!, { isMultiSelect: e.metaKey || e.ctrlKey, isRangeSelect: e.shiftKey })}
                  onDoubleClick={() => {
                    if (isCurrent) return;
                    if (isRemote || child.fullPath?.startsWith('remotes/')) {
                      onCheckoutToLocal(child.fullPath!);
                    } else {
                      onCheckout(child.fullPath!);
                    }
                  }}
                >
                  {isCurrent ? (
                    <span className="w-3 h-3 flex items-center justify-center shrink-0">
                      <span className="w-2 h-2 rounded-full bg-primary" />
                    </span>
                  ) : isRemote ? (
                    <i className="iconoir-globe text-[14px] opacity-50 shrink-0" aria-hidden="true" />
                  ) : (
                    <i className="iconoir-git-branch text-[14px] opacity-50 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate min-w-0 flex-1" title={child.fullPath}>{child.name}</span>
                  {hasDivergence && (
                    <span 
                      className="flex items-center gap-1 text-xs opacity-70 shrink-0"
                      title={`${branchTracking.ahead} ahead, ${branchTracking.behind} behind ${branchTracking.upstream}`}
                    >
                      {branchTracking.ahead > 0 && (
                        <span className="flex items-center gap-0.5 text-xs">
                          <i className="iconoir-arrow-up text-[12px]" aria-hidden="true" />
                          <span>{branchTracking.ahead}</span>
                        </span>
                      )}
                      {branchTracking.behind > 0 && (
                        <span className="flex items-center gap-0.5 text-xs">
                          <i className="iconoir-arrow-down text-[12px]" aria-hidden="true" />
                          <span>{branchTracking.behind}</span>
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 ml-auto">
                  <VisibilityToggle
                    type="visible"
                    isActive={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
                    isInherited={isInherited && effectiveVisibility === 'visible'}
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(itemPath, 'visible'); }}
                    showOnHover={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
                  />
                  <VisibilityToggle
                    type="hidden"
                    isActive={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
                    isInherited={isInherited && effectiveVisibility === 'hidden'}
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(itemPath, 'hidden'); }}
                    showOnHover={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
                  />
                </div>
              </div>
          </ContextMenu>
        );
      })}
    </>
  );
}
