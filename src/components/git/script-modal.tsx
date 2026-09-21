'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useCustomScriptExecution } from '@/contexts/custom-script-execution-context';
import { cn } from '@/lib/utils';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

export function ScriptModal() {
  const { activeModalExecution, minimizeModal, cancelScript, dismissExecution } = useCustomScriptExecution();
  const [didCopy, setDidCopy] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const outputPreRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom of terminal output
  useEffect(() => {
    if (outputPreRef.current) {
      outputPreRef.current.scrollTop = outputPreRef.current.scrollHeight;
    }
  }, [activeModalExecution?.output]);

  // Handle Escape key to minimize
  useEffect(() => {
    if (!activeModalExecution) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        minimizeModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModalExecution, minimizeModal]);

  const handleCopy = useCallback(async () => {
    if (!activeModalExecution || isCopying) return;
    setIsCopying(true);
    const copied = await copyText(activeModalExecution.output);
    setIsCopying(false);
    setDidCopy(copied);
    if (copied) {
      setTimeout(() => setDidCopy(false), 1500);
    }
  }, [activeModalExecution, isCopying]);

  if (!activeModalExecution) return null;

  const isRunning = activeModalExecution.status === 'starting' || activeModalExecution.status === 'running';
  const isFinished = activeModalExecution.status === 'completed' || activeModalExecution.status === 'failed' || activeModalExecution.status === 'canceled';

  return (
    <dialog className="modal modal-open z-50">
      <div className="modal-box max-w-4xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-lg truncate">Custom Script: {activeModalExecution.scriptName}</h3>
            <p className="text-xs opacity-70 mt-1 break-all">
              Ref: {activeModalExecution.branchRef}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={cn(
                'badge badge-sm shrink-0',
                isRunning
                  ? 'badge-info'
                  : activeModalExecution.status === 'completed'
                    ? 'badge-success'
                    : activeModalExecution.status === 'failed'
                      ? 'badge-error'
                      : activeModalExecution.status === 'canceled'
                        ? 'badge-warning'
                        : 'badge-ghost'
              )}
            >
              {isRunning && <span className="loading loading-spinner loading-xs mr-1"></span>}
              {activeModalExecution.status}
            </span>
            <button
              className="btn btn-ghost btn-xs btn-circle"
              onClick={minimizeModal}
              title="Minimize to bottom-right corner"
              aria-label="Minimize"
            >
              <i className="iconoir-minus text-[16px]" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="mt-4 border border-base-300 rounded bg-base-200/40 flex-1 overflow-hidden flex flex-col">
          <pre
            ref={outputPreRef}
            className="p-3 font-mono text-xs overflow-auto max-h-[50vh] whitespace-pre-wrap break-words flex-1"
          >
            {activeModalExecution.output || 'Waiting for output...'}
          </pre>
        </div>

        {activeModalExecution.error && (
          <div className="alert alert-error py-2 mt-3 text-xs">
            <span>{activeModalExecution.error}</span>
          </div>
        )}

        <div className="modal-action mt-4 flex items-center justify-between">
          <button
            type="button"
            className="btn btn-ghost btn-sm gap-1.5"
            onClick={minimizeModal}
            title="Minimize dialog and keep running in bottom right"
          >
            <i className="iconoir-minus text-[14px]" aria-hidden="true" />
            Dock / Minimize
          </button>

          <div className="flex items-center gap-2">
            {isRunning && (
              <>
                {activeModalExecution.isCanceling ? (
                  <button
                    type="button"
                    className="btn btn-error btn-sm"
                    onClick={() => void cancelScript(activeModalExecution.id, true)}
                    title="Force terminate immediately"
                  >
                    <span className="loading loading-spinner loading-xs mr-1"></span>
                    Force Kill
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-warning btn-sm"
                    onClick={() => void cancelScript(activeModalExecution.id, false)}
                  >
                    Cancel
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void handleCopy()}
              disabled={isCopying}
            >
              {isCopying && <span className="loading loading-spinner loading-xs mr-1"></span>}
              {didCopy ? 'Copied' : 'Copy'}
            </button>

            {isFinished ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  dismissExecution(activeModalExecution.id);
                }}
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-neutral btn-sm"
                onClick={minimizeModal}
              >
                Hide
              </button>
            )}
          </div>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            minimizeModal();
          }}
        >
          close
        </button>
      </form>
    </dialog>
  );
}
