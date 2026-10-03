'use client';

import { Suspense } from 'react';
import { useCurrentRepoPath } from '@/hooks/use-git';
import { useWorkspaceTitle } from '@/hooks/use-workspace-title';
import { ConflictResolverView } from '@/components/git/conflict-resolver-view';

function WorkspaceConflictsContent() {
  const repoPath = useCurrentRepoPath();

  useWorkspaceTitle(repoPath, 'Conflicts');

  if (!repoPath) {
    return <div className="p-8">No repository path specified.</div>;
  }

  return <ConflictResolverView repoPath={repoPath} />;
}

export default function WorkspaceConflictsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
      <WorkspaceConflictsContent />
    </Suspense>
  );
}
