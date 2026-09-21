'use client';

import { useGitLog, useGitBranches, useGitStatus, useGitAction, useRepository, useUpdateRepository, useSettings, useUpdateSettings } from '@/hooks/use-git';
import { Repository, RepositoryCustomScript, Commit } from '@/lib/types';
import { GitGraph, GitGraphHandle } from './git-graph';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { cn, sanitizeBranchName } from '@/lib/utils';
import { ContextMenu, ContextMenuItem } from '@/components/context-menu';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';
import { toast } from '@/hooks/use-toast';
import { CommitChangesView } from './commit-changes-view';
import { StatusView } from './status-view';
import { VisibilityMap, buildBranchTree, buildRemoteBranchTree, getEffectiveVisibility, collectAllBranchRefs, collectVisibleBranchRefs } from './branch-tree-utils';
import { GroupHeader } from './group-header';
import { BranchMenuOptions, BranchOperation, buildBranchContextMenuItems } from './branch-context-menu';
import { BranchRowSelectModifiers, BranchTreeItem } from './branch-tree-item';
import { CommitRowSelectModifiers } from './commit-row-select-modifiers';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useCustomScriptExecution } from '@/contexts/custom-script-execution-context';


const MIN_HISTORY_PANEL_HEIGHT = 100;
const MAX_HISTORY_PANEL_HEIGHT = 900;
const MIN_COMMIT_DETAILS_MESSAGE_RATIO = 0.15;
const MAX_COMMIT_DETAILS_MESSAGE_RATIO = 0.75;
const DEFAULT_COMMIT_DETAILS_MESSAGE_RATIO = 0.28;
type MergeConflictStatus = 'checking' | 'no-conflict' | 'has-conflicts';

function clampHistoryPanelHeight(height: number): number {
  return Math.min(Math.max(height, MIN_HISTORY_PANEL_HEIGHT), MAX_HISTORY_PANEL_HEIGHT);
}

function clampCommitDetailsMessageRatio(ratio: number): number {
  return Math.min(Math.max(ratio, MIN_COMMIT_DETAILS_MESSAGE_RATIO), MAX_COMMIT_DETAILS_MESSAGE_RATIO);
}

function buildCommitMessage(subject: string, body: string): string {
  const trimmedSubject = subject.trim();
  const normalizedBody = body.replace(/\r\n/g, '\n');
  return normalizedBody.trim() ? `${trimmedSubject}\n\n${normalizedBody}` : trimmedSubject;
}

function formatCommitMessageForDisplay(message: string): string {
  return message
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

function parseTrackingUpstream(upstream: string): { remote: string; branch: string } | null {
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, slashIndex),
    branch: upstream.slice(slashIndex + 1),
  };
}

export function HistoryView({ repoPath }: { repoPath: string }) {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedBranchFromQuery = (searchParams.get('branch') ?? '').trim();
  const initialBranchCheckoutAttemptKeyRef = useRef<string | null>(null);
  const initialBranchHeadSelectionAttemptKeyRef = useRef<string | null>(null);
  
  const [limit, setLimit] = useState(100);
  const { data: log, isLoading, isError, error, refetch: refetchLog, isFetching } = useGitLog(repoPath, limit);
  const { data: branchData, isLoading: isBranchesLoading, refetch: refetchBranches } = useGitBranches(repoPath);
  const activeBranchFromData = branchData?.current?.trim() ?? '';
  const { data: statusData, refetch: refetchStatus } = useGitStatus(repoPath);
  const hasLocalChanges = Boolean(statusData?.files && statusData.files.length > 0);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [selectedCommitHashes, setSelectedCommitHashes] = useState<string[]>([]);
  const [selectionAnchorHash, setSelectionAnchorHash] = useState<string | null>(null);
  const lastVisibilityRefreshAtRef = useRef(0);

  const refreshBranchesAndHistory = useCallback(() => {
    const now = Date.now();
    if (now - lastVisibilityRefreshAtRef.current < 500) return;
    lastVisibilityRefreshAtRef.current = now;
    void Promise.all([refetchBranches(), refetchLog(), refetchStatus()]);
  }, [refetchBranches, refetchLog, refetchStatus]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshBranchesAndHistory();
      }
    };

    const handleWindowFocus = () => {
      if (document.visibilityState === 'visible') {
        refreshBranchesAndHistory();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [refreshBranchesAndHistory]);

  const selectSingleCommit = useCallback((hash: string | null) => {
    setSelectedHash(hash);
    setSelectedCommitHashes(hash ? [hash] : []);
    setSelectionAnchorHash(hash);
  }, []);

  // Clear selected commit and close commit details panel when repository changes
  useEffect(() => {
    selectSingleCommit(null);
    setSelectedBranchRefs([]);
    setBranchSelectionAnchor(null);
  }, [repoPath, selectSingleCommit]);

  // If local changes were selected and all changes get committed or discarded, reset selection
  useEffect(() => {
    if (!hasLocalChanges && selectedHash === '__LOCAL_CHANGES__') {
      selectSingleCommit(null);
    }
  }, [hasLocalChanges, selectedHash, selectSingleCommit]);

  const { mutateAsync: runGitAction } = useGitAction();

  const openConflictResolver = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    const query = params.toString();
    router.push(query ? `/workspace/conflicts?${query}` : '/workspace/conflicts');
  }, [router, searchParams]);

  const isMergeOrRebaseConflictError = useCallback((error: unknown) => {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes('conflict') ||
      message.includes('could not apply') ||
      message.includes('fix conflicts') ||
      message.includes('resolve all conflicts') ||
      message.includes('merge --continue') ||
      message.includes('rebase --continue')
    );
  }, []);

  useEffect(() => {
    initialBranchCheckoutAttemptKeyRef.current = null;
    initialBranchHeadSelectionAttemptKeyRef.current = null;
  }, [repoPath]);

  useEffect(() => {
    if (!requestedBranchFromQuery || !branchData) return;

    const requestKey = `${repoPath}:${requestedBranchFromQuery}`;
    if (initialBranchCheckoutAttemptKeyRef.current === requestKey) return;

    if (branchData.current === requestedBranchFromQuery) {
      initialBranchCheckoutAttemptKeyRef.current = requestKey;
      return;
    }

    if (!branchData.branches.includes(requestedBranchFromQuery)) {
      initialBranchCheckoutAttemptKeyRef.current = requestKey;
      toast({
        type: 'error',
        title: 'Branch Not Found',
        description: `Branch "${requestedBranchFromQuery}" does not exist in this repository.`,
      });
      return;
    }

    initialBranchCheckoutAttemptKeyRef.current = requestKey;

    void (async () => {
      try {
        await runGitAction({
          repoPath,
          action: 'checkout',
          data: { branch: requestedBranchFromQuery },
        });
      } catch (e) {
        console.error(e);
      }
    })();
  }, [branchData, repoPath, requestedBranchFromQuery, runGitAction]);

  const [iscreateBranchOpen, setIsCreateBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createBranchFromRef, setCreateBranchFromRef] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
  const [createTagCommitHash, setCreateTagCommitHash] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [pushTagToRemote, setPushTagToRemote] = useState(false);
  const [isCreatingTag, setIsCreatingTag] = useState(false);

  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [branchesToDelete, setBranchesToDelete] = useState<string[]>([]);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteWorktreeOpen, setIsDeleteWorktreeOpen] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<string | null>(null);
  const [isDeletingWorktree, setIsDeletingWorktree] = useState(false);
  const [isDeleteTagOpen, setIsDeleteTagOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<string | null>(null);
  const [deleteRemoteTag, setDeleteRemoteTag] = useState(false);
  const [isDeletingTag, setIsDeletingTag] = useState(false);

  const [isCherryPickOpen, setIsCherryPickOpen] = useState(false);
  const [commitsToCherryPick, setCommitsToCherryPick] = useState<{ hash: string; message: string }[]>([]);
  const [isCherryPicking, setIsCherryPicking] = useState(false);
  const [isAbortCherryPickOpen, setIsAbortCherryPickOpen] = useState(false);
  const [isAbortingCherryPick, setIsAbortingCherryPick] = useState(false);

  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [branchToRename, setBranchToRename] = useState<string | null>(null);
  const [remoteBranchToRename, setRemoteBranchToRename] = useState<{ remote: string; branch: string } | null>(null);
  const [newBranchNameForRename, setNewBranchNameForRename] = useState('');
  const [renameTrackingRemoteBranch, setRenameTrackingRemoteBranch] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isRenameRemoteOpen, setIsRenameRemoteOpen] = useState(false);
  const [remoteToRename, setRemoteToRename] = useState<string | null>(null);
  const [newRemoteNameForRename, setNewRemoteNameForRename] = useState('');
  const [isRenamingRemote, setIsRenamingRemote] = useState(false);
  const [isDeleteRemoteOpen, setIsDeleteRemoteOpen] = useState(false);
  const [remoteToDelete, setRemoteToDelete] = useState<string | null>(null);
  const [isDeletingRemote, setIsDeletingRemote] = useState(false);
  const [isAddRemoteOpen, setIsAddRemoteOpen] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState('origin');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [isAddingRemote, setIsAddingRemote] = useState(false);

  const [isRebaseOpen, setIsRebaseOpen] = useState(false);
  const [rebaseSourceBranch, setRebaseSourceBranch] = useState<string | null>(null);
  const [rebaseTargetBranch, setRebaseTargetBranch] = useState<string | null>(null);
  const [rebaseStashChanges, setRebaseStashChanges] = useState(true);
  const [isRebasing, setIsRebasing] = useState(false);
  const [rebaseConflictStatus, setRebaseConflictStatus] = useState<MergeConflictStatus>('checking');

  const closeRebaseDialog = useCallback(() => {
    setIsRebaseOpen(false);
    setRebaseSourceBranch(null);
    setRebaseTargetBranch(null);
    setRebaseConflictStatus('checking');
  }, []);

  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [mergeTargetBranch, setMergeTargetBranch] = useState<string | null>(null);
  const [mergeSourceBranch, setMergeSourceBranch] = useState<string | null>(null);
  const [mergeRebaseBeforeMerge, setMergeRebaseBeforeMerge] = useState(false);
  const [mergeSquash, setMergeSquash] = useState(false);
  const [mergeFastForward, setMergeFastForward] = useState(false);
  const [mergeSquashMessage, setMergeSquashMessage] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeConflictStatus, setMergeConflictStatus] = useState<MergeConflictStatus>('checking');

  const closeMergeDialog = useCallback(() => {
    setIsMergeOpen(false);
    setMergeTargetBranch(null);
    setMergeSourceBranch(null);
    setMergeConflictStatus('checking');
  }, []);

  // Push to remote dialog state
  const [isPushOpen, setIsPushOpen] = useState(false);
  const [pushBranch, setPushBranch] = useState<string | null>(null);
  const [pushRemotes, setPushRemotes] = useState<string[]>([]);
  const [pushSelectedRemote, setPushSelectedRemote] = useState<string>('');
  const [pushRemoteBranches, setPushRemoteBranches] = useState<string[]>([]);
  const [pushSelectedRemoteBranch, setPushSelectedRemoteBranch] = useState<string>('');
  const [pushTrackingBranch, setPushTrackingBranch] = useState<{ remote: string; branch: string } | null>(null);
  const [pushRebaseFirst, setPushRebaseFirst] = useState(false);
  const [pushForcePush, setPushForcePush] = useState(false);
  const [pushLocalOnlyTags, setPushLocalOnlyTags] = useState(true);
  const [pushSquash, setPushSquash] = useState(false);
  const [pushSquashMessage, setPushSquashMessage] = useState('');
  const [isPushing, setIsPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushLoadingRemotes, setPushLoadingRemotes] = useState(false);
  const [pushLoadingBranches, setPushLoadingBranches] = useState(false);

  // Pull from remote dialog state
  const [isPullOpen, setIsPullOpen] = useState(false);
  const [pullBranch, setPullBranch] = useState<string | null>(null);
  const [pullRemotes, setPullRemotes] = useState<string[]>([]);
  const [pullSelectedRemote, setPullSelectedRemote] = useState<string>('');
  const [pullRemoteBranches, setPullRemoteBranches] = useState<string[]>([]);
  const [pullSelectedRemoteBranch, setPullSelectedRemoteBranch] = useState<string>('');
  const [pullTrackingBranch, setPullTrackingBranch] = useState<{ remote: string; branch: string } | null>(null);
  const [pullRebase, setPullRebase] = useState(true);
  const [isPulling, setIsPulling] = useState(false);
  const [isPullingAllBranches, setIsPullingAllBranches] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullLoadingRemotes, setPullLoadingRemotes] = useState(false);
  const [pullLoadingBranches, setPullLoadingBranches] = useState(false);
  const [isFetchingAllRemotes, setIsFetchingAllRemotes] = useState(false);
  const [isOpeningRepoFolder, setIsOpeningRepoFolder] = useState(false);
  const [isOpeningRepoTerminal, setIsOpeningRepoTerminal] = useState(false);

  // Checkout to local dialog state
  const [isCheckoutToLocalOpen, setIsCheckoutToLocalOpen] = useState(false);
  const [checkoutRemoteBranch, setCheckoutRemoteBranch] = useState<string | null>(null);
  const [checkoutLocalBranchName, setCheckoutLocalBranchName] = useState('');
  const [isCheckingOutToLocal, setIsCheckingOutToLocal] = useState(false);

  // Switch branch with uncommitted changes warning dialog state
  const [isSwitchBranchModalOpen, setIsSwitchBranchModalOpen] = useState(false);
  const [pendingBranchSwitch, setPendingBranchSwitch] = useState<
    | { type: 'local'; branch: string }
    | { type: 'remote'; remoteBranch: string; localBranch: string }
    | null
  >(null);
  const [switchBranchStrategy, setSwitchBranchStrategy] = useState<'stash-and-reapply' | 'discard'>('stash-and-reapply');
  const [isSwitchingBranch, setIsSwitchingBranch] = useState(false);

  // Reset to commit dialog state
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetCommitHash, setResetCommitHash] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [isRevertOpen, setIsRevertOpen] = useState(false);
  const [commitToRevert, setCommitToRevert] = useState<{ hash: string; message: string } | null>(null);
  const [isReverting, setIsReverting] = useState(false);

  const [isRewordOpen, setIsRewordOpen] = useState(false);
  const [commitToReword, setCommitToReword] = useState<{ hash: string; subject: string; body: string; branch: string } | null>(null);
  const [newMessageSubject, setNewMessageSubject] = useState('');
  const [newMessageBody, setNewMessageBody] = useState('');
  const [isRewording, setIsRewording] = useState(false);

  // Ref for GitGraph to scroll to commits
  const gitGraphRef = useRef<GitGraphHandle>(null);
  
  // State for pending scroll to branch commit
  const [pendingScrollCommit, setPendingScrollCommit] = useState<string | null>(null);
  const [selectedBranchRefs, setSelectedBranchRefs] = useState<string[]>([]);
  const [branchSelectionAnchor, setBranchSelectionAnchor] = useState<string | null>(null);
  const [isBranchPopoverOpen, setIsBranchPopoverOpen] = useState(false);
  const branchPopoverRef = useRef<HTMLDivElement>(null);
  const { startScript } = useCustomScriptExecution();
  const [isCustomScriptsMenuOpen, setIsCustomScriptsMenuOpen] = useState(false);
  const customScriptsMenuRef = useRef<HTMLDivElement>(null);

  const closeRenameBranchDialog = useCallback(() => {
    setIsRenameOpen(false);
    setBranchToRename(null);
    setRemoteBranchToRename(null);
    setNewBranchNameForRename('');
    setRenameTrackingRemoteBranch(false);
  }, []);

  const closeRenameRemoteDialog = useCallback(() => {
    setIsRenameRemoteOpen(false);
    setRemoteToRename(null);
    setNewRemoteNameForRename('');
  }, []);

  const closeDeleteRemoteDialog = useCallback(() => {
    setIsDeleteRemoteOpen(false);
    setRemoteToDelete(null);
  }, []);

  const closeAddRemoteDialog = useCallback(() => {
    setIsAddRemoteOpen(false);
    setNewRemoteName('origin');
    setNewRemoteUrl('');
  }, []);

  const closeRewordDialog = useCallback(() => {
    setIsRewordOpen(false);
    setCommitToReword(null);
    setNewMessageSubject('');
    setNewMessageBody('');
  }, []);

  const closeTopPopup = useCallback(() => {
    if (isSwitchBranchModalOpen) {
      if (!isSwitchingBranch) {
        setIsSwitchBranchModalOpen(false);
        setPendingBranchSwitch(null);
      }
      return;
    }
    if (isAbortCherryPickOpen) {
      setIsAbortCherryPickOpen(false);
      setCommitsToCherryPick([]);
      return;
    }
    if (isCheckoutToLocalOpen) {
      setIsCheckoutToLocalOpen(false);
      return;
    }
    if (iscreateBranchOpen) {
      setIsCreateBranchOpen(false);
      setCreateBranchFromRef(null);
      return;
    }
    if (isCreateTagOpen) {
      setIsCreateTagOpen(false);
      setCreateTagCommitHash(null);
      setNewTagName('');
      setPushTagToRemote(false);
      return;
    }
    if (isPullOpen) {
      setIsPullOpen(false);
      return;
    }
    if (isPushOpen) {
      setIsPushOpen(false);
      return;
    }
    if (isMergeOpen) {
      closeMergeDialog();
      return;
    }
    if (isRebaseOpen) {
      closeRebaseDialog();
      return;
    }
    if (isRenameOpen) {
      closeRenameBranchDialog();
      return;
    }
    if (isRenameRemoteOpen) {
      closeRenameRemoteDialog();
      return;
    }
    if (isDeleteRemoteOpen) {
      closeDeleteRemoteDialog();
      return;
    }
    if (isAddRemoteOpen) {
      closeAddRemoteDialog();
      return;
    }
    if (isCherryPickOpen) {
      setIsCherryPickOpen(false);
      setCommitsToCherryPick([]);
      return;
    }
    if (isDeleteOpen) {
      setIsDeleteOpen(false);
      setBranchesToDelete([]);
      setDeleteRemoteBranch(false);
      return;
    }
    if (isDeleteWorktreeOpen) {
      setIsDeleteWorktreeOpen(false);
      setWorktreeToDelete(null);
      return;
    }
    if (isDeleteTagOpen) {
      setIsDeleteTagOpen(false);
      setTagToDelete(null);
      setDeleteRemoteTag(false);
      return;
    }
    if (isRewordOpen) {
      closeRewordDialog();
      return;
    }
    if (isResetOpen) {
      setIsResetOpen(false);
      return;
    }
    if (isRevertOpen) {
      setIsRevertOpen(false);
      setCommitToRevert(null);
      return;
    }
    if (isBranchPopoverOpen) {
      setIsBranchPopoverOpen(false);
      return;
    }
    if (isCustomScriptsMenuOpen) {
      setIsCustomScriptsMenuOpen(false);
      return;
    }
  }, [
    isAbortCherryPickOpen,
    isCheckoutToLocalOpen,
    iscreateBranchOpen,
    isCreateTagOpen,
    isPullOpen,
    isPushOpen,
    closeMergeDialog,
    isMergeOpen,
    closeRebaseDialog,
    isRebaseOpen,
    isRenameOpen,
    closeRenameBranchDialog,
    isRenameRemoteOpen,
    closeRenameRemoteDialog,
    isDeleteRemoteOpen,
    closeDeleteRemoteDialog,
    isAddRemoteOpen,
    closeAddRemoteDialog,
    isCherryPickOpen,
    isDeleteOpen,
    isDeleteWorktreeOpen,
    isDeleteTagOpen,
    isRewordOpen,
    closeRewordDialog,
    isResetOpen,
    isRevertOpen,
    isBranchPopoverOpen,
    isCustomScriptsMenuOpen,
    isSwitchBranchModalOpen,
    isSwitchingBranch,
  ]);

  const confirmTopPopup = () => {
    if (isSwitchBranchModalOpen) {
      if (!isSwitchingBranch) {
        void handleConfirmSwitchBranch();
      }
      return;
    }
    if (isAbortCherryPickOpen) {
      if (!isAbortingCherryPick) {
        void handleAbortCherryPick();
      }
      return;
    }
    if (isCheckoutToLocalOpen) {
      if (checkoutLocalBranchName && !isCheckingOutToLocal) {
        void handleCheckoutToLocal();
      }
      return;
    }
    if (iscreateBranchOpen) {
      if (newBranchName && !isCreating) {
        void handleCreateBranch();
      }
      return;
    }
    if (isCreateTagOpen) {
      if (newTagName.trim() && !isCreatingTag) {
        void handleCreateTag();
      }
      return;
    }
    if (isPullOpen) {
      if (!isPulling && pullRemotes.length > 0 && pullSelectedRemote && pullSelectedRemoteBranch) {
        void handlePullFromRemote();
      }
      return;
    }
    if (isPushOpen) {
      if (!isPushing && pushRemotes.length > 0 && pushSelectedRemote && pushSelectedRemoteBranch) {
        void handlePushToRemote();
      }
      return;
    }
    if (isMergeOpen) {
      if (!isMerging) {
        void handleMerge();
      }
      return;
    }
    if (isRebaseOpen) {
      if (!isRebasing) {
        void handleRebase();
      }
      return;
    }
    if (isRenameOpen) {
      const isSameName = remoteBranchToRename
        ? newBranchNameForRename === remoteBranchToRename.branch
        : newBranchNameForRename === branchToRename;
      if (newBranchNameForRename && !isSameName && !isRenaming) {
        void handleRenameBranch();
      }
      return;
    }
    if (isRenameRemoteOpen) {
      const trimmedNewName = newRemoteNameForRename.trim();
      if (
        trimmedNewName &&
        trimmedNewName !== (remoteToRename ?? '').trim() &&
        !isRenamingRemote
      ) {
        void handleRenameRemote();
      }
      return;
    }
    if (isDeleteRemoteOpen) {
      if (remoteToDelete && !isDeletingRemote) {
        void handleDeleteRemote();
      }
      return;
    }
    if (isAddRemoteOpen) {
      if (newRemoteName.trim() && newRemoteUrl.trim() && !isAddingRemote) {
        void handleAddRemote();
      }
      return;
    }
    if (isCherryPickOpen) {
      if (!isCherryPicking) {
        void handleCherryPickCommit();
      }
      return;
    }
    if (isDeleteOpen) {
      if (!isDeleting) {
        void handleDeleteBranch();
      }
      return;
    }
    if (isDeleteWorktreeOpen) {
      if (worktreeToDelete && !isDeletingWorktree) {
        void handleDeleteWorktree();
      }
      return;
    }
    if (isDeleteTagOpen) {
      if (tagToDelete && !isDeletingTag) {
        void handleDeleteTag();
      }
      return;
    }
    if (isRewordOpen) {
      if (newMessageSubject.trim() && !isRewording) {
        void handleReword();
      }
      return;
    }
    if (isResetOpen) {
      if (!isResetting) {
        void handleConfirmReset();
      }
      return;
    }
    if (isRevertOpen) {
      if (!isReverting) {
        void handleConfirmRevert();
      }
      return;
    }
  };

  const isAnyPopupOpen =
    isResetOpen ||
    isRevertOpen ||
    isRewordOpen ||
    isDeleteOpen ||
    isDeleteWorktreeOpen ||
    isDeleteTagOpen ||
    isAbortCherryPickOpen ||
    isCherryPickOpen ||
    isRenameOpen ||
    isRenameRemoteOpen ||
    isDeleteRemoteOpen ||
    isAddRemoteOpen ||
    isRebaseOpen ||
    isMergeOpen ||
    isPushOpen ||
    isPullOpen ||
    iscreateBranchOpen ||
    isCreateTagOpen ||
    isCheckoutToLocalOpen ||
    isSwitchBranchModalOpen ||
    isBranchPopoverOpen ||
    isCustomScriptsMenuOpen;

  useEscapeDismiss(isAnyPopupOpen, closeTopPopup, confirmTopPopup);

  // Resizable bottom panel state - load from global settings or fallback to localStorage
  const panelHeightStorageKey = 'git-web:history-panel-height';
  const commitDetailsMessageRatioStorageKey = 'git-web:history-commit-details-message-ratio';
  const [panelHeight, setPanelHeight] = useState(300);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [commitDetailsMessageRatio, setCommitDetailsMessageRatio] = useState(DEFAULT_COMMIT_DETAILS_MESSAGE_RATIO);
  const [isCommitDetailsRatioResizing, setIsCommitDetailsRatioResizing] = useState(false);
  const commitDetailsContentRef = useRef<HTMLDivElement | null>(null);
  
  // Track if user has manually resized the panel to avoid sync loops
  const userHasResized = useRef(false);

  // Load panel height from settings or localStorage
  useEffect(() => {
    if (settings?.historyPanelHeight) {
      setPanelHeight(clampHistoryPanelHeight(settings.historyPanelHeight));
    } else {
      try {
        const stored = localStorage.getItem(panelHeightStorageKey);
        if (stored) {
          const parsed = parseInt(stored, 10);
          if (!isNaN(parsed) && parsed >= MIN_HISTORY_PANEL_HEIGHT && parsed <= MAX_HISTORY_PANEL_HEIGHT) {
            setPanelHeight(parsed);
          }
        }
      } catch (e) {
        console.error('Failed to load panel height from localStorage:', e);
      }
    }
  }, [settings?.historyPanelHeight]);

  // Save panel height to localStorage for immediate persistence
  useEffect(() => {
    try {
      localStorage.setItem(panelHeightStorageKey, String(panelHeight));
    } catch (e) {
      console.error('Failed to save panel height to localStorage:', e);
    }
  }, [panelHeight]);

  // Load commit details message/diff ratio from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(commitDetailsMessageRatioStorageKey);
      if (!stored) return;
      const parsed = parseFloat(stored);
      if (!Number.isNaN(parsed)) {
        setCommitDetailsMessageRatio(clampCommitDetailsMessageRatio(parsed));
      }
    } catch (e) {
      console.error('Failed to load commit details ratio from localStorage:', e);
    }
  }, []);

  // Persist commit details message/diff ratio in localStorage
  useEffect(() => {
    try {
      localStorage.setItem(commitDetailsMessageRatioStorageKey, String(commitDetailsMessageRatio));
    } catch (e) {
      console.error('Failed to save commit details ratio to localStorage:', e);
    }
  }, [commitDetailsMessageRatio]);

  // Sync to global settings when resizing stops
  useEffect(() => {
    if (!isResizing && userHasResized.current) {
      updateSettings.mutate({ historyPanelHeight: panelHeight });
      userHasResized.current = false;
    }
  }, [isResizing, panelHeight, updateSettings]);

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = { startY: e.clientY, startHeight: panelHeight };
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - e.clientY;
      const newHeight = clampHistoryPanelHeight(resizeRef.current.startHeight + delta);
      setPanelHeight(newHeight);
      userHasResized.current = true;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const handleCommitDetailsRatioResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsCommitDetailsRatioResizing(true);
  }, []);

  useEffect(() => {
    if (!isCommitDetailsRatioResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = commitDetailsContentRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.height <= 0) return;

      const nextRatio = clampCommitDetailsMessageRatio((e.clientY - rect.top) / rect.height);
      setCommitDetailsMessageRatio(nextRatio);
    };

    const handleMouseUp = () => {
      setIsCommitDetailsRatioResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isCommitDetailsRatioResizing]);

  useEffect(() => {
    if (!isBranchPopoverOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (branchPopoverRef.current && !branchPopoverRef.current.contains(event.target as Node)) {
        setIsBranchPopoverOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isBranchPopoverOpen]);

  useEffect(() => {
    if (!isCustomScriptsMenuOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (customScriptsMenuRef.current && !customScriptsMenuRef.current.contains(event.target as Node)) {
        setIsCustomScriptsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isCustomScriptsMenuOpen]);

  // Build branch trees for local and remote branches
  const localBranchTree = useMemo(() => {
    if (!branchData?.branches) return null;
    return buildBranchTree(branchData.branches);
  }, [branchData?.branches]);
  
  const remoteBranchTrees = useMemo(() => {
    if (!branchData?.remotes) return null;
    return buildRemoteBranchTree(branchData.remotes);
  }, [branchData?.remotes]);

  const allBranchRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const branch of branchData?.branches ?? []) {
      refs.add(branch);
    }
    for (const [remoteName, branches] of Object.entries(branchData?.remotes ?? {})) {
      for (const branch of branches) {
        refs.add(`remotes/${remoteName}/${branch}`);
      }
    }
    return refs;
  }, [branchData?.branches, branchData?.remotes]);

  const selectedBranchSet = useMemo(() => new Set(selectedBranchRefs), [selectedBranchRefs]);

  const repository = useRepository(repoPath);
  const updateRepository = useUpdateRepository();
  const customBranchScripts = useMemo(() => {
    const scripts = repository?.customScripts ?? [];
    return scripts.filter((script) => (
      script.target === 'branch' &&
      script.action === 'run-bash-script' &&
      script.name.trim().length > 0 &&
      script.content.trim().length > 0
    ));
  }, [repository?.customScripts]);

  // Group expanded state (for "Branches", "Remotes", and "Worktrees" group headers)
  const [localGroupExpanded, setLocalGroupExpanded] = useState(true);
  const [remotesGroupExpanded, setRemotesGroupExpanded] = useState(true);
  const [worktreesGroupExpanded, setWorktreesGroupExpanded] = useState(true);

  // Visibility state for branches/folders
  const [visibilityMap, setVisibilityMap] = useState<VisibilityMap>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const orderedVisibleBranchRefs = useMemo(() => {
    const ordered: string[] = [];
    if (localGroupExpanded && localBranchTree) {
      ordered.push(...collectVisibleBranchRefs(localBranchTree, expandedFolders));
    }
    if (remotesGroupExpanded && remoteBranchTrees) {
      for (const [remoteName, tree] of Array.from(remoteBranchTrees.entries())) {
        const remoteGroupPath = `__remotes__/${remoteName}`;
        if (!expandedFolders.has(remoteGroupPath)) continue;
        ordered.push(...collectVisibleBranchRefs(tree, expandedFolders, `remotes/${remoteName}`));
      }
    }
    return ordered;
  }, [expandedFolders, localBranchTree, localGroupExpanded, remoteBranchTrees, remotesGroupExpanded]);

  useEffect(() => {
    if (selectedBranchRefs.length === 0) return;
    const nextSelected = selectedBranchRefs.filter((branch) => allBranchRefs.has(branch));
    if (nextSelected.length !== selectedBranchRefs.length) {
      setSelectedBranchRefs(nextSelected);
    }
    if (branchSelectionAnchor && !allBranchRefs.has(branchSelectionAnchor)) {
      setBranchSelectionAnchor(nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null);
    }
  }, [allBranchRefs, branchSelectionAnchor, selectedBranchRefs]);

  // Load settings from repository data when it's available
  const lastInitializedRepo = useRef<string | null>(null);
  useEffect(() => {
    if (repository && repository.path !== lastInitializedRepo.current) {
      lastInitializedRepo.current = repository.path;
      if (repository.localGroupExpanded !== undefined) setLocalGroupExpanded(repository.localGroupExpanded);
      if (repository.remotesGroupExpanded !== undefined) setRemotesGroupExpanded(repository.remotesGroupExpanded);
      if (repository.worktreesGroupExpanded !== undefined) setWorktreesGroupExpanded(repository.worktreesGroupExpanded);
      if (repository.expandedFolders) setExpandedFolders(new Set(repository.expandedFolders));
      if (repository.visibilityMap) setVisibilityMap(repository.visibilityMap as VisibilityMap);
    }
  }, [repository]);

  // Helper to save settings to the backend
  const saveSettings = useCallback((updates: Partial<Repository>) => {
    updateRepository.mutate({
      path: repoPath,
      updates
    });
  }, [repoPath, updateRepository]);

  const handleToggleLocalGroup = useCallback(() => {
    const newValue = !localGroupExpanded;
    setLocalGroupExpanded(newValue);
    saveSettings({ localGroupExpanded: newValue });
  }, [localGroupExpanded, saveSettings]);

  const handleToggleRemotesGroup = useCallback(() => {
    const newValue = !remotesGroupExpanded;
    setRemotesGroupExpanded(newValue);
    saveSettings({ remotesGroupExpanded: newValue });
  }, [remotesGroupExpanded, saveSettings]);

  const handleToggleWorktreesGroup = useCallback(() => {
    const newValue = !worktreesGroupExpanded;
    setWorktreesGroupExpanded(newValue);
    saveSettings({ worktreesGroupExpanded: newValue });
  }, [saveSettings, worktreesGroupExpanded]);

  // Toggle folder expansion
  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveSettings({ expandedFolders: Array.from(next) });
      return next;
    });
  }, [saveSettings]);

  // Toggle visibility for a path
  const handleToggleVisibility = useCallback((path: string, type: 'visible' | 'hidden') => {
    setVisibilityMap(prev => {
      const next = { ...prev };
      // If currently set to this type, remove it (toggle off)
      if (next[path] === type) {
        delete next[path];
      } else {
        // Set to this type (auto-removes the other one since we're replacing)
        next[path] = type;
      }
      const persistedVisibilityMap: Record<string, 'visible' | 'hidden'> = {};
      Object.entries(next).forEach(([key, value]) => {
        if (value === 'visible' || value === 'hidden') {
          persistedVisibilityMap[key] = value;
        }
      });
      saveSettings({ visibilityMap: persistedVisibilityMap });
      return next;
    });
  }, [saveSettings]);

  // Clear all visibility filters
  const handleClearAllFilters = useCallback(() => {
    setVisibilityMap({});
    saveSettings({ visibilityMap: {} });
  }, [saveSettings]);

  // Helper to get effective visibility for a branch considering group paths
  const getBranchEffectiveVisibility = useCallback((branch: string, isRemoteBranch: boolean) => {
    // First check the branch itself
    const directVis = getEffectiveVisibility(branch, visibilityMap);
    if (directVis) return directVis;
    
    // Check group-level visibility
    if (isRemoteBranch) {
      // Remote branch format: remotes/origin/branch-name
      const parts = branch.split('/');
      if (parts.length >= 2 && parts[0] === 'remotes') {
        const remoteName = parts[1];
        // Check remote-specific group
        const remoteGroupVis = visibilityMap[`__remotes__/${remoteName}`];
        if (remoteGroupVis) return remoteGroupVis;
        // Check all remotes group
        const remotesVis = visibilityMap['__remotes__'];
        if (remotesVis) return remotesVis;
      }
    } else {
      // Local branch - check __local__ group
      const localVis = visibilityMap['__local__'];
      if (localVis) return localVis;
    }
    
    return null;
  }, [visibilityMap]);

  // Compute which branches should be visible based on visibility map
  const filteredCommits = useMemo(() => {
    if (!log?.all || !branchData?.branches || !branchData?.branchCommits) return log?.all || [];

    const hasVisibleMarkers = Object.values(visibilityMap).some(v => v === 'visible');
    const hasHiddenMarkers = Object.values(visibilityMap).some(v => v === 'hidden');

    // If no visibility markers are set, show all commits
    if (!hasVisibleMarkers && !hasHiddenMarkers) {
      return log.all;
    }

    // Get all branches (local + remote)
    const allBranches: { branch: string; isRemote: boolean }[] = [
      ...branchData.branches.map(b => ({ branch: b, isRemote: false })),
    ];
    
    // Add remote branches
    if (branchData.remotes) {
      for (const [remoteName, branches] of Object.entries(branchData.remotes)) {
        for (const branch of branches) {
          allBranches.push({ branch: `remotes/${remoteName}/${branch}`, isRemote: true });
        }
      }
    }

    // Calculate effective visibility for each branch
    const visibleBranches = new Set<string>();
    const hiddenBranchesSet = new Set<string>();
    const nonHiddenBranches = new Set<string>(); // Branches that are not hidden (for hidden-only mode)
    
    for (const { branch, isRemote } of allBranches) {
      const effectiveVis = getBranchEffectiveVisibility(branch, isRemote);
      if (effectiveVis === 'visible') {
        visibleBranches.add(branch);
      } else if (effectiveVis === 'hidden') {
        hiddenBranchesSet.add(branch);
      } else {
        // No visibility set - this branch is "neutral" (non-hidden)
        nonHiddenBranches.add(branch);
      }
    }

    // Build a map from commit hash to commit for quick lookup
    const commitMap = new Map(log.all.map(c => [c.hash, c]));
    
    // Helper to mark all ancestors as reachable
    const markReachable = (startHash: string, reachableSet: Set<string>) => {
      const stack = [startHash];
      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (reachableSet.has(hash)) continue;
        
        const commit = commitMap.get(hash);
        if (!commit) continue;
        
        reachableSet.add(hash);
        
        // Add parents to process
        for (const parentHash of commit.parents || []) {
          if (!reachableSet.has(parentHash)) {
            stack.push(parentHash);
          }
        }
      }
    };
    
    // Find commits reachable from visible branches
    const reachableFromVisible = new Set<string>();
    for (const branch of visibleBranches) {
      const headHash = branchData.branchCommits[branch];
      if (headHash) {
        markReachable(headHash, reachableFromVisible);
      }
    }
    
    // If there are visible markers, only show commits reachable from visible branches
    if (hasVisibleMarkers) {
      return log.all.filter(commit => reachableFromVisible.has(commit.hash));
    }
    
    // If only hidden markers exist, show commits reachable from any non-hidden branch
    // A commit should only be hidden if it's EXCLUSIVELY reachable from hidden branches
    if (hasHiddenMarkers) {
      const reachableFromNonHidden = new Set<string>();
      for (const branch of nonHiddenBranches) {
        const headHash = branchData.branchCommits[branch];
        if (headHash) {
          markReachable(headHash, reachableFromNonHidden);
        }
      }
      
      return log.all.filter(commit => reachableFromNonHidden.has(commit.hash));
    }
    
    return log.all;
  }, [log?.all, branchData?.branches, branchData?.branchCommits, branchData?.remotes, visibilityMap, getBranchEffectiveVisibility]);

  const currentBranch = branchData?.current?.trim() || statusData?.current?.trim() || '';

  const currentHeadHash = useMemo(() => {
    if (currentBranch && branchData?.branchCommits?.[currentBranch]) {
      return branchData.branchCommits[currentBranch];
    }
    if (log?.all && log.all.length > 0) {
      return log.all[0].hash;
    }
    return null;
  }, [currentBranch, branchData?.branchCommits, log?.all]);

  const commitsWithLocalChanges = useMemo(() => {
    if (!hasLocalChanges) {
      return filteredCommits;
    }

    const localChangesCommit: Commit = {
      hash: '__LOCAL_CHANGES__',
      message: '(local changes)',
      date: new Date().toISOString(),
      refs: '',
      body: '',
      author_name: '',
      author_email: '',
      parents: currentHeadHash ? [currentHeadHash] : [],
    };

    return [localChangesCommit, ...filteredCommits];
  }, [hasLocalChanges, filteredCommits, currentHeadHash]);

  const selectedCommitHashSet = useMemo(() => new Set(selectedCommitHashes), [selectedCommitHashes]);
  const filteredCommitHashes = useMemo(() => commitsWithLocalChanges.map((commit) => commit.hash), [commitsWithLocalChanges]);
  const selectedCommit = useMemo(
    () => (selectedHash && selectedHash !== '__LOCAL_CHANGES__' ? log?.all.find((commit) => commit.hash === selectedHash) : null),
    [log?.all, selectedHash]
  );
  const headerScriptTargetRef = useMemo(() => {
    if (selectedCommit && selectedCommit.hash && selectedCommit.hash !== '__LOCAL_CHANGES__') {
      return {
        ref: selectedCommit.hash,
        label: `Commit ${selectedCommit.hash.substring(0, 7)}`,
        sublabel: selectedCommit.message,
      };
    }
    const branch = currentBranch || 'HEAD';
    return {
      ref: branch,
      label: `Branch ${branch}`,
      sublabel: null,
    };
  }, [selectedCommit, currentBranch]);
  const selectedCommitRange = useMemo(() => {
    if (!log?.all || selectedCommitHashes.length < 2 || selectedCommitHashes.includes('__LOCAL_CHANGES__')) return null;

    const commitMap = new Map(log.all.map((commit) => [commit.hash, commit]));
    const filteredOrderMap = new Map(filteredCommitHashes.map((hash, index) => [hash, index]));
    const orderedSelection = Array.from(new Set(selectedCommitHashes))
      .filter((hash) => filteredOrderMap.has(hash))
      .sort((a, b) => (filteredOrderMap.get(a) ?? Number.MAX_SAFE_INTEGER) - (filteredOrderMap.get(b) ?? Number.MAX_SAFE_INTEGER));

    if (orderedSelection.length < 2) return null;

    const latestHash = orderedSelection[0];
    const oldestHash = orderedSelection[orderedSelection.length - 1];
    const latestCommit = commitMap.get(latestHash);
    const oldestCommit = commitMap.get(oldestHash);

    if (!latestCommit || !oldestCommit) return null;

    return { latestHash, oldestHash, latestCommit, oldestCommit };
  }, [filteredCommitHashes, log?.all, selectedCommitHashes]);
  const isCommitRangeSelection = !!selectedCommitRange;

  useEffect(() => {
    if (filteredCommitHashes.length === 0) {
      if (selectedHash || selectedCommitHashes.length > 0 || selectionAnchorHash) {
        selectSingleCommit(null);
      }
      return;
    }

    const filteredHashSet = new Set(filteredCommitHashes);
    const nextSelected = selectedCommitHashes.filter((hash) => filteredHashSet.has(hash));

    if (nextSelected.length !== selectedCommitHashes.length) {
      setSelectedCommitHashes(nextSelected);
    }

    if (selectedHash && !filteredHashSet.has(selectedHash)) {
      setSelectedHash(nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null);
    }

    if (selectionAnchorHash && !filteredHashSet.has(selectionAnchorHash)) {
      setSelectionAnchorHash(nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null);
    }
  }, [filteredCommitHashes, selectedHash, selectedCommitHashes, selectionAnchorHash, selectSingleCommit]);

  const handleSelectCommit = useCallback((hash: string, modifiers?: CommitRowSelectModifiers) => {
    const isRangeSelect = modifiers?.isRangeSelect ?? false;
    const isMultiSelect = modifiers?.isMultiSelect ?? false;

    if (isRangeSelect) {
      const anchor = selectionAnchorHash ?? selectedHash ?? hash;
      const anchorIndex = filteredCommitHashes.indexOf(anchor);
      const targetIndex = filteredCommitHashes.indexOf(hash);

      if (anchorIndex !== -1 && targetIndex !== -1) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const rangeSelection = filteredCommitHashes.slice(start, end + 1);
        setSelectedCommitHashes(rangeSelection);
        setSelectedHash(hash);
        setSelectionAnchorHash(anchor);
        return;
      }
    }

    if (isMultiSelect) {
      if (selectedCommitHashSet.has(hash)) {
        const nextSelected = selectedCommitHashes.filter((selected) => selected !== hash);
        setSelectedCommitHashes(nextSelected);
        setSelectedHash((prev) => {
          if (prev !== hash) return prev;
          return nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null;
        });
        if (selectionAnchorHash === hash) {
          setSelectionAnchorHash(nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null);
        }
      } else {
        setSelectedCommitHashes([...selectedCommitHashes, hash]);
        setSelectedHash(hash);
        setSelectionAnchorHash(hash);
      }
      return;
    }

    selectSingleCommit(hash);
  }, [filteredCommitHashes, selectedCommitHashSet, selectedCommitHashes, selectedHash, selectionAnchorHash, selectSingleCommit]);

  const selectedCommitsForCherryPick = useMemo(
    () => filteredCommits.filter((commit) => selectedCommitHashSet.has(commit.hash)).reverse(),
    [filteredCommits, selectedCommitHashSet]
  );

  // Check if visibility filters are active
  const hasVisibilityFilters = useMemo(() => {
    return Object.values(visibilityMap).some(v => v === 'visible' || v === 'hidden');
  }, [visibilityMap]);

  // Compute hidden branches set for filtering branch tags in git graph
  const hiddenBranches = useMemo(() => {
    const hidden = new Set<string>();
    
    // Check local branches
    if (branchData?.branches) {
      for (const branch of branchData.branches) {
        const effectiveVis = getBranchEffectiveVisibility(branch, false);
        if (effectiveVis === 'hidden') {
          hidden.add(branch);
        }
      }
    }
    
    // Check remote branches
    if (branchData?.remotes) {
      for (const [remoteName, branches] of Object.entries(branchData.remotes)) {
        for (const branch of branches) {
          const fullRef = `remotes/${remoteName}/${branch}`;
          const effectiveVis = getBranchEffectiveVisibility(fullRef, true);
          if (effectiveVis === 'hidden') {
            hidden.add(fullRef);
          }
        }
      }
    }
    
    return hidden;
  }, [branchData?.branches, branchData?.remotes, getBranchEffectiveVisibility]);

  // Auto-fetch more commits when filtered results are too few
  const MIN_FILTERED_COMMITS = 50;
  const MAX_AUTO_FETCH_LIMIT = 5000;
  
  useEffect(() => {
    if (
      hasVisibilityFilters &&
      filteredCommits.length < MIN_FILTERED_COMMITS &&
      !isFetching &&
      limit < MAX_AUTO_FETCH_LIMIT &&
      log?.all && log.all.length >= limit
    ) {
      // Fetch more commits - increase limit by 100
      setLimit(l => Math.min(l + 100, MAX_AUTO_FETCH_LIMIT));
    }
  }, [hasVisibilityFilters, filteredCommits.length, isFetching, limit, log?.all]);

  // Handle scrolling to branch commit when it's loaded
  useEffect(() => {
    if (!pendingScrollCommit || !log?.all || isFetching) return;
    
    // Check if commit exists in current loaded commits
    const commitExists = log.all.some(c => c.hash === pendingScrollCommit);
    
    if (commitExists) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        const scrolled = gitGraphRef.current?.scrollToCommit(pendingScrollCommit);
        if (scrolled) {
          selectSingleCommit(pendingScrollCommit);
          setPendingScrollCommit(null);
        }
      });
    } else {
      // Need to load more commits - increase limit
      // Set a reasonable max limit to avoid infinite loading
      if (limit < 5000) {
        setLimit(l => l + 100);
      } else {
        // Give up after 5000 commits
        console.warn('Could not find commit after loading 5000 commits');
        setPendingScrollCommit(null);
      }
    }
  }, [pendingScrollCommit, log?.all, isFetching, limit, selectSingleCommit]);

  const scrollToBranchHeadCommit = useCallback((branch: string) => {
    if (!branchData?.branchCommits) return;

    const commitHash = branchData.branchCommits[branch];
    if (!commitHash) return;

    const commitExists = log?.all?.some(c => c.hash === commitHash);
    if (commitExists && gitGraphRef.current) {
      const scrolled = gitGraphRef.current.scrollToCommit(commitHash);
      if (scrolled) {
        selectSingleCommit(commitHash);
        return;
      }
    }

    setPendingScrollCommit(commitHash);
    selectSingleCommit(commitHash);
  }, [branchData?.branchCommits, log?.all, selectSingleCommit]);

  useEffect(() => {
    if (!requestedBranchFromQuery || !branchData?.branchCommits) return;
    if (activeBranchFromData !== requestedBranchFromQuery) return;

    const requestKey = `${repoPath}:${requestedBranchFromQuery}`;
    if (initialBranchHeadSelectionAttemptKeyRef.current === requestKey) return;

    initialBranchHeadSelectionAttemptKeyRef.current = requestKey;
    scrollToBranchHeadCommit(requestedBranchFromQuery);
  }, [activeBranchFromData, branchData?.branchCommits, repoPath, requestedBranchFromQuery, scrollToBranchHeadCommit]);

  const handleBranchClick = useCallback((branch: string, modifiers?: BranchRowSelectModifiers) => {
    const isRangeSelect = modifiers?.isRangeSelect ?? false;
    const isMultiSelect = modifiers?.isMultiSelect ?? false;

    if (isRangeSelect) {
      const anchor = branchSelectionAnchor ?? branch;
      const anchorIndex = orderedVisibleBranchRefs.indexOf(anchor);
      const targetIndex = orderedVisibleBranchRefs.indexOf(branch);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const rangeSelection = orderedVisibleBranchRefs.slice(start, end + 1);
        const shouldUnselect = selectedBranchSet.has(branch);
        if (shouldUnselect) {
          setSelectedBranchRefs(selectedBranchRefs.filter((selected) => !rangeSelection.includes(selected)));
        } else {
          setSelectedBranchRefs(Array.from(new Set([...selectedBranchRefs, ...rangeSelection])));
        }
        setBranchSelectionAnchor(anchor);
      } else {
        setSelectedBranchRefs([branch]);
        setBranchSelectionAnchor(branch);
      }
      return;
    }

    if (isMultiSelect) {
      if (selectedBranchSet.has(branch)) {
        const nextSelected = selectedBranchRefs.filter((selected) => selected !== branch);
        setSelectedBranchRefs(nextSelected);
      } else {
        setSelectedBranchRefs([...selectedBranchRefs, branch]);
      }
      setBranchSelectionAnchor(branch);
      return;
    }

    setSelectedBranchRefs([branch]);
    setBranchSelectionAnchor(branch);
    scrollToBranchHeadCommit(branch);
  }, [branchSelectionAnchor, orderedVisibleBranchRefs, scrollToBranchHeadCommit, selectedBranchRefs, selectedBranchSet]);

  const handleBranchContextMenu = useCallback((branch: string) => {
    if (selectedBranchSet.has(branch)) return;
    setSelectedBranchRefs([branch]);
    setBranchSelectionAnchor(branch);
  }, [selectedBranchSet]);

  const handleRunCustomScript = useCallback((script: RepositoryCustomScript, branchRef: string) => {
    void startScript({
      repoPath,
      branchRef,
      script,
    });
  }, [repoPath, startScript]);

  const confirmDeleteBranches = (branches: string[]) => {
    const deletableBranches = branches.filter((branch) => branch !== currentBranch);
    if (deletableBranches.length === 0) return;
    setBranchesToDelete(deletableBranches);
    setDeleteRemoteBranch(false);
    setIsDeleteOpen(true);
  };

  const confirmDeleteBranch = (branch: string) => {
    confirmDeleteBranches([branch]);
  };

  const confirmDeleteWorktree = useCallback((path: string) => {
    const targetPath = path.trim();
    if (!targetPath) return;
    setWorktreeToDelete(targetPath);
    setIsDeleteWorktreeOpen(true);
  }, []);

  const closeDeleteTagDialog = useCallback(() => {
    setIsDeleteTagOpen(false);
    setTagToDelete(null);
    setDeleteRemoteTag(false);
  }, []);

  const confirmDeleteTag = useCallback((tagName: string) => {
    if (!tagName) return;
    setTagToDelete(tagName);
    setDeleteRemoteTag(false);
    setIsDeleteTagOpen(true);
  }, []);

  const handleDeleteBranch = async () => {
    if (branchesToDelete.length === 0) return;
    setIsDeleting(true);
    try {
      const deleteRequests = new Map<string, { branchRef: string; run: () => Promise<unknown> }>();
      const addDeleteRequest = (key: string, branchRef: string, run: () => Promise<unknown>) => {
        if (deleteRequests.has(key)) return;
        deleteRequests.set(key, { branchRef, run });
      };

      const trackingRemotesToDelete = new Set<string>();
      if (deleteRemoteBranch) {
        for (const branchRef of branchesToDelete) {
          if (branchRef.startsWith('remotes/')) continue;
          const tracking = branchData?.trackingInfo?.[branchRef];
          if (tracking?.upstream) {
            trackingRemotesToDelete.add(tracking.upstream);
          }
        }
      }

      for (const upstream of trackingRemotesToDelete) {
        const [remote, ...branchParts] = upstream.split('/');
        const branch = branchParts.join('/');
        if (remote && branch) {
          const branchRef = `${remote}/${branch}`;
          addDeleteRequest(`remote:${branchRef}`, branchRef, () =>
            runGitAction({
              repoPath,
              action: 'delete-remote-branch',
              data: { remote, branch },
              suppressErrorToast: true,
            })
          );
        }
      }

      for (const branchRef of branchesToDelete) {
        if (branchRef.startsWith('remotes/')) {
          const parts = branchRef.split('/');
          if (parts.length >= 3) {
            const remote = parts[1];
            const branch = parts.slice(2).join('/');
            const remoteBranchRef = `${remote}/${branch}`;
            addDeleteRequest(`remote:${remoteBranchRef}`, remoteBranchRef, () =>
              runGitAction({
                repoPath,
                action: 'delete-remote-branch',
                data: { remote, branch },
                suppressErrorToast: true,
              })
            );
          }
          continue;
        }

        addDeleteRequest(`local:${branchRef}`, branchRef, () =>
          runGitAction({
            repoPath,
            action: 'delete-branch',
            data: { branch: branchRef },
            suppressErrorToast: true,
          })
        );
      }

      const requests = Array.from(deleteRequests.values());
      const results = await Promise.allSettled(requests.map((request) => request.run()));
      const failedBranches = results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [];
        const failedBranch = requests[index].branchRef;
        console.error(`Failed to delete branch "${failedBranch}":`, result.reason);
        return [failedBranch];
      });

      if (failedBranches.length > 0) {
        toast({
          type: 'error',
          title: failedBranches.length === 1
            ? 'Failed to Delete 1 Branch'
            : `Failed to Delete ${failedBranches.length} Branches`,
          description: (
            <div>
              <div>The following branches could not be deleted:</div>
              <ul className="mt-1 max-h-40 overflow-y-auto list-disc pl-5">
                {failedBranches.map((branch) => (
                  <li key={branch} className="break-all">{branch}</li>
                ))}
              </ul>
            </div>
          ),
          duration: 10000,
        });
      }

      setIsDeleteOpen(false);
      setBranchesToDelete([]);
      setDeleteRemoteBranch(false);
      setSelectedBranchRefs([]);
      setBranchSelectionAnchor(null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteTag = async () => {
    if (!tagToDelete) return;
    setIsDeletingTag(true);
    try {
      await runGitAction({
        repoPath,
        action: 'delete-tag',
        data: { tag: tagToDelete },
      });

      if (deleteRemoteTag && remoteNameForTagDelete) {
        try {
          await runGitAction({
            repoPath,
            action: 'delete-remote-tag',
            data: { remote: remoteNameForTagDelete, tag: tagToDelete },
          });
        } catch (error) {
          console.error('Failed to delete remote tag:', error);
        }
      }

      closeDeleteTagDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeletingTag(false);
    }
  };

  const handleDeleteWorktree = async () => {
    if (!worktreeToDelete) return;

    setIsDeletingWorktree(true);
    try {
      await runGitAction({
        repoPath,
        action: 'delete-worktree',
        data: { path: worktreeToDelete },
      });
      setIsDeleteWorktreeOpen(false);
      setWorktreeToDelete(null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeletingWorktree(false);
    }
  };

  const confirmRenameBranch = (branch: string) => {
    setBranchToRename(branch);
    setRemoteBranchToRename(null);
    // Pre-fill with current branch name
    setNewBranchNameForRename(branch);
    setRenameTrackingRemoteBranch(false);
    setIsRenameOpen(true);
  }

  const confirmRenameRemoteBranch = (fullRemoteBranch: string) => {
    const parts = fullRemoteBranch.split('/');
    if (parts.length < 3 || parts[0] !== 'remotes') return;

    const remote = parts[1];
    const branch = parts.slice(2).join('/');
    if (!remote || !branch) return;

    setBranchToRename(fullRemoteBranch);
    setRemoteBranchToRename({ remote, branch });
    setNewBranchNameForRename(branch);
    setRenameTrackingRemoteBranch(false);
    setIsRenameOpen(true);
  }

  const confirmRenameRemote = (remote: string) => {
    setRemoteToRename(remote);
    setNewRemoteNameForRename(remote);
    setIsRenameRemoteOpen(true);
  }

  const confirmDeleteRemote = (remote: string) => {
    if (!remote) return;
    setRemoteToDelete(remote);
    setIsDeleteRemoteOpen(true);
  }

  const confirmAddRemote = () => {
    setNewRemoteName('origin');
    setNewRemoteUrl('');
    setIsAddRemoteOpen(true);
  }

  const handleRenameBranch = async () => {
    if (!branchToRename || !newBranchNameForRename) return;
    const isSameName = remoteBranchToRename
      ? remoteBranchToRename.branch === newBranchNameForRename
      : branchToRename === newBranchNameForRename;

    if (isSameName) {
      closeRenameBranchDialog();
      return;
    }
    setIsRenaming(true);
    try {
      if (remoteBranchToRename) {
        await runGitAction({
          repoPath,
          action: 'rename-remote-branch',
          data: {
            remote: remoteBranchToRename.remote,
            oldName: remoteBranchToRename.branch,
            newName: newBranchNameForRename,
          }
        });
      } else {
        await runGitAction({
          repoPath,
          action: 'rename-branch',
          data: {
            oldName: branchToRename,
            newName: newBranchNameForRename,
            renameTrackingRemote: renameTrackingRemoteBranch,
          }
        });
      }
      closeRenameBranchDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsRenaming(false);
    }
  }

  const handleRenameRemote = async () => {
    if (!remoteToRename) return;
    const trimmedOldName = remoteToRename.trim();
    const trimmedNewName = newRemoteNameForRename.trim();
    if (!trimmedOldName || !trimmedNewName) return;

    if (trimmedOldName === trimmedNewName) {
      closeRenameRemoteDialog();
      return;
    }

    setIsRenamingRemote(true);
    try {
      await runGitAction({
        repoPath,
        action: 'rename-remote',
        data: {
          oldName: trimmedOldName,
          newName: trimmedNewName,
        },
      });
      closeRenameRemoteDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsRenamingRemote(false);
    }
  }

  const handleDeleteRemote = async () => {
    if (!remoteToDelete) return;
    const trimmedRemoteName = remoteToDelete.trim();
    if (!trimmedRemoteName) return;

    setIsDeletingRemote(true);
    try {
      await runGitAction({
        repoPath,
        action: 'delete-remote',
        data: {
          name: trimmedRemoteName,
        },
      });
      closeDeleteRemoteDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeletingRemote(false);
    }
  }

  const handleAddRemote = async () => {
    const trimmedName = newRemoteName.trim();
    const trimmedUrl = newRemoteUrl.trim();
    if (!trimmedName || !trimmedUrl) return;

    setIsAddingRemote(true);
    try {
      await runGitAction({
        repoPath,
        action: 'add-remote',
        data: {
          name: trimmedName,
          url: trimmedUrl,
        },
      });
      closeAddRemoteDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingRemote(false);
    }
  }

  const confirmRebase = ({ sourceBranch, targetBranch }: BranchOperation) => {
    setRebaseSourceBranch(sourceBranch);
    setRebaseTargetBranch(targetBranch);
    setRebaseStashChanges(true);
    setRebaseConflictStatus('checking');
    setIsRebaseOpen(true);
  }

  const handleRebase = async () => {
    if (!rebaseSourceBranch || !rebaseTargetBranch) return;
    setIsRebasing(true);
    try {
      await runGitAction({
        repoPath,
        action: 'checkout',
        data: { branch: rebaseSourceBranch }
      });

      await runGitAction({
        repoPath,
        action: 'rebase',
        data: { ontoBranch: rebaseTargetBranch, stashChanges: rebaseStashChanges }
      });
      closeRebaseDialog();
    } catch (e) {
      if (isMergeOrRebaseConflictError(e)) {
        closeRebaseDialog();
        openConflictResolver();
        toast({
          type: 'warning',
          title: 'Rebase Conflict Detected',
          description: 'Redirected to the conflict resolver. Resolve conflicted files, then continue or abort.',
          duration: 12000,
        });
      }
      console.error(e);
    } finally {
      setIsRebasing(false);
    }
  }

  useEffect(() => {
    const sourceBranch = rebaseSourceBranch;
    const ontoBranch = rebaseTargetBranch;

    if (!isRebaseOpen || !sourceBranch || !ontoBranch) {
      return;
    }

    let cancelled = false;
    setRebaseConflictStatus('checking');

    const checkRebaseConflicts = async () => {
      try {
        const result = await runGitAction({
          repoPath,
          action: 'check-rebase-conflicts',
          data: {
            sourceBranch,
            ontoBranch,
          },
        });

        if (!cancelled) {
          setRebaseConflictStatus(result.hasConflicts ? 'has-conflicts' : 'no-conflict');
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          // Be conservative when the check cannot be completed.
          setRebaseConflictStatus('has-conflicts');
        }
      }
    };

    void checkRebaseConflicts();

    return () => {
      cancelled = true;
    };
  }, [isRebaseOpen, rebaseSourceBranch, rebaseTargetBranch, repoPath, runGitAction]);

  const confirmMerge = ({ sourceBranch, targetBranch }: BranchOperation) => {
    setMergeTargetBranch(targetBranch);
    setMergeSourceBranch(sourceBranch);
    setMergeRebaseBeforeMerge(false);
    setMergeSquash(false);
    setMergeFastForward(false);
    setMergeSquashMessage('');
    setMergeConflictStatus('checking');
    setIsMergeOpen(true);
  }

  const handleMergeSquashToggle = useCallback((enabled: boolean) => {
    setMergeSquash(enabled);

    if (!enabled) {
      return;
    }

    if (!mergeSourceBranch) {
      setMergeSquashMessage('');
      return;
    }

    void (async () => {
      try {
        const result = await runGitAction({
          repoPath,
          action: 'get-latest-commit-message',
          data: { branch: mergeSourceBranch },
        });
        setMergeSquashMessage(typeof result?.message === 'string' ? result.message : '');
      } catch (e) {
        console.error(e);
        setMergeSquashMessage('');
      }
    })();
  }, [mergeSourceBranch, repoPath, runGitAction]);

  const handleMerge = async () => {
    if (!mergeTargetBranch || !mergeSourceBranch) return;
    setIsMerging(true);
    try {
      await runGitAction({
        repoPath,
        action: 'checkout',
        data: { branch: mergeTargetBranch }
      });

      await runGitAction({
        repoPath,
        action: 'merge',
        data: {
          targetBranch: mergeSourceBranch,
          rebaseBeforeMerge: mergeRebaseBeforeMerge,
          squash: mergeSquash,
          fastForward: mergeFastForward,
          squashMessage: mergeSquash ? mergeSquashMessage : undefined,
        }
      });
      closeMergeDialog();
    } catch (e) {
      if (isMergeOrRebaseConflictError(e)) {
        closeMergeDialog();
        openConflictResolver();
        toast({
          type: 'warning',
          title: 'Merge Conflict Detected',
          description: 'Redirected to the conflict resolver. Resolve conflicted files, then continue or abort.',
          duration: 12000,
        });
      }
      console.error(e);
    } finally {
      setIsMerging(false);
    }
  }

  useEffect(() => {
    const sourceBranch = mergeSourceBranch;
    const targetBranch = mergeTargetBranch;

    if (!isMergeOpen || !sourceBranch || !targetBranch) {
      return;
    }

    let cancelled = false;
    setMergeConflictStatus('checking');

    const checkMergeConflicts = async () => {
      try {
        const result = await runGitAction({
          repoPath,
          action: 'check-merge-conflicts',
          data: {
            sourceBranch,
            targetBranch,
          },
        });

        if (!cancelled) {
          setMergeConflictStatus(result.hasConflicts ? 'has-conflicts' : 'no-conflict');
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          // Be conservative when the check cannot be completed.
          setMergeConflictStatus('has-conflicts');
        }
      }
    };

    void checkMergeConflicts();

    return () => {
      cancelled = true;
    };
  }, [isMergeOpen, mergeSourceBranch, mergeTargetBranch, repoPath, runGitAction]);

  const confirmPushToRemote = async (branch: string) => {
    setPushBranch(branch);
    setPushError(null);
    setPushRemotes([]);
    setPushRemoteBranches([]);
    setPushSelectedRemote('');
    setPushSelectedRemoteBranch('');
    setPushTrackingBranch(null);
    setPushRebaseFirst(false);
    setPushForcePush(false);
    setPushLocalOnlyTags(true);
    setPushSquash(false);
    setPushSquashMessage('');
    setIsPushOpen(true);
    
    // Load remotes
    setPushLoadingRemotes(true);
    try {
      const result = await runGitAction({
        repoPath,
        action: 'get-remotes',
        data: {}
      });
      
      if (!result.remotes || result.remotes.length === 0) {
        setPushError('No remote repository configured. Please add a remote first.');
        setPushLoadingRemotes(false);
        return;
      }
      
      setPushRemotes(result.remotes);
      
      // Get tracking branch info
      const trackingResult = await runGitAction({
        repoPath,
        action: 'get-tracking-branch',
        data: { branch }
      });
      
      setPushTrackingBranch(trackingResult.tracking);
      
      // Set default remote - use tracking remote if available and exists in remotes list, otherwise first remote
      const trackingRemote = trackingResult.tracking?.remote;
      const defaultRemote = (trackingRemote && result.remotes.includes(trackingRemote)) 
        ? trackingRemote 
        : result.remotes[0];
      setPushSelectedRemote(defaultRemote);
      
      // Load branches for the default remote
      setPushLoadingBranches(true);
      const branchesResult = await runGitAction({
        repoPath,
        action: 'get-remote-branches',
        data: { remote: defaultRemote }
      });
      
      setPushRemoteBranches(branchesResult.branches || []);
      
      // Set default remote branch - use tracking branch if on same remote, otherwise use branch name
      if (trackingResult.tracking?.remote === defaultRemote && trackingResult.tracking?.branch) {
        setPushSelectedRemoteBranch(trackingResult.tracking.branch);
      } else {
        // Default to same name as local branch, or first branch if local branch name doesn't exist
        const localBranchName = branch;
        if (branchesResult.branches?.includes(localBranchName)) {
          setPushSelectedRemoteBranch(localBranchName);
        } else {
          // Will create new branch with local branch name
          setPushSelectedRemoteBranch(localBranchName);
        }
      }
    } catch (e) {
      console.error(e);
      setPushError((e as Error).message || 'Failed to load remote information');
    } finally {
      setPushLoadingRemotes(false);
      setPushLoadingBranches(false);
    }
  }

  const handlePushRemoteChange = async (remote: string) => {
    setPushSelectedRemote(remote);
    setPushLoadingBranches(true);
    setPushRemoteBranches([]);
    
    try {
      const branchesResult = await runGitAction({
        repoPath,
        action: 'get-remote-branches',
        data: { remote }
      });
      
      setPushRemoteBranches(branchesResult.branches || []);
      
      // Set default branch - tracking branch if on this remote, otherwise local branch name
      if (pushTrackingBranch?.remote === remote && pushTrackingBranch?.branch) {
        setPushSelectedRemoteBranch(pushTrackingBranch.branch);
      } else {
        setPushSelectedRemoteBranch(pushBranch || '');
      }
    } catch (e) {
      console.error(e);
      setPushError((e as Error).message || 'Failed to load remote branches');
    } finally {
      setPushLoadingBranches(false);
    }
  }

  const handlePushSquashToggle = useCallback((enabled: boolean) => {
    setPushSquash(enabled);

    if (!enabled) {
      return;
    }

    if (!pushBranch) {
      setPushSquashMessage('');
      return;
    }

    void (async () => {
      try {
        const result = await runGitAction({
          repoPath,
          action: 'get-latest-commit-message',
          data: { branch: pushBranch },
        });
        setPushSquashMessage(typeof result?.message === 'string' ? result.message : '');
      } catch (e) {
        console.error(e);
        setPushSquashMessage('');
      }
    })();
  }, [pushBranch, repoPath, runGitAction]);

  const handlePushToRemote = async () => {
    if (!pushBranch || !pushSelectedRemote || !pushSelectedRemoteBranch) return;
    
    setIsPushing(true);
    setPushError(null);
    
    try {
      // Determine if we need to set upstream
      const isNewBranch = !pushRemoteBranches.includes(pushSelectedRemoteBranch);
      const needsSetUpstream = isNewBranch || 
        pushTrackingBranch?.remote !== pushSelectedRemote || 
        pushTrackingBranch?.branch !== pushSelectedRemoteBranch;
      
      await runGitAction({
        repoPath,
        action: 'push-to-remote',
        data: {
          localBranch: pushBranch,
          remote: pushSelectedRemote,
          remoteBranch: pushSelectedRemoteBranch,
          rebaseFirst: pushForcePush ? false : pushRebaseFirst,
          forcePush: pushForcePush,
          pushLocalOnlyTags,
          setUpstream: needsSetUpstream,
          squash: pushSquash,
          squashMessage: pushSquashMessage,
        }
      });
      
      // Fetch from the remote we just pushed to
      await runGitAction({
        repoPath,
        action: 'fetch',
        data: { remote: pushSelectedRemote }
      });
      
      setIsPushOpen(false);
      setPushBranch(null);
    } catch (e) {
      console.error(e);
      setPushError((e as Error).message || 'Failed to push to remote');
    } finally {
      setIsPushing(false);
    }
  }

  const confirmPullFromRemote = async (branch: string) => {
    setPullBranch(branch);
    setPullError(null);
    setPullRemotes([]);
    setPullRemoteBranches([]);
    setPullSelectedRemote('');
    setPullSelectedRemoteBranch('');
    setPullTrackingBranch(null);
    setPullRebase(true);
    setIsPullOpen(true);
    
    // Load remotes
    setPullLoadingRemotes(true);
    try {
      const result = await runGitAction({
        repoPath,
        action: 'get-remotes',
        data: {}
      });
      
      if (!result.remotes || result.remotes.length === 0) {
        setPullError('No remote repository configured. Please add a remote first.');
        setPullLoadingRemotes(false);
        return;
      }
      
      setPullRemotes(result.remotes);
      
      // Get tracking branch info
      const trackingResult = await runGitAction({
        repoPath,
        action: 'get-tracking-branch',
        data: { branch }
      });
      
      setPullTrackingBranch(trackingResult.tracking);
      
      // Set default remote - use tracking remote if available and exists in remotes list, otherwise first remote
      const trackingRemote = trackingResult.tracking?.remote;
      const defaultRemote = (trackingRemote && result.remotes.includes(trackingRemote)) 
        ? trackingRemote 
        : result.remotes[0];
      setPullSelectedRemote(defaultRemote);
      
      // Load branches for the default remote
      setPullLoadingBranches(true);
      const branchesResult = await runGitAction({
        repoPath,
        action: 'get-remote-branches',
        data: { remote: defaultRemote }
      });
      
      setPullRemoteBranches(branchesResult.branches || []);
      
      // Set default remote branch - use tracking branch if on same remote
      if (trackingResult.tracking?.remote === defaultRemote && trackingResult.tracking?.branch) {
        setPullSelectedRemoteBranch(trackingResult.tracking.branch);
      } else {
        // No tracking branch on this remote - leave empty to show error
        setPullSelectedRemoteBranch('');
      }
    } catch (e) {
      console.error(e);
      setPullError((e as Error).message || 'Failed to load remote information');
    } finally {
      setPullLoadingRemotes(false);
      setPullLoadingBranches(false);
    }
  }

  const handlePullRemoteChange = async (remote: string) => {
    setPullSelectedRemote(remote);
    setPullLoadingBranches(true);
    setPullRemoteBranches([]);
    setPullSelectedRemoteBranch('');
    
    try {
      const branchesResult = await runGitAction({
        repoPath,
        action: 'get-remote-branches',
        data: { remote }
      });
      
      setPullRemoteBranches(branchesResult.branches || []);
      
      // Set default branch - tracking branch if on this remote
      if (pullTrackingBranch?.remote === remote && pullTrackingBranch?.branch) {
        setPullSelectedRemoteBranch(pullTrackingBranch.branch);
      } else {
        // No tracking branch on this remote - leave empty
        setPullSelectedRemoteBranch('');
      }
    } catch (e) {
      console.error(e);
      setPullError((e as Error).message || 'Failed to load remote branches');
    } finally {
      setPullLoadingBranches(false);
    }
  }

  const handlePullFromRemote = async () => {
    if (!pullBranch || !pullSelectedRemote || !pullSelectedRemoteBranch) return;
    
    setIsPulling(true);
    setPullError(null);
    
    try {
      await runGitAction({
        repoPath,
        action: 'pull-from-remote',
        data: {
          localBranch: pullBranch,
          remote: pullSelectedRemote,
          remoteBranch: pullSelectedRemoteBranch,
          rebase: pullRebase,
        }
      });
      
      setIsPullOpen(false);
      setPullBranch(null);
    } catch (e) {
      console.error(e);
      setPullError((e as Error).message || 'Failed to pull from remote');
    } finally {
      setIsPulling(false);
    }
  }

  const confirmCheckoutToLocal = (remoteBranch: string) => {
    setCheckoutRemoteBranch(remoteBranch);
    // Extract the branch name from remotes/origin/branch-name
    const parts = remoteBranch.split('/');
    // Skip 'remotes' and remote name (e.g., 'origin'), take the rest as branch name
    const branchName = parts.slice(2).join('/');
    setCheckoutLocalBranchName(branchName);
    setIsCheckoutToLocalOpen(true);
  }

  const targetBranchDisplayName = useMemo(() => {
    if (!pendingBranchSwitch) return '';
    if (pendingBranchSwitch.type === 'local') {
      return pendingBranchSwitch.branch;
    }
    return pendingBranchSwitch.localBranch;
  }, [pendingBranchSwitch]);

  const handleCheckoutToLocal = async () => {
    if (!checkoutRemoteBranch || !checkoutLocalBranchName) return;

    if (hasLocalChanges) {
      const remoteBranch = checkoutRemoteBranch;
      const localBranch = checkoutLocalBranchName;
      setIsCheckoutToLocalOpen(false);
      setPendingBranchSwitch({ type: 'remote', remoteBranch, localBranch });
      setSwitchBranchStrategy('stash-and-reapply');
      setIsSwitchBranchModalOpen(true);
      return;
    }

    setIsCheckingOutToLocal(true);
    try {
      await runGitAction({
        repoPath,
        action: 'checkout-to-local',
        data: { remoteBranch: checkoutRemoteBranch, localBranch: checkoutLocalBranchName }
      });
      setIsCheckoutToLocalOpen(false);
      setCheckoutRemoteBranch(null);
      setCheckoutLocalBranchName('');
    } catch (e) {
      console.error(e);
    } finally {
      setIsCheckingOutToLocal(false);
    }
  }

  const handleFetchFromAllRemotes = async () => {
    setIsFetchingAllRemotes(true);
    try {
      await runGitAction({
        repoPath,
        action: 'fetch',
        data: { allRemotes: true }
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsFetchingAllRemotes(false);
    }
  }

  const handleOpenRepoFolder = useCallback(async () => {
    if (isOpeningRepoFolder) return;

    setIsOpeningRepoFolder(true);
    try {
      const response = await fetch('/api/fs/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || 'Failed to open repository folder');
      }
    } catch (error) {
      toast({
        type: 'error',
        title: 'Failed to Open Repo Folder',
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsOpeningRepoFolder(false);
    }
  }, [isOpeningRepoFolder, repoPath]);

  const handleOpenRepoTerminal = useCallback(async () => {
    if (isOpeningRepoTerminal) return;

    setIsOpeningRepoTerminal(true);
    try {
      const response = await fetch('/api/fs/open-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || 'Failed to open terminal');
      }
    } catch (error) {
      toast({
        type: 'error',
        title: 'Failed to Open Terminal',
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsOpeningRepoTerminal(false);
    }
  }, [isOpeningRepoTerminal, repoPath]);

  const handleOpenWorktreeInNewTab = useCallback((worktreePath: string, isCurrentWorktree: boolean) => {
    if (isCurrentWorktree) return;

    let origin = window.location.origin;
    try {
      if (window.top?.location?.origin) {
        origin = window.top.location.origin;
      }
    } catch {
      // Ignore cross-origin access errors and keep current window origin.
    }

    const targetUrl = `${origin}/workspace?path=${encodeURIComponent(worktreePath)}`;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }, []);

  const handleFetchFromRemote = async (remote: string) => {
    try {
      await runGitAction({
        repoPath,
        action: 'fetch',
        data: { remote }
      });
    } catch (e) {
      console.error(e);
    }
  }

  const handleCheckout = async (branchName: string) => {
    if (branchName === currentBranch) return;

    if (hasLocalChanges) {
      setPendingBranchSwitch({ type: 'local', branch: branchName });
      setSwitchBranchStrategy('stash-and-reapply');
      setIsSwitchBranchModalOpen(true);
      return;
    }

    try {
      await runGitAction({
        repoPath,
        action: 'checkout',
        data: { branch: branchName }
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleConfirmSwitchBranch = async () => {
    if (!pendingBranchSwitch) return;
    setIsSwitchingBranch(true);
    try {
      if (pendingBranchSwitch.type === 'local') {
        await runGitAction({
          repoPath,
          action: 'checkout',
          data: {
            branch: pendingBranchSwitch.branch,
            switchStrategy: switchBranchStrategy,
          },
        });
      } else {
        await runGitAction({
          repoPath,
          action: 'checkout-to-local',
          data: {
            remoteBranch: pendingBranchSwitch.remoteBranch,
            localBranch: pendingBranchSwitch.localBranch,
            switchStrategy: switchBranchStrategy,
          },
        });
        setCheckoutRemoteBranch(null);
        setCheckoutLocalBranchName('');
      }
      setIsSwitchBranchModalOpen(false);
      setPendingBranchSwitch(null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSwitchingBranch(false);
    }
  };

  const handleResetToCommit = async (commitHash: string) => {
    setResetCommitHash(commitHash);
    setIsResetOpen(true);
  };

  const handleConfirmReset = async () => {
    if (!resetCommitHash) return;
    setIsResetting(true);
    try {
      await runGitAction({
        repoPath,
        action: 'reset',
        data: { commitHash: resetCommitHash, mode: 'hard' }
      });
      setIsResetOpen(false);
      setResetCommitHash(null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsResetting(false);
    }
  };

  const confirmRevertCommit = (commitHash: string, commitMessage: string) => {
    setCommitToRevert({ hash: commitHash, message: commitMessage });
    setIsRevertOpen(true);
  };

  const handleConfirmRevert = async () => {
    if (!commitToRevert) return;
    setIsReverting(true);
    try {
      await runGitAction({
        repoPath,
        action: 'revert',
        data: { commitHash: commitToRevert.hash }
      });
      setIsRevertOpen(false);
      setCommitToRevert(null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsReverting(false);
    }
  };

  const confirmRewordCommit = (hash: string, subject: string, body: string, branch: string) => {
    setCommitToReword({ hash, subject, body, branch });
    setNewMessageSubject(subject);
    setNewMessageBody(body);
    setIsRewordOpen(true);
  };

  const handleReword = async () => {
    if (!commitToReword || !newMessageSubject.trim()) return;
    setIsRewording(true);
    try {
      await runGitAction({
        repoPath,
        action: 'reword',
        data: {
          commitHash: commitToReword.hash,
          message: buildCommitMessage(newMessageSubject, newMessageBody),
          branch: commitToReword.branch,
        }
      });
      closeRewordDialog();
    } catch (e) {
      console.error(e);
    } finally {
      setIsRewording(false);
    }
  };

  const confirmCherryPickCommit = (commitHash: string, commitMessage: string) => {
    setCommitsToCherryPick([{ hash: commitHash, message: commitMessage }]);
    setIsCherryPickOpen(true);
  };

  const confirmCherryPickSelectedCommits = () => {
    if (selectedCommitsForCherryPick.length < 2) return;
    setCommitsToCherryPick(selectedCommitsForCherryPick.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
    })));
    setIsCherryPickOpen(true);
  };

  const isCherryPickAlreadyInProgressError = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('cherry-pick') && message.includes('already in progress');
  };

  const isCherryPickConflictError = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes('could not apply') ||
      message.includes('conflict') ||
      message.includes('cherry-pick --continue')
    );
  };

  const runCherryPickByHashes = useCallback(async (commitHashes: string[]) => {
    if (commitHashes.length === 1) {
      await runGitAction({
        repoPath,
        action: 'cherry-pick',
        data: { commitHash: commitHashes[0] }
      });
      return;
    }

    await runGitAction({
      repoPath,
      action: 'cherry-pick-multiple',
      data: { commitHashes }
    });
  }, [repoPath, runGitAction]);

  const abortCherryPickAndResetUi = useCallback(async () => {
    try {
      await runGitAction({
        repoPath,
        action: 'cherry-pick-abort',
      });
    } catch (abortError) {
      console.error(abortError);
    } finally {
      setIsCherryPickOpen(false);
      setIsAbortCherryPickOpen(false);
      setCommitsToCherryPick([]);
    }
  }, [repoPath, runGitAction]);

  const handleCherryPickCommit = async () => {
    if (commitsToCherryPick.length === 0) return;
    setIsCherryPicking(true);
    try {
      const commitHashes = commitsToCherryPick.map((commit) => commit.hash);
      await runCherryPickByHashes(commitHashes);
      setIsCherryPickOpen(false);
      setCommitsToCherryPick([]);
    } catch (e) {
      if (isCherryPickAlreadyInProgressError(e)) {
        setIsCherryPickOpen(false);
        setIsAbortCherryPickOpen(true);
      } else if (isCherryPickConflictError(e)) {
        await abortCherryPickAndResetUi();
      }
      console.error(e);
    } finally {
      setIsCherryPicking(false);
    }
  };

  const handleAbortCherryPick = async () => {
    if (commitsToCherryPick.length === 0) {
      setIsAbortCherryPickOpen(false);
      return;
    }

    setIsAbortingCherryPick(true);
    try {
      await runGitAction({
        repoPath,
        action: 'cherry-pick-abort',
      });

      const commitHashes = commitsToCherryPick.map((commit) => commit.hash);
      await runCherryPickByHashes(commitHashes);

      setIsAbortCherryPickOpen(false);
      setCommitsToCherryPick([]);
    } catch (e) {
      if (isCherryPickAlreadyInProgressError(e)) {
        setIsAbortCherryPickOpen(true);
      } else if (isCherryPickConflictError(e)) {
        await abortCherryPickAndResetUi();
      }
      console.error(e);
    } finally {
      setIsAbortingCherryPick(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName) return;
    setIsCreating(true);
    try {
      await runGitAction({
        repoPath,
        action: 'branch',
        data: { branch: newBranchName, fromRef: createBranchFromRef || undefined }
      });
      setIsCreateBranchOpen(false);
      setNewBranchName('');
      setCreateBranchFromRef(null);
    } catch (e) {
      console.error(e);
      // alert or toast error
    } finally {
      setIsCreating(false);
    }
  };

  const confirmCreateBranch = (sourceBranch?: string) => {
    setCreateBranchFromRef(sourceBranch || null);
    setIsCreateBranchOpen(true);
  };

  const confirmCreateTag = (commitHash: string) => {
    setCreateTagCommitHash(commitHash);
    setNewTagName('');
    setPushTagToRemote(false);
    setIsCreateTagOpen(true);
  };

  const handleCreateTag = async () => {
    if (!createTagCommitHash || !newTagName.trim()) return;
    setIsCreatingTag(true);
    try {
      await runGitAction({
        repoPath,
        action: 'create-tag',
        data: {
          tagName: newTagName.trim(),
          commitHash: createTagCommitHash,
          pushToRemote: pushTagToRemote,
        }
      });
      setIsCreateTagOpen(false);
      setCreateTagCommitHash(null);
      setNewTagName('');
      setPushTagToRemote(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreatingTag(false);
    }
  };

  const trackingInfoByBranch = branchData?.trackingInfo;
  const remoteNames = useMemo(() => {
    const names = Object.keys(branchData?.remoteUrls ?? {});
    return names.sort((a, b) => {
      if (a === 'origin') return -1;
      if (b === 'origin') return 1;
      return a.localeCompare(b);
    });
  }, [branchData?.remoteUrls]);
  const remoteNameForTagDelete = remoteNames[0] || null;
  const selectedTrackingUpstreams = useMemo(() => {
    const upstreams: string[] = [];
    for (const branchRef of branchesToDelete) {
      if (branchRef.startsWith('remotes/')) continue;
      const upstream = trackingInfoByBranch?.[branchRef]?.upstream;
      if (upstream) upstreams.push(upstream);
    }
    return Array.from(new Set(upstreams));
  }, [branchesToDelete, trackingInfoByBranch]);
  const trackingInfoForRename = useMemo(() => {
    if (!branchToRename || remoteBranchToRename) return null;
    return trackingInfoByBranch?.[branchToRename] ?? null;
  }, [branchToRename, remoteBranchToRename, trackingInfoByBranch]);
  const localChangesCount = statusData?.files?.length;
  const currentBranchName = currentBranch || (isBranchesLoading ? 'Loading branches...' : 'Detached HEAD');
  const currentBranchLabel = currentBranch && typeof localChangesCount === 'number' && localChangesCount > 0
    ? `${currentBranch} (${localChangesCount})`
    : currentBranchName;
  const currentTrackingBranch = useMemo(() => {
    if (!currentBranch) return null;
    const tracking = trackingInfoByBranch?.[currentBranch];
    if (!tracking?.upstream) return null;
    const parsed = parseTrackingUpstream(tracking.upstream);
    if (!parsed) return null;

    return { upstream: tracking.upstream, ...parsed };
  }, [currentBranch, trackingInfoByBranch]);
  const pullAllTargets = useMemo(() => {
    const targets: Array<{ localBranch: string; remote: string; remoteBranch: string }> = [];
    for (const localBranch of branchData?.branches ?? []) {
      const upstream = trackingInfoByBranch?.[localBranch]?.upstream;
      if (!upstream) continue;
      const parsed = parseTrackingUpstream(upstream);
      if (!parsed) continue;
      targets.push({
        localBranch,
        remote: parsed.remote,
        remoteBranch: parsed.branch,
      });
    }
    return targets;
  }, [branchData?.branches, trackingInfoByBranch]);
  const pullActionDisabledReason = useMemo(() => {
    if (isBranchesLoading) return 'Loading branches...';
    if (!currentBranch) return 'Not on a local branch';
    if (!currentTrackingBranch) return `Branch "${currentBranch}" has no tracking remote branch`;
    return null;
  }, [currentBranch, currentTrackingBranch, isBranchesLoading]);
  const pullAllActionDisabledReason = useMemo(() => {
    if (isBranchesLoading) return 'Loading branches...';
    if (pullAllTargets.length === 0) return 'No local branches with tracking remote branches';
    return null;
  }, [isBranchesLoading, pullAllTargets.length]);
  const pushActionDisabledReason = useMemo(() => {
    if (isBranchesLoading) return 'Loading branches...';
    if (!currentBranch) return 'Not on a local branch';
    return null;
  }, [currentBranch, isBranchesLoading]);

  const confirmPullCurrentBranch = () => {
    if (!currentBranch || pullActionDisabledReason) return;
    void confirmPullFromRemote(currentBranch);
  };

  const confirmPushCurrentBranch = () => {
    if (!currentBranch || pushActionDisabledReason) return;
    void confirmPushToRemote(currentBranch);
  };

  const handlePullAllBranches = async () => {
    if (isPullingAllBranches || pullAllTargets.length === 0) return;

    setIsPullingAllBranches(true);
    const pulledBranches: string[] = [];

    try {
      for (const target of pullAllTargets) {
        try {
          await runGitAction({
            repoPath,
            action: 'pull-from-remote',
            data: {
              localBranch: target.localBranch,
              remote: target.remote,
              remoteBranch: target.remoteBranch,
              rebase: true,
            },
            suppressErrorToast: true,
          });
          pulledBranches.push(target.localBranch);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const pulledSummary = pulledBranches.length > 0
            ? `Pulled ${pulledBranches.length} branch${pulledBranches.length === 1 ? '' : 'es'} before failure.`
            : 'No branches were updated.';

          toast({
            type: 'error',
            title: `Pull All Failed on "${target.localBranch}"`,
            description: `${errorMessage} ${pulledSummary}`,
            duration: 12000,
          });
          return;
        }
      }

      toast({
        type: 'success',
        title: pulledBranches.length === 1 ? 'Pulled 1 Branch' : `Pulled ${pulledBranches.length} Branches`,
        description: 'Updated all local branches that have tracking remote branches.',
      });
    } finally {
      setIsPullingAllBranches(false);
    }
  };

  const getBranchContextMenuItems = (options: BranchMenuOptions): ContextMenuItem[] => {
    const menuItems = buildBranchContextMenuItems(options, {
      onCheckout: handleCheckout,
      onCheckoutToLocal: confirmCheckoutToLocal,
      onCreateBranch: confirmCreateBranch,
      onDeleteBranch: confirmDeleteBranch,
      onDeleteBranches: confirmDeleteBranches,
      onRenameBranch: confirmRenameBranch,
      onRenameRemoteBranch: confirmRenameRemoteBranch,
      onRebase: confirmRebase,
      onMerge: confirmMerge,
      onPushToRemote: confirmPushToRemote,
      onPullFromRemote: confirmPullFromRemote,
    });

    if (customBranchScripts.length > 0) {
      menuItems.push({
        label: 'Custom scripts',
        icon: <i className="iconoir-terminal text-[14px]" aria-hidden="true" />,
        children: customBranchScripts.map((script) => ({
          label: script.name,
          icon: <i className="iconoir-play text-[14px]" aria-hidden="true" />,
          onClick: () => {
            void handleRunCustomScript(script, options.branchRef);
          },
        })),
      });
    }

    return menuItems;
  };

  const localBranchSet = useMemo(() => {
    return new Set(branchData?.branches ?? []);
  }, [branchData?.branches]);

  const remoteBranchMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!branchData?.remotes) return map;

    for (const [remoteName, branches] of Object.entries(branchData.remotes)) {
      for (const branch of branches) {
        map.set(`${remoteName}/${branch}`, `remotes/${remoteName}/${branch}`);
      }
    }

    return map;
  }, [branchData?.remotes]);

  const getBranchTagContextMenuItems = (displayRef: string): ContextMenuItem[] | null => {
    if (displayRef.startsWith('tag:')) {
      const tagName = displayRef.replace(/^tag:\s*/, '').trim();
      if (!tagName) return null;
      return [
        {
          label: 'Delete Tag',
          icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
          onClick: () => confirmDeleteTag(tagName),
          danger: true,
        },
      ];
    }

    if (localBranchSet.has(displayRef)) {
      return getBranchContextMenuItems({
        branchRef: displayRef,
        branchLeafName: displayRef.split('/').pop() || displayRef,
        currentBranch,
        isRemote: false,
      });
    }

    const remoteBranchRef = remoteBranchMap.get(displayRef);
    if (!remoteBranchRef) return null;

    return getBranchContextMenuItems({
      branchRef: remoteBranchRef,
      branchLeafName: remoteBranchRef.split('/').pop() || displayRef,
      currentBranch,
      isRemote: true,
    });
  };
  const localGroupBranchRefs = useMemo(() => {
    if (!localBranchTree) return [];
    return collectAllBranchRefs(localBranchTree).filter((branchRef) => branchRef !== currentBranch);
  }, [localBranchTree, currentBranch]);
  const worktrees = branchData?.worktrees ?? [];

  const branchTreePopoverContent = (
    <div className="w-[22rem] max-w-[calc(100vw-2rem)] flex flex-col border border-base-300 bg-base-100 rounded-box shadow-xl overflow-hidden">
      <div className="px-4 border-b border-base-300 flex items-center justify-between bg-base-100 h-[57px] shrink-0">
        <h2 className="font-bold text-lg">Branches</h2>
        <div className="flex items-center gap-1">
          {hasVisibilityFilters && (
            <div className="tooltip tooltip-left z-20" data-tip="Clear filters">
              <button
                className="btn btn-ghost btn-xs btn-square"
                onClick={handleClearAllFilters}
              >
                <i className="iconoir-filter text-[16px]" aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="tooltip tooltip-left z-20" data-tip="Create Branch">
            <button className="btn btn-ghost btn-xs btn-square" onClick={() => confirmCreateBranch()}>
              <i className="iconoir-plus-circle text-[16px]" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <div className="p-2 space-y-0.5">
          {localBranchTree && (
            <>
              <ContextMenu
                items={[
                  {
                    label: 'Delete',
                    icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
                    onClick: () => confirmDeleteBranches(localGroupBranchRefs),
                    danger: true,
                    disabled: localGroupBranchRefs.length === 0,
                  },
                ]}
              >
                <GroupHeader
                  name="Branches"
                  groupPath="__local__"
                  icon={<i className="iconoir-git-branch text-[14px]" aria-hidden="true" />}
                  isExpanded={localGroupExpanded}
                  onToggle={handleToggleLocalGroup}
                  visibilityMap={visibilityMap}
                  onToggleVisibility={handleToggleVisibility}
                />
              </ContextMenu>
              {localGroupExpanded && (
                <BranchTreeItem
                  node={localBranchTree}
                  currentBranch={branchData?.current}
                  expandedFolders={expandedFolders}
                  onToggleFolder={toggleFolder}
                  onCheckout={handleCheckout}
                  onCheckoutToLocal={confirmCheckoutToLocal}
                  onCreateBranch={() => confirmCreateBranch()}
                  onDeleteBranch={confirmDeleteBranch}
                  onRenameBranch={confirmRenameBranch}
                  onRenameRemoteBranch={confirmRenameRemoteBranch}
                  onRebase={confirmRebase}
                  onMerge={confirmMerge}
                  onPushToRemote={confirmPushToRemote}
                  onPullFromRemote={confirmPullFromRemote}
                  getBranchContextMenuItems={getBranchContextMenuItems}
                  onBranchClick={handleBranchClick}
                  onBranchContextMenu={handleBranchContextMenu}
                  onDeleteBranchGroup={confirmDeleteBranches}
                  selectedBranches={selectedBranchSet}
                  visibilityMap={visibilityMap}
                  onToggleVisibility={handleToggleVisibility}
                  depth={1}
                  groupPath="__local__"
                  trackingInfo={branchData?.trackingInfo}
                />
              )}
            </>
          )}

          <>
            <ContextMenu
              items={[
                {
                  label: 'Fetch from all remotes',
                  icon: <i className="iconoir-refresh-circle text-[14px]" aria-hidden="true" />,
                  onClick: handleFetchFromAllRemotes,
                },
                {
                  label: 'Add remote',
                  icon: <i className="iconoir-plus-circle text-[14px]" aria-hidden="true" />,
                  onClick: confirmAddRemote,
                },
              ]}
            >
              <GroupHeader
                name="Remotes"
                groupPath="__remotes__"
                icon={<i className="iconoir-globe text-[14px]" aria-hidden="true" />}
                isExpanded={remotesGroupExpanded}
                onToggle={handleToggleRemotesGroup}
                visibilityMap={visibilityMap}
                onToggleVisibility={handleToggleVisibility}
              />
            </ContextMenu>
            {remotesGroupExpanded && isBranchesLoading && !remoteBranchTrees && (
              <div className="flex items-center gap-2 px-2 py-2 text-sm opacity-70" style={{ paddingLeft: '20px' }}>
                <span className="loading loading-spinner loading-xs"></span>
                <span>Loading remotes...</span>
              </div>
            )}
            {remotesGroupExpanded && remoteBranchTrees && Array.from(remoteBranchTrees.entries()).map(([remoteName, tree]) => {
              const remoteGroupPath = `__remotes__/${remoteName}`;
              const isRemoteExpanded = expandedFolders.has(remoteGroupPath);

              return (
                <div key={remoteName}>
                  <ContextMenu
                    items={[
                      {
                        label: `Fetch from ${remoteName}`,
                        icon: <i className="iconoir-refresh-circle text-[14px]" aria-hidden="true" />,
                        onClick: () => handleFetchFromRemote(remoteName),
                      },
                      {
                        label: 'Rename',
                        icon: <i className="iconoir-edit-pencil text-[14px]" aria-hidden="true" />,
                        onClick: () => confirmRenameRemote(remoteName),
                      },
                      {
                        label: 'Delete',
                        icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
                        onClick: () => confirmDeleteRemote(remoteName),
                        danger: true,
                      },
                    ]}
                  >
                    <GroupHeader
                      name={remoteName}
                      groupPath={remoteGroupPath}
                      icon={<i className="iconoir-globe text-[14px] opacity-50" aria-hidden="true" />}
                      isExpanded={isRemoteExpanded}
                      onToggle={() => toggleFolder(remoteGroupPath)}
                      visibilityMap={visibilityMap}
                      onToggleVisibility={handleToggleVisibility}
                      depth={1}
                    />
                  </ContextMenu>
                  {isRemoteExpanded && (
                    <BranchTreeItem
                      node={tree}
                      currentBranch={branchData?.current}
                      expandedFolders={expandedFolders}
                      onToggleFolder={toggleFolder}
                      onCheckout={handleCheckout}
                      onCheckoutToLocal={confirmCheckoutToLocal}
                      onCreateBranch={() => confirmCreateBranch()}
                      onDeleteBranch={confirmDeleteBranch}
                      onRenameBranch={confirmRenameBranch}
                      onRenameRemoteBranch={confirmRenameRemoteBranch}
                      onRebase={confirmRebase}
                      onMerge={confirmMerge}
                      onPushToRemote={confirmPushToRemote}
                      onPullFromRemote={confirmPullFromRemote}
                      getBranchContextMenuItems={getBranchContextMenuItems}
                      onBranchClick={handleBranchClick}
                      onBranchContextMenu={handleBranchContextMenu}
                      onDeleteBranchGroup={confirmDeleteBranches}
                      selectedBranches={selectedBranchSet}
                      visibilityMap={visibilityMap}
                      onToggleVisibility={handleToggleVisibility}
                      depth={2}
                      groupPath={remoteGroupPath}
                      isRemote={true}
                      trackingInfo={branchData?.trackingInfo}
                    />
                  )}
                </div>
              );
            })}
          </>

          <>
            <div
              className="group flex items-center gap-1 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-base-200 transition-colors font-medium"
              onClick={handleToggleWorktreesGroup}
            >
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <span className="text-xs opacity-70">{worktreesGroupExpanded ? '▼' : '▶'}</span>
                <i className="iconoir-folder text-[14px]" aria-hidden="true" />
                <span className="truncate min-w-0 flex-1">Worktrees</span>
              </div>
              <span className="text-xs opacity-60">{worktrees.length}</span>
            </div>
            {worktreesGroupExpanded && isBranchesLoading && worktrees.length === 0 && (
              <div className="flex items-center gap-2 px-2 py-2 text-sm opacity-70" style={{ paddingLeft: '20px' }}>
                <span className="loading loading-spinner loading-xs"></span>
                <span>Loading worktrees...</span>
              </div>
            )}
            {worktreesGroupExpanded && !isBranchesLoading && worktrees.length === 0 && (
              <div className="px-2 py-2 text-sm opacity-70" style={{ paddingLeft: '20px' }}>
                No worktrees found
              </div>
            )}
            {worktreesGroupExpanded && worktrees.map((worktree) => {
              const row = (
                <button
                  type="button"
                  className={cn(
                    "group flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors text-left",
                    worktree.isCurrent ? "cursor-default opacity-85" : "cursor-pointer hover:bg-base-200"
                  )}
                  style={{ paddingLeft: '20px' }}
                  onClick={() => handleOpenWorktreeInNewTab(worktree.path, worktree.isCurrent)}
                  title={worktree.path}
                  disabled={worktree.isCurrent}
                >
                  <i className={`iconoir-folder text-[14px] shrink-0 ${worktree.isCurrent ? 'text-primary' : 'opacity-60'}`} aria-hidden="true" />
                  <span className="truncate min-w-0 flex-1">{worktree.path}</span>
                  {worktree.branch && (
                    <span className="shrink-0 text-xs opacity-60">
                      {worktree.branch}
                    </span>
                  )}
                  {worktree.isCurrent && (
                    <span className="shrink-0 text-xs text-primary font-medium">
                      current
                    </span>
                  )}
                </button>
              );

              if (worktree.isCurrent) {
                return <div key={worktree.path}>{row}</div>;
              }

              return (
                <ContextMenu
                  key={worktree.path}
                  items={[{
                    label: 'Delete worktree',
                    icon: <i className="iconoir-trash text-[14px]" aria-hidden="true" />,
                    onClick: () => confirmDeleteWorktree(worktree.path),
                    danger: true,
                  }]}
                >
                  {row}
                </ContextMenu>
              );
            })}
          </>
        </div>
      </div>
    </div>
  );

  if (isLoading && limit === 100) {
    return <div className="flex items-center justify-center p-8 h-full"><span className="loading loading-spinner text-base-content/50"></span></div>;
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center p-8 h-full flex-col gap-4">
        <p className="text-error font-medium">Error Loading History</p>
        <p className="text-sm opacity-70">{(error as Error)?.message || 'An unknown error occurred'}</p>
        <button onClick={() => void refetchLog()} className="btn btn-outline btn-sm">
            <i className="iconoir-refresh-circle text-[16px] mr-1" aria-hidden="true" />
            Try Again
        </button>
      </div>
    );
  }

  if (!log) return <div className="flex items-center justify-center p-8 h-full opacity-70">No history data available</div>;

  return (
    <div className="flex h-full overflow-hidden">
      {isResetOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Reset to Commit</h3>
            <p className="py-4 break-words">
              Are you sure you want to hard reset branch <span className="font-bold break-all">{branchData?.current || 'Detached HEAD'}</span> to commit <span className="font-mono bg-base-200 px-1 rounded">{resetCommitHash?.substring(0, 7)}</span>?
              <br/>
              <span className="text-error font-bold">Warning: This will discard all local changes and commits after this point. This action cannot be undone.</span>
            </p>
            <div className="modal-action">
              <button className="btn" onClick={() => setIsResetOpen(false)} disabled={isResetting}>Cancel</button>
              <button className="btn btn-error" onClick={handleConfirmReset} disabled={isResetting}>
                {isResetting && <span className="loading loading-spinner loading-xs"></span>}
                Reset
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setIsResetOpen(false)}>close</button>
          </form>
        </dialog>
      )}

      {isRevertOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Revert Commit</h3>
            <p className="py-4 break-words">
              Are you sure you want to revert commit <span className="font-mono bg-base-200 px-1 rounded">{commitToRevert?.hash.substring(0, 7)}</span> on <span className="font-bold break-all">{branchData?.current || 'current'}</span>?
            </p>
            {commitToRevert?.message && (
              <div className="rounded border border-base-300 bg-base-200/40 px-3 py-2 text-xs break-words">
                {commitToRevert.message}
              </div>
            )}
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => {
                  setIsRevertOpen(false);
                  setCommitToRevert(null);
                }}
                disabled={isReverting}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleConfirmRevert} disabled={isReverting}>
                {isReverting && <span className="loading loading-spinner loading-xs"></span>}
                Revert
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              onClick={() => {
                setIsRevertOpen(false);
                setCommitToRevert(null);
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {isRewordOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Reword Commit</h3>
            <p className="py-4 break-words">
              Reword commit <span className="font-mono bg-base-200 px-1 rounded">{commitToReword?.hash.substring(0, 7)}</span> on branch <span className="font-bold">{commitToReword?.branch}</span>.
            </p>
            <input
              type="text"
              className="input input-bordered w-full font-mono text-sm mb-3"
              value={newMessageSubject}
              onChange={e => setNewMessageSubject(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && newMessageSubject.trim() && !isRewording) {
                  e.preventDefault();
                  handleReword();
                }
              }}
              placeholder="Commit subject"
              disabled={isRewording}
            />
            <textarea
                className="textarea textarea-bordered w-full h-32 font-mono text-sm"
                value={newMessageBody}
                onChange={e => setNewMessageBody(e.target.value)}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && newMessageSubject.trim() && !isRewording) {
                    e.preventDefault();
                    handleReword();
                  }
                }}
                placeholder="Commit message body (optional)"
                disabled={isRewording}
            />
            {commitToReword?.branch !== branchData?.current && (
                <div className="alert alert-warning text-xs mt-2 py-2">
                    <span>This will briefly checkout <b>{commitToReword?.branch}</b> to amend the commit.</span>
                </div>
            )}
            <div className="modal-action">
              <button className="btn" onClick={closeRewordDialog} disabled={isRewording}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReword} disabled={!newMessageSubject.trim() || isRewording}>
                {isRewording && <span className="loading loading-spinner loading-xs"></span>}
                Reword
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeRewordDialog}>close</button>
          </form>
        </dialog>
      )}

      {isDeleteOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">{branchesToDelete.length > 1 ? 'Delete Branches' : 'Delete Branch'}</h3>
            {branchesToDelete.length > 1 ? (
              <div className="py-4 space-y-3">
                <p className="break-words">
                  Are you sure you want to delete <span className="font-bold">{branchesToDelete.length} selected branches</span>?
                  This action cannot be undone.
                </p>
                <div className="max-h-44 overflow-auto rounded border border-base-300 bg-base-200/40 p-2 space-y-1">
                  {branchesToDelete.map((branch) => (
                    <div key={branch} className="text-xs min-w-0 break-all">
                      {branch.startsWith('remotes/') ? branch.slice('remotes/'.length) : branch}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="py-4 break-words">
                Are you sure you want to delete the branch <span className="font-bold break-all">{branchesToDelete[0]?.startsWith('remotes/') ? branchesToDelete[0].slice('remotes/'.length) : branchesToDelete[0]}</span>?
                This action cannot be undone.
              </p>
            )}
            {selectedTrackingUpstreams.length > 0 && (
                <div className="form-control">
                <label className="label cursor-pointer justify-start items-start gap-2 min-w-0">
                    <input type="checkbox" className="checkbox checkbox-sm" checked={deleteRemoteBranch} onChange={(e) => setDeleteRemoteBranch(e.target.checked)} disabled={isDeleting} />
                    <span className="label-text break-words whitespace-normal">
                      {selectedTrackingUpstreams.length === 1 ? (
                        <>
                          Delete tracking remote branch <span className="font-mono opacity-70 break-all">{selectedTrackingUpstreams[0]}</span>
                        </>
                      ) : (
                        <>Delete {selectedTrackingUpstreams.length} tracking remote branches</>
                      )}
                    </span>
                </label>
                </div>
            )}
            <div className="modal-action">
              <button className="btn" onClick={() => { setIsDeleteOpen(false); setBranchesToDelete([]); setDeleteRemoteBranch(false); }} disabled={isDeleting}>Cancel</button>
              <button className="btn btn-error" onClick={handleDeleteBranch} disabled={isDeleting}>
                {isDeleting && <span className="loading loading-spinner loading-xs"></span>}
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => { setIsDeleteOpen(false); setBranchesToDelete([]); setDeleteRemoteBranch(false); }}>close</button>
          </form>
        </dialog>
      )}

      {isDeleteWorktreeOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Delete Worktree</h3>
            <p className="py-4 break-words">
              Are you sure you want to delete the worktree <span className="font-bold break-all">{worktreeToDelete}</span>?
            </p>
            <p className="text-sm text-error break-words">
              This will remove the worktree from git and remove its working directory.
            </p>
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => {
                  setIsDeleteWorktreeOpen(false);
                  setWorktreeToDelete(null);
                }}
                disabled={isDeletingWorktree}
              >
                Cancel
              </button>
              <button
                className="btn btn-error"
                onClick={() => void handleDeleteWorktree()}
                disabled={isDeletingWorktree || !worktreeToDelete}
              >
                {isDeletingWorktree && <span className="loading loading-spinner loading-xs"></span>}
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              onClick={() => {
                setIsDeleteWorktreeOpen(false);
                setWorktreeToDelete(null);
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {isDeleteTagOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Delete Tag</h3>
            <p className="py-4 break-words">
              Are you sure you want to delete the tag <span className="font-bold break-all">{tagToDelete}</span>?
              This action cannot be undone.
            </p>
            <div className="form-control">
              <label className="label cursor-pointer justify-start items-start gap-2 min-w-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={deleteRemoteTag}
                  onChange={(e) => setDeleteRemoteTag(e.target.checked)}
                  disabled={isDeletingTag || !remoteNameForTagDelete}
                />
                <span className="label-text break-words whitespace-normal">
                  {remoteNameForTagDelete ? (
                    <>
                      Also delete from remote <span className="font-mono opacity-70">{remoteNameForTagDelete}</span>
                    </>
                  ) : (
                    'No remote configured'
                  )}
                </span>
              </label>
            </div>
            <div className="modal-action">
              <button className="btn" onClick={closeDeleteTagDialog} disabled={isDeletingTag}>Cancel</button>
              <button className="btn btn-error" onClick={handleDeleteTag} disabled={isDeletingTag || !tagToDelete}>
                {isDeletingTag && <span className="loading loading-spinner loading-xs"></span>}
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeDeleteTagDialog}>close</button>
          </form>
        </dialog>
      )}

      {isCherryPickOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Cherry Pick</h3>
            <p className="text-sm opacity-70 mt-1">
              {commitsToCherryPick.length > 1
                ? 'Apply selected commits from oldest to newest'
                : 'Apply changes from the selected commit'}
            </p>
            {commitsToCherryPick.length === 1 ? (
              <p className="py-4 break-words">
                Are you sure to apply <span className="font-bold font-mono break-all">{commitsToCherryPick[0]?.hash}</span> <span className="font-bold break-words">{commitsToCherryPick[0]?.message}</span> to <span className="font-bold break-all">{branchData?.current || 'current'}</span> branch?
              </p>
            ) : (
              <div className="py-4 space-y-3">
                <p className="break-words">
                  Are you sure to apply <span className="font-bold">{commitsToCherryPick.length} selected commits</span> to <span className="font-bold break-all">{branchData?.current || 'current'}</span> branch?
                </p>
                <div className="max-h-44 overflow-auto rounded border border-base-300 bg-base-200/40 p-2 space-y-1">
                  {commitsToCherryPick.map((commit) => (
                    <div key={commit.hash} className="text-xs min-w-0">
                      <span className="font-mono opacity-70">{commit.hash.slice(0, 7)}</span>{' '}
                      <span className="break-words">{commit.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => {
                  setIsCherryPickOpen(false);
                  setCommitsToCherryPick([]);
                }}
                disabled={isCherryPicking}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleCherryPickCommit} disabled={isCherryPicking}>
                {isCherryPicking && <span className="loading loading-spinner loading-xs"></span>}
                Confirm
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              onClick={() => {
                setIsCherryPickOpen(false);
                setCommitsToCherryPick([]);
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {isAbortCherryPickOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Cherry Pick In Progress</h3>
            <p className="text-sm opacity-70 mt-1">Another cherry-pick operation is currently in progress.</p>
            <p className="py-4 break-words">
              Abort the in-progress cherry-pick and continue with {commitsToCherryPick.length > 1 ? 'the selected commits' : 'this commit'}?
            </p>
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => {
                  setIsAbortCherryPickOpen(false);
                  setCommitsToCherryPick([]);
                }}
                disabled={isAbortingCherryPick}
              >
                Cancel
              </button>
              <button
                className="btn btn-warning"
                onClick={() => void handleAbortCherryPick()}
                disabled={isAbortingCherryPick}
              >
                {isAbortingCherryPick && <span className="loading loading-spinner loading-xs"></span>}
                Abort and Continue
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              onClick={() => {
                setIsAbortCherryPickOpen(false);
                setCommitsToCherryPick([]);
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {isRenameOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">{remoteBranchToRename ? 'Rename Remote Branch' : 'Rename Branch'}</h3>
            <p className="py-4 break-words">
              Enter a new name for the branch <span className="font-bold break-all">{branchToRename}</span>. Press <kbd className="kbd kbd-sm">Enter</kbd> to confirm.
            </p>
            <input
                type="text"
                className="input input-bordered w-full"
                value={newBranchNameForRename}
                onChange={e => setNewBranchNameForRename(sanitizeBranchName(e.target.value))}
                placeholder="New branch name"
                disabled={isRenaming}
                autoFocus
                onKeyDown={e => {
                    const shortcutPressed = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
                    const sameName = remoteBranchToRename
                      ? newBranchNameForRename === remoteBranchToRename.branch
                      : newBranchNameForRename === branchToRename;
                    if (shortcutPressed && newBranchNameForRename && !sameName && !isRenaming) {
                        handleRenameBranch();
                    }
                }}
            />
            {!remoteBranchToRename && trackingInfoForRename?.upstream && (
              <div className="form-control mt-2">
                <label className="label cursor-pointer justify-start items-start gap-2 min-w-0">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={renameTrackingRemoteBranch}
                    onChange={(e) => setRenameTrackingRemoteBranch(e.target.checked)}
                    disabled={isRenaming}
                  />
                  <span className="label-text break-words whitespace-normal">
                    Also rename tracking remote branch <span className="font-mono opacity-70 break-all">{trackingInfoForRename.upstream}</span>
                  </span>
                </label>
              </div>
            )}
            <div className="modal-action">
              <button
                className="btn"
                onClick={closeRenameBranchDialog}
                disabled={isRenaming}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleRenameBranch}
                disabled={
                  !newBranchNameForRename ||
                  (remoteBranchToRename
                    ? newBranchNameForRename === remoteBranchToRename.branch
                    : newBranchNameForRename === branchToRename) ||
                  isRenaming
                }
              >
                {isRenaming && <span className="loading loading-spinner loading-xs"></span>}
                Rename
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeRenameBranchDialog}>
              close
            </button>
          </form>
        </dialog>
      )}

      {isRenameRemoteOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Rename Remote</h3>
            <p className="py-4 break-words">
              Enter a new name for remote <span className="font-bold break-all">{remoteToRename}</span>. Press <kbd className="kbd kbd-sm">Enter</kbd> to confirm.
            </p>
            <input
              type="text"
              className="input input-bordered w-full"
              value={newRemoteNameForRename}
              onChange={(e) => setNewRemoteNameForRename(e.target.value)}
              placeholder="New remote name"
              disabled={isRenamingRemote}
              autoFocus
              onKeyDown={(e) => {
                const shortcutPressed = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
                const trimmedNewName = newRemoteNameForRename.trim();
                const sameName = trimmedNewName === (remoteToRename ?? '').trim();
                if (shortcutPressed && trimmedNewName && !sameName && !isRenamingRemote) {
                  handleRenameRemote();
                }
              }}
            />
            <div className="modal-action">
              <button
                className="btn"
                onClick={closeRenameRemoteDialog}
                disabled={isRenamingRemote}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleRenameRemote}
                disabled={
                  !newRemoteNameForRename.trim() ||
                  newRemoteNameForRename.trim() === (remoteToRename ?? '').trim() ||
                  isRenamingRemote
                }
              >
                {isRenamingRemote && <span className="loading loading-spinner loading-xs"></span>}
                Rename
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeRenameRemoteDialog}>
              close
            </button>
          </form>
        </dialog>
      )}

      {isDeleteRemoteOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Delete Remote</h3>
            <p className="py-4 break-words">
              Are you sure you want to delete remote <span className="font-bold break-all">{remoteToDelete}</span>?
              This removes all tracking branches for that remote.
            </p>
            <div className="modal-action">
              <button
                className="btn"
                onClick={closeDeleteRemoteDialog}
                disabled={isDeletingRemote}
              >
                Cancel
              </button>
              <button
                className="btn btn-error"
                onClick={handleDeleteRemote}
                disabled={!remoteToDelete || isDeletingRemote}
              >
                {isDeletingRemote && <span className="loading loading-spinner loading-xs"></span>}
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeDeleteRemoteDialog}>
              close
            </button>
          </form>
        </dialog>
      )}

      {isAddRemoteOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Add Remote</h3>
            <p className="py-4 break-words">
              Add a new remote by providing a name and URL. Press <kbd className="kbd kbd-sm">Enter</kbd> to confirm.
            </p>
            <div className="space-y-3">
              <div>
                <label className="label pt-0">
                  <span className="label-text">Remote name</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full"
                  value={newRemoteName}
                  onChange={(e) => setNewRemoteName(e.target.value)}
                  placeholder="origin"
                  disabled={isAddingRemote}
                  autoFocus
                />
              </div>
              <div>
                <label className="label pt-0">
                  <span className="label-text">Remote URL</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full"
                  value={newRemoteUrl}
                  onChange={(e) => setNewRemoteUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  disabled={isAddingRemote}
                  onKeyDown={(e) => {
                    const shortcutPressed = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
                    if (shortcutPressed && newRemoteName.trim() && newRemoteUrl.trim() && !isAddingRemote) {
                      handleAddRemote();
                    }
                  }}
                />
              </div>
            </div>
            <div className="modal-action">
              <button
                className="btn"
                onClick={closeAddRemoteDialog}
                disabled={isAddingRemote}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleAddRemote}
                disabled={!newRemoteName.trim() || !newRemoteUrl.trim() || isAddingRemote}
              >
                {isAddingRemote && <span className="loading loading-spinner loading-xs"></span>}
                Add
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeAddRemoteDialog}>
              close
            </button>
          </form>
        </dialog>
      )}

      {isRebaseOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Rebase</h3>
            <p className="py-4 break-words">
                Copy commits from one branch to another.<br/>
                Are you sure to rebase <span className="font-bold break-all">{rebaseSourceBranch}</span> onto <span className="font-bold break-all">{rebaseTargetBranch}</span>?
            </p>
            <div className="form-control">
                <label className="label cursor-pointer justify-start gap-2">
                    <input type="checkbox" className="checkbox checkbox-sm" checked={rebaseStashChanges} onChange={(e) => setRebaseStashChanges(e.target.checked)} disabled={isRebasing} />
                    <span className="label-text">Stash and reapply local changes</span>
                </label>
            </div>
            {!rebaseStashChanges && (
              <p className="text-xs text-warning mt-2 ml-6">
                Warning: All local changes will be discarded.
              </p>
            )}
            {rebaseConflictStatus === 'checking' ? (
              <div className="alert alert-info text-sm mt-4 py-2">
                <span className="loading loading-spinner loading-xs"></span>
                <span>Checking conflicts for rebasing <span className="font-bold break-all">{rebaseSourceBranch}</span> onto <span className="font-bold break-all">{rebaseTargetBranch}</span>...</span>
              </div>
            ) : rebaseConflictStatus === 'no-conflict' ? (
              <div className="alert alert-success text-sm mt-4 py-2">
                <i className="iconoir-check-circle-solid text-[18px]" aria-hidden="true" />
                <span>No conflict: rebasing <span className="font-bold break-all">{rebaseSourceBranch}</span> onto <span className="font-bold break-all">{rebaseTargetBranch}</span> will not cause conflicts.</span>
              </div>
            ) : (
              <div className="alert alert-warning text-sm mt-4 py-2">
                <i className="iconoir-warning-circle-solid text-[18px]" aria-hidden="true" />
                <span>Conflicts detected: rebasing <span className="font-bold break-all">{rebaseSourceBranch}</span> onto <span className="font-bold break-all">{rebaseTargetBranch}</span> will cause conflicts.</span>
              </div>
            )}
            <div className="modal-action">
              <button className="btn" onClick={closeRebaseDialog} disabled={isRebasing}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRebase} disabled={isRebasing}>
                {isRebasing && <span className="loading loading-spinner loading-xs"></span>}
                Confirm
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeRebaseDialog}>close</button>
          </form>
        </dialog>
      )}

      {isMergeOpen && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Merge</h3>
                <p className="py-4 break-words">
                    Merge branch into another one.<br/>
                    Are you sure to merge <span className="font-bold break-all">{mergeSourceBranch}</span> into <span className="font-bold break-all">{mergeTargetBranch}</span>?
                </p>
                <div className="form-control">
                    <label className="label cursor-pointer justify-start gap-2">
                        <input type="checkbox" className="checkbox checkbox-sm" checked={mergeRebaseBeforeMerge} onChange={(e) => setMergeRebaseBeforeMerge(e.target.checked)} disabled={isMerging} />
                        <span className="label-text">Rebase before merge</span>
                    </label>
                </div>
                <div className="form-control">
                    <label className="label cursor-pointer justify-start gap-2">
                        <input type="checkbox" className="checkbox checkbox-sm" checked={mergeSquash} onChange={(e) => handleMergeSquashToggle(e.target.checked)} disabled={isMerging} />
                        <span className="label-text">Squash before merge</span>
                    </label>
                </div>
                {mergeSquash && (
                    <textarea
                        className="textarea textarea-bordered w-full mt-2"
                        placeholder="Commit message for squash merge"
                        value={mergeSquashMessage}
                        onChange={(e) => setMergeSquashMessage(e.target.value)}
                        disabled={isMerging}
                        autoFocus
                    />
                )}
                <div className="form-control">
                    <label className="label cursor-pointer justify-start gap-2">
                        <input type="checkbox" className="checkbox checkbox-sm" checked={mergeFastForward} onChange={(e) => setMergeFastForward(e.target.checked)} disabled={isMerging} />
                        <span className="label-text">Fast forward merge</span>
                    </label>
                </div>
                {mergeConflictStatus === 'checking' ? (
                  <div className="alert alert-info text-sm mt-4 py-2">
                    <span className="loading loading-spinner loading-xs"></span>
                    <span>Checking conflicts for merging <span className="font-bold break-all">{mergeSourceBranch}</span> into <span className="font-bold break-all">{mergeTargetBranch}</span>...</span>
                  </div>
                ) : mergeConflictStatus === 'no-conflict' ? (
                  <div className="alert alert-success text-sm mt-4 py-2">
                    <i className="iconoir-check-circle-solid text-[18px]" aria-hidden="true" />
                    <span>No conflict: merging <span className="font-bold break-all">{mergeSourceBranch}</span> into <span className="font-bold break-all">{mergeTargetBranch}</span> will not cause conflicts.</span>
                  </div>
                ) : (
                  <div className="alert alert-warning text-sm mt-4 py-2">
                    <i className="iconoir-warning-circle-solid text-[18px]" aria-hidden="true" />
                    <span>Conflicts detected: merging <span className="font-bold break-all">{mergeSourceBranch}</span> into <span className="font-bold break-all">{mergeTargetBranch}</span> will cause conflicts.</span>
                  </div>
                )}
                <div className="modal-action">
                    <button className="btn" onClick={closeMergeDialog} disabled={isMerging}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleMerge} disabled={isMerging}>
                        {isMerging && <span className="loading loading-spinner loading-xs"></span>}
                        Confirm
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={closeMergeDialog}>close</button>
            </form>
        </dialog>
      )}

      {isPushOpen && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Push to Remote</h3>
                <p className="py-4 break-words">Push <span className="font-bold break-all">{pushBranch}</span> to a remote repository.</p>

                {pushError && pushRemotes.length === 0 ? (
                    <div className="alert alert-error">
                        <span className="text-xl">⚠️</span>
                        <span>{pushError}</span>
                    </div>
                ) : pushLoadingRemotes ? (
                    <div className="flex justify-center py-8">
                        <span className="loading loading-spinner loading-lg"></span>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div className="form-control w-full flex flex-row items-center justify-between gap-4">
                            <label className="label flex-shrink-0"><span className="label-text">Remote Repository</span></label>
                            <select className="select select-bordered w-64" value={pushSelectedRemote} onChange={(e) => handlePushRemoteChange(e.target.value)} disabled={isPushing}>
                                {pushRemotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
                            </select>
                        </div>

                        <div className="form-control w-full flex flex-row items-center justify-between gap-4">
                            <label className="label flex-shrink-0"><span className="label-text">Remote Branch</span></label>
                            <div className="flex flex-col items-end gap-1 w-64">
                                {pushLoadingBranches ? (
                                    <div className="flex items-center gap-2 p-3 border rounded-lg bg-base-200 opacity-70 w-full">
                                        <span className="loading loading-spinner loading-xs"></span> Loading branches...
                                    </div>
                                ) : (
                                    <select className="select select-bordered w-full" value={pushSelectedRemoteBranch} onChange={(e) => setPushSelectedRemoteBranch(e.target.value)} disabled={isPushing}>
                                        {pushBranch && !pushRemoteBranches.includes(pushBranch) && <option value={pushBranch}>{pushBranch} (new)</option>}
                                        {pushRemoteBranches.map((branch) => <option key={branch} value={branch}>{branch}{pushTrackingBranch?.remote === pushSelectedRemote && pushTrackingBranch?.branch === branch ? ' (tracking)' : ''}</option>)}
                                    </select>
                                )}
                                {pushSelectedRemoteBranch && !pushRemoteBranches.includes(pushSelectedRemoteBranch) && (
                                    <div className="label"><span className="label-text-alt text-warning">New branch will be created</span></div>
                                )}
                            </div>
                        </div>

                        <div className="form-control">
                            <label className="label cursor-pointer justify-start gap-2">
                                <input type="checkbox" className="checkbox checkbox-sm" checked={pushRebaseFirst} onChange={(e) => setPushRebaseFirst(e.target.checked)} disabled={isPushing || pushForcePush} />
                                <span className="label-text">Rebase onto remote branch before pushing</span>
                            </label>
                        </div>

                        <div className="form-control">
                            <label className="label cursor-pointer justify-start gap-2">
                                <input type="checkbox" className="checkbox checkbox-sm checkbox-error" checked={pushForcePush} onChange={(e) => setPushForcePush(e.target.checked)} disabled={isPushing} />
                                <span className="label-text text-error">Force push</span>
                            </label>
                        </div>

                        <div className="form-control">
                            <label className="label cursor-pointer justify-start gap-2">
                                <input type="checkbox" className="checkbox checkbox-sm" checked={pushLocalOnlyTags} onChange={(e) => setPushLocalOnlyTags(e.target.checked)} disabled={isPushing} />
                                <span className="label-text">Push all tags</span>
                            </label>
                        </div>

                        <div className="form-control">
                            <label className="label cursor-pointer justify-start gap-2">
                                <input type="checkbox" className="checkbox checkbox-sm" checked={pushSquash} onChange={(e) => handlePushSquashToggle(e.target.checked)} disabled={isPushing} />
                                <span className="label-text">Squash local commits before push</span>
                            </label>
                        </div>
                        {pushSquash && (
                            <textarea className="textarea textarea-bordered w-full" placeholder="Commit message for squash" value={pushSquashMessage} onChange={(e) => setPushSquashMessage(e.target.value)} disabled={isPushing} autoFocus />
                        )}

                        {pushError && (
                            <div className="alert alert-error text-sm">
                                <span>{pushError}</span>
                            </div>
                        )}
                    </div>
                )}

                <div className="modal-action">
                    <button className="btn" onClick={() => setIsPushOpen(false)} disabled={isPushing}>Cancel</button>
                    {pushRemotes.length > 0 && (
                        <button className="btn btn-primary" onClick={handlePushToRemote} disabled={isPushing || !pushSelectedRemote || !pushSelectedRemoteBranch}>
                            {isPushing && <span className="loading loading-spinner loading-xs"></span>} Push
                        </button>
                    )}
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={() => setIsPushOpen(false)}>close</button>
            </form>
        </dialog>
      )}

      {isPullOpen && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Pull from Remote</h3>
                <p className="py-4 break-words">Pull changes from a remote branch into <span className="font-bold break-all">{pullBranch}</span>.</p>

                {pullError && pullRemotes.length === 0 ? (
                    <div className="alert alert-error"><span>{pullError}</span></div>
                ) : pullLoadingRemotes ? (
                    <div className="flex justify-center py-8"><span className="loading loading-spinner loading-lg"></span></div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div className="form-control w-full flex flex-row items-center justify-between gap-4">
                            <label className="label flex-shrink-0"><span className="label-text">Remote Repository</span></label>
                            <select className="select select-bordered w-64" value={pullSelectedRemote} onChange={(e) => handlePullRemoteChange(e.target.value)} disabled={isPulling}>
                                {pullRemotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
                            </select>
                        </div>

                        <div className="form-control w-full flex flex-row items-center justify-between gap-4">
                            <label className="label flex-shrink-0"><span className="label-text">Remote Branch</span></label>
                            {pullLoadingBranches ? (
                                <div className="flex items-center gap-2 p-3 border rounded-lg bg-base-200 opacity-70 w-64">
                                    <span className="loading loading-spinner loading-xs"></span> Loading branches...
                                </div>
                            ) : (
                                <select className="select select-bordered w-64" value={pullSelectedRemoteBranch} onChange={(e) => setPullSelectedRemoteBranch(e.target.value)} disabled={isPulling}>
                                    {pullRemoteBranches.map((branch) => <option key={branch} value={branch}>{branch}{pullTrackingBranch?.remote === pullSelectedRemote && pullTrackingBranch?.branch === branch ? ' (tracking)' : ''}</option>)}
                                </select>
                            )}
                        </div>

                        <div className="form-control">
                            <label className="label cursor-pointer justify-start gap-2">
                                <input type="checkbox" className="checkbox checkbox-sm" checked={pullRebase} onChange={(e) => setPullRebase(e.target.checked)} disabled={isPulling} />
                                <span className="label-text">Rebase onto remote branch</span>
                            </label>
                        </div>

                        {pullError && <div className="alert alert-error text-sm"><span>{pullError}</span></div>}
                    </div>
                )}
                
                <div className="modal-action">
                    <button className="btn" onClick={() => setIsPullOpen(false)} disabled={isPulling}>Cancel</button>
                    {pullRemotes.length > 0 && (
                        <button className="btn btn-primary" onClick={handlePullFromRemote} disabled={isPulling || !pullSelectedRemote || !pullSelectedRemoteBranch}>
                            {isPulling && <span className="loading loading-spinner loading-xs"></span>} Pull
                        </button>
                    )}
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={() => setIsPullOpen(false)}>close</button>
            </form>
        </dialog>
      )}

      {isCreateTagOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Create Tag</h3>
            <p className="py-4 break-words">
              Create a new tag at commit <span className="font-mono bg-base-200 px-1 rounded">{createTagCommitHash?.substring(0, 7)}</span>.
            </p>
            <input
              type="text"
              className="input input-bordered w-full font-mono"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Tag name"
              disabled={isCreatingTag}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTagName.trim() && !isCreatingTag) {
                  e.preventDefault();
                  handleCreateTag();
                }
              }}
            />
            <div className="form-control mt-3">
              <label className="label cursor-pointer justify-start gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={pushTagToRemote}
                  onChange={(e) => setPushTagToRemote(e.target.checked)}
                  disabled={isCreatingTag}
                />
                <span className="label-text">Push tag to remote after creation</span>
              </label>
            </div>
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => {
                  setIsCreateTagOpen(false);
                  setCreateTagCommitHash(null);
                  setNewTagName('');
                  setPushTagToRemote(false);
                }}
                disabled={isCreatingTag}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleCreateTag} disabled={!newTagName.trim() || isCreatingTag}>
                {isCreatingTag && <span className="loading loading-spinner loading-xs"></span>}
                Create
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              onClick={() => {
                setIsCreateTagOpen(false);
                setCreateTagCommitHash(null);
                setNewTagName('');
                setPushTagToRemote(false);
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {iscreateBranchOpen && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Create New Branch</h3>
                <p className="py-4 break-words">
                  Create a new branch from{' '}
                  <span className="font-bold break-all">
                    {createBranchFromRef ? createBranchFromRef.replace(/^remotes\//, '') : 'current HEAD'}
                  </span>.
                </p>
                <input
                    type="text"
                    className="input input-bordered w-full"
                    value={newBranchName}
                    onChange={e => setNewBranchName(sanitizeBranchName(e.target.value))}
                    placeholder="Branch name"
                    disabled={isCreating}
                    autoFocus
                    onKeyDown={e => {
                        if (e.key === 'Enter' && newBranchName && !isCreating) {
                            e.preventDefault();
                            handleCreateBranch();
                        }
                    }}
                />
                <div className="modal-action">
                    <button
                      className="btn"
                      onClick={() => {
                        setIsCreateBranchOpen(false);
                        setCreateBranchFromRef(null);
                      }}
                      disabled={isCreating}
                    >
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={handleCreateBranch} disabled={!newBranchName || isCreating}>
                        {isCreating && <span className="loading loading-spinner loading-xs"></span>} Create & Checkout
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button
                  onClick={() => {
                    setIsCreateBranchOpen(false);
                    setCreateBranchFromRef(null);
                  }}
                >
                  close
                </button>
            </form>
        </dialog>
      )}

      {isCheckoutToLocalOpen && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Checkout to Local Branch</h3>
                <p className="py-4 break-words">Create a local branch from <span className="font-bold break-all">{checkoutRemoteBranch?.replace(/^remotes\//, '')}</span> and set up tracking.</p>
                <div className="form-control w-full">
                    <label className="label"><span className="label-text">Local Branch Name</span></label>
                    <input
                        type="text"
                        className="input input-bordered w-full"
                        value={checkoutLocalBranchName}
                        onChange={e => setCheckoutLocalBranchName(sanitizeBranchName(e.target.value))}
                        placeholder="Local branch name"
                        disabled={isCheckingOutToLocal}
                        autoFocus
                        onKeyDown={e => {
                            if (e.key === 'Enter' && checkoutLocalBranchName && !isCheckingOutToLocal) {
                                e.preventDefault();
                                handleCheckoutToLocal();
                            }
                        }}
                    />
                </div>
                <div className="modal-action">
                    <button className="btn" onClick={() => setIsCheckoutToLocalOpen(false)} disabled={isCheckingOutToLocal}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleCheckoutToLocal} disabled={!checkoutLocalBranchName || isCheckingOutToLocal}>
                        {isCheckingOutToLocal && <span className="loading loading-spinner loading-xs"></span>} Checkout
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={() => setIsCheckoutToLocalOpen(false)}>close</button>
            </form>
        </dialog>
      )}

      {isSwitchBranchModalOpen && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center shrink-0">
                <i className="iconoir-warning-triangle text-[20px]" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-lg">Uncommitted Changes</h3>
                <p className="text-sm opacity-80 mt-1">
                  You have uncommitted changes in your workspace. Choose how to handle your changes before switching to branch{' '}
                  <span className="font-bold font-mono text-primary break-all">{targetBranchDisplayName}</span>:
                </p>
              </div>
            </div>

            <div className="space-y-2.5 my-5">
              <label
                className={cn(
                  "flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors select-none",
                  switchBranchStrategy === 'stash-and-reapply'
                    ? "border-primary bg-primary/5 shadow-xs"
                    : "border-base-300 hover:bg-base-200/50"
                )}
                onClick={() => setSwitchBranchStrategy('stash-and-reapply')}
              >
                <input
                  type="radio"
                  name="switchBranchStrategy"
                  className="radio radio-primary radio-sm mt-0.5"
                  checked={switchBranchStrategy === 'stash-and-reapply'}
                  onChange={() => setSwitchBranchStrategy('stash-and-reapply')}
                  disabled={isSwitchingBranch}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <span>Stash and reapply</span>
                    <span className="badge badge-xs badge-primary/20 text-primary font-normal">Default</span>
                  </div>
                  <p className="text-xs opacity-70 mt-0.5 leading-relaxed">
                    Stash current changes, switch to <span className="font-mono font-medium">{targetBranchDisplayName}</span>, and reapply your changes.
                  </p>
                </div>
              </label>

              <label
                className={cn(
                  "flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors select-none",
                  switchBranchStrategy === 'discard'
                    ? "border-error bg-error/5 shadow-xs"
                    : "border-base-300 hover:bg-base-200/50"
                )}
                onClick={() => setSwitchBranchStrategy('discard')}
              >
                <input
                  type="radio"
                  name="switchBranchStrategy"
                  className="radio radio-error radio-sm mt-0.5"
                  checked={switchBranchStrategy === 'discard'}
                  onChange={() => setSwitchBranchStrategy('discard')}
                  disabled={isSwitchingBranch}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-error flex items-center gap-1.5">
                    <i className="iconoir-trash text-[14px]" aria-hidden="true" />
                    <span>Discard changes</span>
                  </div>
                  <p className="text-xs opacity-70 mt-0.5 leading-relaxed">
                    Permanently discard all uncommitted changes before switching. <span className="text-error font-medium">This cannot be undone.</span>
                  </p>
                </div>
              </label>
            </div>

            <div className="modal-action">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIsSwitchBranchModalOpen(false);
                  setPendingBranchSwitch(null);
                }}
                disabled={isSwitchingBranch}
              >
                Cancel
              </button>
              <button
                type="button"
                className={cn(
                  "btn",
                  switchBranchStrategy === 'discard' ? "btn-error" : "btn-primary"
                )}
                onClick={handleConfirmSwitchBranch}
                disabled={isSwitchingBranch}
              >
                {isSwitchingBranch && <span className="loading loading-spinner loading-xs"></span>}
                Confirm
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button
              type="button"
              onClick={() => {
                if (!isSwitchingBranch) {
                  setIsSwitchBranchModalOpen(false);
                  setPendingBranchSwitch(null);
                }
              }}
            >
              close
            </button>
          </form>
        </dialog>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-base-100">
        <div className="h-[57px] flex items-center justify-between gap-3 px-6 border-b border-base-300 shrink-0 history-header">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h1 className="font-bold text-lg">History</h1>
            <div className="relative" ref={branchPopoverRef}>
              <button
                className="btn btn-sm gap-2 max-w-[24rem] header-icon-btn"
                onClick={() => setIsBranchPopoverOpen(prev => !prev)}
                title={currentBranchLabel}
                aria-label={currentBranchLabel}
              >
                <span className="truncate branch-selector-label">{currentBranchLabel}</span>
                <i className={cn("iconoir-nav-arrow-down text-[16px] shrink-0 transition-transform", isBranchPopoverOpen && "rotate-180")} aria-hidden="true" />
              </button>
              {isBranchPopoverOpen && (
                <div className="absolute left-0 top-full mt-2 z-50">
                  {branchTreePopoverContent}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                className="btn btn-sm gap-2 header-icon-btn"
                onClick={() => void handleFetchFromAllRemotes()}
                disabled={isFetchingAllRemotes || isPullingAllBranches || isPullOpen || isPushOpen}
                title="Fetch latest changes from all remotes"
                aria-label="Fetch"
              >
                {isFetchingAllRemotes ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <i className="iconoir-refresh text-[16px]" aria-hidden="true" />
                )}
                <span className="header-btn-label">Fetch</span>
              </button>
              <button
                className="btn btn-sm gap-2 header-icon-btn"
                onClick={confirmPullCurrentBranch}
                disabled={!!pullActionDisabledReason || isPullingAllBranches || isPullOpen || isPushOpen}
                title={pullActionDisabledReason || `Pull from ${currentTrackingBranch?.upstream}`}
                aria-label="Pull"
              >
                {pullLoadingRemotes ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <i className="iconoir-arrow-down text-[16px]" aria-hidden="true" />
                )}
                <span className="header-btn-label">Pull</span>
              </button>
              <button
                className="btn btn-sm gap-2 header-icon-btn"
                onClick={() => void handlePullAllBranches()}
                disabled={!!pullAllActionDisabledReason || isPullOpen || isPushOpen || isPullingAllBranches}
                title={pullAllActionDisabledReason || 'Pull all local branches from tracking remote branches'}
                aria-label="Pull All"
              >
                {isPullingAllBranches ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <i className="iconoir-fast-arrow-down text-[16px]" aria-hidden="true" />
                )}
                <span className="header-btn-label">Pull All</span>
              </button>
              <button
                className="btn btn-sm gap-2 header-icon-btn"
                onClick={confirmPushCurrentBranch}
                disabled={!!pushActionDisabledReason || isPullingAllBranches || isPullOpen || isPushOpen}
                title={pushActionDisabledReason || (currentTrackingBranch ? `Push to ${currentTrackingBranch.upstream}` : 'Push current branch to remote')}
                aria-label="Push"
              >
                {pushLoadingRemotes ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <i className="iconoir-arrow-up text-[16px]" aria-hidden="true" />
                )}
                <span className="header-btn-label">Push</span>
              </button>
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <div className="relative" ref={customScriptsMenuRef}>
              <button
                className="btn btn-sm gap-2 header-icon-btn"
                onClick={() => setIsCustomScriptsMenuOpen((prev) => !prev)}
                title={`Run custom scripts on ${headerScriptTargetRef.label}`}
                aria-label="Custom Scripts"
              >
                <i className="iconoir-code text-[16px]" aria-hidden="true" />
                <span className="header-btn-label">Custom Scripts</span>
                <i
                  className={cn(
                    "iconoir-nav-arrow-down text-[14px] shrink-0 transition-transform",
                    isCustomScriptsMenuOpen && "rotate-180"
                  )}
                  aria-hidden="true"
                />
              </button>

              {isCustomScriptsMenuOpen && (
                <div className="absolute right-0 top-full mt-2 z-50 w-72 bg-base-100 rounded-lg shadow-xl border border-base-300 p-2 text-xs">
                  <div className="px-3 py-2 border-b border-base-200">
                    <div className="text-[10px] uppercase font-bold tracking-wider opacity-60">
                      Target Ref
                    </div>
                    <div className="font-semibold truncate text-xs mt-0.5">
                      {headerScriptTargetRef.label}
                    </div>
                    {headerScriptTargetRef.sublabel && (
                      <div className="text-[11px] opacity-60 truncate mt-0.5" title={headerScriptTargetRef.sublabel}>
                        {headerScriptTargetRef.sublabel}
                      </div>
                    )}
                  </div>

                  <div className="py-1 max-h-56 overflow-auto">
                    {customBranchScripts.length === 0 ? (
                      <div className="px-3 py-3 text-center opacity-60 text-xs">
                        No custom scripts configured.
                      </div>
                    ) : (
                      customBranchScripts.map((script) => (
                        <button
                          key={script.id}
                          className="w-full text-left px-3 py-2 hover:bg-base-200 rounded flex items-center justify-between gap-2 group transition-colors"
                          onClick={() => {
                            setIsCustomScriptsMenuOpen(false);
                            handleRunCustomScript(script, headerScriptTargetRef.ref);
                          }}
                        >
                          <span className="font-medium truncate">{script.name}</span>
                          <i className="iconoir-play text-[13px] opacity-0 group-hover:opacity-100 text-primary transition-opacity shrink-0" aria-hidden="true" />
                        </button>
                      ))
                    )}
                  </div>

                  <div className="pt-2 border-t border-base-200">
                    <Link
                      href={`/workspace/custom-scripts?path=${encodeURIComponent(repoPath)}`}
                      className="w-full btn btn-ghost btn-xs justify-start gap-1.5 font-normal text-xs"
                      onClick={() => setIsCustomScriptsMenuOpen(false)}
                    >
                      <i className="iconoir-settings text-[14px]" aria-hidden="true" />
                      Manage scripts...
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <button
              className="btn btn-sm gap-2 header-icon-btn"
              onClick={() => void handleOpenRepoTerminal()}
              disabled={isOpeningRepoTerminal}
              title="Open terminal in repository folder"
              aria-label="Open Terminal"
            >
              {isOpeningRepoTerminal ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : (
                <i className="iconoir-terminal text-[16px]" aria-hidden="true" />
              )}
              <span className="header-btn-label">Open Terminal</span>
            </button>
            <button
              className="btn btn-sm gap-2 header-icon-btn"
              onClick={() => void handleOpenRepoFolder()}
              disabled={isOpeningRepoFolder}
              title="Open repository folder in Finder"
              aria-label="Open Repo Folder"
            >
              {isOpeningRepoFolder ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : (
                <i className="iconoir-folder text-[16px]" aria-hidden="true" />
              )}
              <span className="header-btn-label">Open Repo Folder</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden relative">
          {/* Show loading spinner while branches are loading if visibility filters are set */}
          {hasVisibilityFilters && isBranchesLoading ? (
            <div className="flex items-center justify-center h-full">
              <span className="loading loading-spinner loading-lg opacity-50"></span>
            </div>
          ) : (
            <GitGraph
              ref={gitGraphRef}
              commits={commitsWithLocalChanges}
              selectedHash={selectedHash || undefined}
              selectedHashes={selectedCommitHashSet}
              onSelectCommit={handleSelectCommit}
              onResetToCommit={handleResetToCommit}
              onRevertCommit={confirmRevertCommit}
              onCreateTag={confirmCreateTag}
              onCherryPickCommit={confirmCherryPickCommit}
              onCherryPickSelectedCommits={confirmCherryPickSelectedCommits}
              onRewordCommit={confirmRewordCommit}
              localBranches={branchData?.branches || []}
              trackingInfo={branchData?.trackingInfo}
              onEndReached={() => {
                if (!isFetching && log.all.length >= limit) {
                  setLimit(l => l + 50);
                }
              }}
              isLoadingMore={isFetching && limit > 100}
              currentBranch={branchData?.current}
              hiddenBranches={hiddenBranches}
              getBranchTagContextMenuItems={getBranchTagContextMenuItems}
            />
          )}
        </div>

        {selectedHash && (
          <div 
            className="flex flex-col overflow-hidden border-t border-base-300 bg-base-200/30"
            style={{ height: panelHeight }}
          >
            {/* Resize handle */}
            <div 
              className={cn(
                "h-1.5 cursor-ns-resize flex items-center justify-center hover:bg-base-200 transition-colors group shrink-0",
                isResizing && "bg-base-200"
              )}
              onMouseDown={handleResizeStart}
            >
              <div className="w-8 h-1 rounded-full bg-base-300 group-hover:bg-base-content/20 transition-colors" />
            </div>

            {selectedHash === '__LOCAL_CHANGES__' ? (
              <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
                <StatusView repoPath={repoPath} onClose={() => selectSingleCommit(null)} />
              </div>
            ) : (
              <>
                {/* Header with commit info */}
                <div className="flex flex-row items-center py-2 px-4 border-b border-base-300 bg-base-100 shrink-0 justify-between gap-4">
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    {isCommitRangeSelection && selectedCommitRange ? (
                      <>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold truncate">
                            {selectedCommitRange.latestHash.substring(0, 7)}: {selectedCommitRange.latestCommit.message}
                          </div>
                          <div className="text-sm font-bold truncate opacity-75">
                            {selectedCommitRange.oldestHash.substring(0, 7)}: {selectedCommitRange.oldestCommit.message}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-bold truncate">
                          {selectedCommit?.message}
                        </span>
                        <span className="text-xs font-mono opacity-50 shrink-0">
                          {selectedHash.substring(0, 7)}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {!isCommitRangeSelection && selectedCommit?.author_name && (
                      <span className="text-xs opacity-60 truncate max-w-[200px]" title={selectedCommit.author_email}>
                        {selectedCommit.author_name}
                      </span>
                    )}
                    <button
                      className="ml-2 btn btn-ghost btn-xs btn-square"
                      onClick={() => selectSingleCommit(null)}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {isCommitRangeSelection && selectedCommitRange ? (
                  <div className="flex-1 overflow-hidden min-h-0 flex flex-col bg-base-100">
                    <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider font-bold opacity-60 border-b border-base-300 bg-base-100 shrink-0">
                      Changes
                    </div>
                    <div className="flex-1 min-h-0">
                      <CommitChangesView
                        repoPath={repoPath}
                        fromCommitHash={selectedCommitRange.oldestHash}
                        toCommitHash={selectedCommitRange.latestHash}
                      />
                    </div>
                  </div>
                ) : (
                  /* Combined commit message and changes content */
                  <div
                    ref={commitDetailsContentRef}
                    className="flex-1 overflow-hidden bg-base-100 grid"
                    style={{
                      gridTemplateRows: `${commitDetailsMessageRatio}fr 6px ${1 - commitDetailsMessageRatio}fr`,
                    }}
                  >
                    <div className="border-b border-base-300 bg-base-100 min-h-0 flex flex-col">
                      <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider font-bold opacity-60">
                        Message
                      </div>
                      <div className="px-4 pb-3 overflow-auto flex-1 min-h-0">
                        <div className="text-xs opacity-70 whitespace-pre-wrap font-mono">
                          {selectedCommit
                            ? formatCommitMessageForDisplay(
                                selectedCommit.body?.trim()
                                  ? `${selectedCommit.message}\n\n${selectedCommit.body}`
                                  : selectedCommit.message
                              )
                            : 'No additional message'}
                        </div>
                      </div>
                    </div>
                    <div
                      className={cn(
                        'cursor-ns-resize flex items-center justify-center hover:bg-base-200/60 transition-colors',
                        isCommitDetailsRatioResizing && 'bg-base-200/60'
                      )}
                      onMouseDown={handleCommitDetailsRatioResizeStart}
                    >
                      <div className="w-8 h-1 rounded-full bg-base-300" />
                    </div>
                    <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
                      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider font-bold opacity-60 border-b border-base-300 bg-base-100 shrink-0">
                        Changes
                      </div>
                      <div className="flex-1 min-h-0">
                        <CommitChangesView repoPath={repoPath} commitHash={selectedHash} />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
