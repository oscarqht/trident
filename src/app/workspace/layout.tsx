import { Sidebar } from '@/components/layout/sidebar';
import { Suspense } from 'react';
import { WorkspaceRepoOpenTracker } from '@/components/workspace-repo-open-tracker';
import { getSettings } from '@/lib/store';

export default function WorkspaceLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const sidebarCollapsed = getSettings().sidebarCollapsed ?? false;

    return (
        <div className="flex min-h-screen max-h-screen bg-base-100">
            <Suspense fallback={null}>
                <WorkspaceRepoOpenTracker />
            </Suspense>
            <Suspense fallback={<div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} border-r border-base-300 min-h-screen bg-base-200/30 flex items-center justify-center`}><span className="loading loading-spinner"></span></div>}>
                <Sidebar initialCollapsed={sidebarCollapsed} />
            </Suspense>
            <main className="flex-1 overflow-auto">
                {children}
            </main>
        </div>
    );
}
