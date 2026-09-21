'use client';

import React from 'react';
import { useCustomScriptExecution, ScriptExecutionItem } from '@/contexts/custom-script-execution-context';
import { cn, getRepoFolderName } from '@/lib/utils';

export function ScriptDock() {
  const { executions, openModal, cancelScript, dismissExecution } = useCustomScriptExecution();

  // Show only executions whose full modal is not currently opened
  const dockedExecutions = executions.filter((e) => !e.isModalOpen);

  if (dockedExecutions.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
      {dockedExecutions.map((item: ScriptExecutionItem) => {
        const isRunning = item.status === 'starting' || item.status === 'running';

        return (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto bg-base-100 shadow-xl border rounded-lg p-3 w-84 text-xs transition-all flex flex-col gap-2',
              isRunning ? 'border-primary/40 shadow-primary/5' : 'border-base-300'
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate text-sm" title={item.scriptName}>
                  {item.scriptName}
                </div>
                <div className="text-[11px] opacity-60 truncate mt-0.5 flex items-center gap-1.5" title={`${getRepoFolderName(item.repoPath)} • ${item.branchRef}`}>
                  <span className="font-medium text-base-content/80 truncate max-w-[120px]">{getRepoFolderName(item.repoPath)}</span>
                  <span>•</span>
                  <span className="truncate">{item.branchRef}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={cn(
                    'badge badge-xs font-medium',
                    isRunning
                      ? 'badge-info animate-pulse'
                      : item.status === 'completed'
                        ? 'badge-success'
                        : item.status === 'failed'
                          ? 'badge-error'
                          : item.status === 'canceled'
                            ? 'badge-warning'
                            : 'badge-ghost'
                  )}
                >
                  {isRunning && <span className="loading loading-spinner loading-xs mr-1 scale-75"></span>}
                  {item.status}
                </span>

                {!isRunning && (
                  <button
                    className="btn btn-ghost btn-xs btn-circle text-base-content/60 hover:text-base-content"
                    onClick={() => dismissExecution(item.id)}
                    title="Dismiss"
                    aria-label="Dismiss"
                  >
                    <i className="iconoir-xmark text-[14px]" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-base-200">
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1 font-normal text-xs"
                onClick={() => openModal(item.id)}
                title="View terminal logs"
              >
                <i className="iconoir-open-new-window text-[13px]" aria-hidden="true" />
                View Logs
              </button>

              <div className="flex items-center gap-1">
                {isRunning && (
                  <>
                    {item.isCanceling ? (
                      <button
                        type="button"
                        className="btn btn-error btn-xs"
                        onClick={() => void cancelScript(item.id, true)}
                        title="Force kill process immediately"
                      >
                        <span className="loading loading-spinner loading-xs mr-1 scale-75"></span>
                        Force Kill
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-warning btn-xs gap-1"
                        onClick={() => void cancelScript(item.id, false)}
                        title="Stop process"
                      >
                        <i className="iconoir-square text-[11px]" aria-hidden="true" />
                        Stop
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
