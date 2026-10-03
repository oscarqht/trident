'use client';

import { HistoryView } from '@/components/git/history-view';
import { Suspense } from 'react';
import { useCurrentRepoPath } from '@/hooks/use-git';
import { useWorkspaceTitle } from '@/hooks/use-workspace-title';

function WorkspaceHistoryContent() {
  const repoPath = useCurrentRepoPath();

  useWorkspaceTitle(repoPath, 'History');

  if (!repoPath) {
    return <div className="p-8">No repository path specified.</div>;
  }

  return <HistoryView repoPath={repoPath} />;
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
      <WorkspaceHistoryContent />
    </Suspense>
  );
}
