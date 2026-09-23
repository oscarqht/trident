'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RepositoryCustomScript } from '@/lib/types';

export type ScriptExecutionStatus = 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'canceled';

export interface ScriptExecutionItem {
  id: string;
  repoPath: string;
  branchRef: string;
  scriptName: string;
  scriptContent: string;
  status: ScriptExecutionStatus;
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  isCanceling: boolean;
  isForceCanceling: boolean;
  isModalOpen: boolean;
  dismissOnStop?: boolean;
}

interface CustomScriptExecutionContextType {
  executions: ScriptExecutionItem[];
  activeModalExecution: ScriptExecutionItem | null;
  startScript: (params: { repoPath: string; branchRef: string; script: RepositoryCustomScript }) => Promise<string>;
  cancelScript: (executionId: string, force?: boolean, autoDismiss?: boolean) => Promise<void>;
  openModal: (executionId: string) => void;
  minimizeModal: () => void;
  dismissExecution: (executionId: string) => void;
}

const CustomScriptExecutionContext = createContext<CustomScriptExecutionContextType | null>(null);

export function CustomScriptExecutionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [executions, setExecutions] = useState<ScriptExecutionItem[]>([]);
  const executionsRef = useRef(executions);
  executionsRef.current = executions;

  // Load active and undismissed executions from server on initial mount / reload
  useEffect(() => {
    let isMounted = true;

    async function loadInitialExecutions() {
      try {
        const res = await fetch('/api/custom-scripts');
        if (!res.ok) return;
        const data = await res.json();
        if (!isMounted || !data.success || !Array.isArray(data.executions)) return;

        const serverExecutions: ScriptExecutionItem[] = data.executions.map((e: {
          executionId: string;
          repoPath: string;
          branchRef: string;
          scriptName: string;
          status: ScriptExecutionStatus;
          output?: string;
          startedAt: string;
          finishedAt?: string | null;
        }) => ({
          id: e.executionId,
          repoPath: e.repoPath,
          branchRef: e.branchRef,
          scriptName: e.scriptName,
          scriptContent: '',
          status: e.status,
          output: e.output || '',
          error: null,
          startedAt: e.startedAt,
          finishedAt: e.finishedAt || null,
          isCanceling: false,
          isForceCanceling: false,
          isModalOpen: false, // Default to docked card on reload
        }));

        setExecutions((prev) => {
          const localOnly = prev.filter((item) => item.id.startsWith('temp-'));
          const existingMap = new Map(prev.map((item) => [item.id, item]));
          const merged = serverExecutions.map((se) => {
            const local = existingMap.get(se.id);
            if (local) {
              return {
                ...se,
                isModalOpen: local.isModalOpen,
                isCanceling: local.isCanceling,
                isForceCanceling: local.isForceCanceling,
                dismissOnStop: local.dismissOnStop,
              };
            }
            return se;
          });
          return [...localOnly, ...merged];
        });
      } catch {
        // Ignore fetch errors during initial load
      }
    }

    void loadInitialExecutions();

    return () => {
      isMounted = false;
    };
  }, []);

  const startScript = useCallback(async ({
    repoPath,
    branchRef,
    script,
  }: {
    repoPath: string;
    branchRef: string;
    script: RepositoryCustomScript;
  }): Promise<string> => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newExecution: ScriptExecutionItem = {
      id: tempId,
      repoPath,
      branchRef,
      scriptName: script.name,
      scriptContent: script.content,
      status: 'starting',
      output: '',
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      isCanceling: false,
      isForceCanceling: false,
      isModalOpen: true,
    };

    // Close any currently open modal so the newly launched one takes focus
    setExecutions((prev) => [
      ...prev.map((item) => (item.isModalOpen ? { ...item, isModalOpen: false } : item)),
      newExecution,
    ]);

    try {
      const response = await fetch('/api/custom-scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'start',
          repoPath,
          branchRef,
          scriptName: script.name,
          scriptContent: script.content,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to start script execution');
      }

      const prelude: string[] = [];
      if (result.previousBranch && result.checkedOutBranch && result.previousBranch !== result.checkedOutBranch) {
        prelude.push(`[info] Checked out ${result.checkedOutBranch} (from ${result.previousBranch})`);
      }

      setExecutions((prev) =>
        prev.map((item) => {
          if (item.id === tempId) {
            return {
              ...item,
              id: result.executionId,
              output: [prelude.join('\n'), result.output].filter(Boolean).join('\n'),
              status: result.status as ScriptExecutionStatus,
              error: null,
            };
          }
          return item;
        })
      );

      return result.executionId;
    } catch (error) {
      const errorMessage = (error as Error).message || 'Failed to start script';
      setExecutions((prev) =>
        prev.map((item) => {
          if (item.id === tempId) {
            return {
              ...item,
              status: 'failed',
              error: errorMessage,
              output: item.output ? `${item.output}\n[error] ${errorMessage}` : `[error] ${errorMessage}`,
              finishedAt: new Date().toISOString(),
            };
          }
          return item;
        })
      );
      return tempId;
    }
  }, []);

  const dismissExecution = useCallback((executionId: string) => {
    setExecutions((prev) => prev.filter((e) => e.id !== executionId));
    if (!executionId.startsWith('temp-')) {
      void fetch('/api/custom-scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'dismiss',
          executionId,
        }),
      }).catch(() => {
        // ignore errors on dismiss sync
      });
    }
  }, []);

  const cancelScript = useCallback(
    async (executionId: string, force?: boolean, autoDismiss?: boolean) => {
      const item = executionsRef.current.find((e) => e.id === executionId);
      if (!item) return;

      const shouldDismissOnStop = autoDismiss ?? item.dismissOnStop ?? false;

      if (executionId.startsWith('temp-')) {
        dismissExecution(executionId);
        return;
      }

      setExecutions((prev) =>
        prev.map((e) => {
          if (e.id === executionId) {
            return {
              ...e,
              isCanceling: true,
              isForceCanceling: force ? true : e.isForceCanceling,
              dismissOnStop: shouldDismissOnStop,
            };
          }
          return e;
        })
      );

      try {
        const response = await fetch('/api/custom-scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'cancel',
            executionId,
            force: !!force,
          }),
        });

        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to cancel script');
        }

        const nextStatus = result.status as ScriptExecutionStatus;
        const isStopped = nextStatus !== 'running' && nextStatus !== 'starting';

        if (isStopped && shouldDismissOnStop) {
          const currentItem = executionsRef.current.find((e) => e.id === executionId);
          if (!currentItem?.isModalOpen) {
            dismissExecution(executionId);
            queryClient.invalidateQueries({ queryKey: ['git', item.repoPath] });
            return;
          }
        }

        setExecutions((prev) =>
          prev.map((e) => {
            if (e.id === executionId) {
              return {
                ...e,
                output: result.output,
                status: nextStatus,
                isCanceling: nextStatus === 'running' || nextStatus === 'starting',
                isForceCanceling: false,
                finishedAt: result.finishedAt || e.finishedAt,
                dismissOnStop: shouldDismissOnStop,
              };
            }
            return e;
          })
        );

        if (isStopped) {
          queryClient.invalidateQueries({ queryKey: ['git', item.repoPath] });
        } else if (shouldDismissOnStop) {
          // Check quickly after 150ms to dismiss promptly without waiting for the next full poll interval
          setTimeout(async () => {
            const currentItem = executionsRef.current.find((e) => e.id === executionId);
            if (!currentItem || !currentItem.dismissOnStop || currentItem.isModalOpen) return;
            try {
              const res = await fetch('/api/custom-scripts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command: 'status',
                  executionId,
                }),
              });
              const data = await res.json();
              if (res.ok && data.status !== 'running' && data.status !== 'starting') {
                const refreshed = executionsRef.current.find((e) => e.id === executionId);
                if (refreshed?.dismissOnStop && !refreshed?.isModalOpen) {
                  dismissExecution(executionId);
                  queryClient.invalidateQueries({ queryKey: ['git', item.repoPath] });
                }
              }
            } catch {}
          }, 150);
        }
      } catch (error) {
        setExecutions((prev) =>
          prev.map((e) => {
            if (e.id === executionId) {
              return {
                ...e,
                isCanceling: false,
                isForceCanceling: false,
                output: `${e.output}\n[error] ${(error as Error).message}`,
              };
            }
            return e;
          })
        );
      }
    },
    [dismissExecution, queryClient]
  );

  const openModal = useCallback((executionId: string) => {
    setExecutions((prev) =>
      prev.map((e) => ({
        ...e,
        isModalOpen: e.id === executionId,
        dismissOnStop: e.id === executionId ? false : e.dismissOnStop,
      }))
    );
  }, []);

  const minimizeModal = useCallback(() => {
    setExecutions((prev) =>
      prev.map((e) => (e.isModalOpen ? { ...e, isModalOpen: false } : e))
    );
  }, []);

  // Polling loop for running executions
  useEffect(() => {
    const runningExecutions = executions.filter((e) => e.status === 'running' || e.status === 'starting');
    if (runningExecutions.length === 0) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollAll = async () => {
      const currentRunning = executionsRef.current.filter((e) => e.status === 'running' && !e.id.startsWith('temp-'));
      if (currentRunning.length === 0) return;

      await Promise.all(
        currentRunning.map(async (exec) => {
          try {
            const res = await fetch('/api/custom-scripts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                command: 'status',
                executionId: exec.id,
              }),
            });
            const data = await res.json();
            if (!res.ok || disposed) return;

            const nextStatus = data.status as ScriptExecutionStatus;
            const isStopped = nextStatus !== 'running' && nextStatus !== 'starting';

            if (isStopped && exec.dismissOnStop) {
              const currentItem = executionsRef.current.find((e) => e.id === exec.id);
              if (!currentItem?.isModalOpen) {
                dismissExecution(exec.id);
                queryClient.invalidateQueries({ queryKey: ['git', exec.repoPath] });
                return;
              }
            }

            setExecutions((prev) =>
              prev.map((item) => {
                if (item.id === exec.id) {
                  return {
                    ...item,
                    output: data.output,
                    status: nextStatus,
                    finishedAt: data.finishedAt || item.finishedAt,
                    isCanceling: nextStatus === 'running' ? item.isCanceling : false,
                  };
                }
                return item;
              })
            );

            if (isStopped) {
              queryClient.invalidateQueries({ queryKey: ['git', exec.repoPath] });
            }
          } catch {
            // ignore fetch errors during polling
          }
        })
      );

      if (!disposed) {
        timer = setTimeout(pollAll, 500);
      }
    };

    timer = setTimeout(pollAll, 500);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [executions, queryClient, dismissExecution]);

  const activeModalExecution = useMemo(
    () => executions.find((e) => e.isModalOpen) || null,
    [executions]
  );

  return (
    <CustomScriptExecutionContext.Provider
      value={{
        executions,
        activeModalExecution,
        startScript,
        cancelScript,
        openModal,
        minimizeModal,
        dismissExecution,
      }}
    >
      {children}
    </CustomScriptExecutionContext.Provider>
  );
}

export function useCustomScriptExecution() {
  const context = useContext(CustomScriptExecutionContext);
  if (!context) {
    throw new Error('useCustomScriptExecution must be used within a CustomScriptExecutionProvider');
  }
  return context;
}
