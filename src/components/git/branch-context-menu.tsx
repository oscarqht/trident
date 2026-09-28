import { ContextMenuItem } from '@/components/context-menu';

export type BranchOperation = { sourceBranch: string; targetBranch: string };

export interface BranchMenuCallbacks {
  onCheckout: (branch: string) => void;
  onCheckoutToLocal: (remoteBranch: string) => void;
  onCreateBranch: (sourceBranch: string) => void;
  onDeleteBranch: (branch: string) => void;
  onDeleteBranches: (branches: string[]) => void;
  onRenameBranch: (branch: string) => void;
  onRenameRemoteBranch: (branch: string) => void;
  onRebase: (operation: BranchOperation) => void;
  onMerge: (operation: BranchOperation) => void;
  onPushToRemote: (branch: string) => void;
  onPullFromRemote: (branch: string) => void;
}

export interface BranchMenuOptions {
  branchRef: string;
  branchLeafName: string;
  currentBranch?: string;
  mainWorktreeBranch?: string | null;
  isRemote: boolean;
  selectedBranchRefs?: string[];
}

export function buildBranchContextMenuItems(
  options: BranchMenuOptions,
  callbacks: BranchMenuCallbacks
): ContextMenuItem[] {
  const { branchRef, branchLeafName, currentBranch, mainWorktreeBranch, isRemote, selectedBranchRefs } = options;
  const isCurrent = !isRemote && branchRef === currentBranch;
  const isMainBranch = !isRemote && mainWorktreeBranch && branchRef === mainWorktreeBranch;
  const isProtectedBranch = (ref: string) => {
    return (!isRemote && ref === currentBranch) || (!isRemote && mainWorktreeBranch ? ref === mainWorktreeBranch : false);
  };
  const selectedRefs = selectedBranchRefs && selectedBranchRefs.length > 0 ? selectedBranchRefs : [branchRef];
  const deletableRefs = selectedRefs.filter((ref) => !isProtectedBranch(ref));
  const hasMultiSelection = selectedRefs.length > 1;
  const menuItems: ContextMenuItem[] = [];

  if (!isCurrent && !isRemote) {
    menuItems.push({
      label: 'Checkout',
      icon: <i className="iconoir-arrow-right text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onCheckout(branchRef),
    });
  }
  if (isRemote) {
    menuItems.push({
      label: 'Checkout to local',
      icon: <i className="iconoir-arrow-down text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onCheckoutToLocal(branchRef),
    });
  }
  menuItems.push({
    label: 'Create Branch',
    icon: <i className="iconoir-plus-circle text-[14px]" aria-hidden="true" />,
    onClick: () => callbacks.onCreateBranch(branchRef),
  });
  if (!isRemote) {
    menuItems.push({
      label: 'Rename Branch',
      icon: <i className="iconoir-edit-pencil text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onRenameBranch(branchRef),
    });
  }
  if (isRemote) {
    menuItems.push({
      label: 'Rename branch',
      icon: <i className="iconoir-edit-pencil text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onRenameRemoteBranch(branchRef),
    });
  }
  if (!isRemote) {
    menuItems.push({
      label: 'Push to Remote',
      icon: <i className="iconoir-arrow-up text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onPushToRemote(branchRef),
    });
  }
  if (!isRemote) {
    menuItems.push({
      label: 'Pull from Remote',
      icon: <i className="iconoir-arrow-down text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onPullFromRemote(branchRef),
    });
  }
  if (!isCurrent && currentBranch) {
    menuItems.push({
      label: `Rebase ${currentBranch} onto ${branchLeafName}`,
      labelNode: <>Rebase <span className="font-bold">{currentBranch}</span> onto {branchLeafName}</>,
      icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onRebase({ sourceBranch: currentBranch, targetBranch: branchRef }),
    });
    menuItems.push({
      label: `Rebase ${branchLeafName} onto ${currentBranch}`,
      labelNode: <>Rebase {branchLeafName} onto <span className="font-bold">{currentBranch}</span></>,
      icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onRebase({ sourceBranch: branchRef, targetBranch: currentBranch }),
    });
    menuItems.push({
      label: `Merge ${currentBranch} into ${branchLeafName}`,
      labelNode: <>Merge <span className="font-bold">{currentBranch}</span> into {branchLeafName}</>,
      icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onMerge({ sourceBranch: currentBranch, targetBranch: branchRef }),
    });
    menuItems.push({
      label: `Merge ${branchLeafName} into ${currentBranch}`,
      labelNode: <>Merge {branchLeafName} into <span className="font-bold">{currentBranch}</span></>,
      icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onMerge({ sourceBranch: branchRef, targetBranch: currentBranch }),
    });
  }
  if (hasMultiSelection) {
    if (deletableRefs.length > 0) {
      menuItems.push({
        label: `Delete Selected Branches (${deletableRefs.length})`,
        icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
        onClick: () => callbacks.onDeleteBranches(deletableRefs),
        danger: true,
      });
    }
  } else if (!isCurrent && !isMainBranch) {
    menuItems.push({
      label: 'Delete Branch',
      icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
      onClick: () => callbacks.onDeleteBranch(branchRef),
      danger: true,
    });
  }

  return menuItems;
}
