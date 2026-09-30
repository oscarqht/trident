'use client';

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { FileSystemBrowser } from './fs-browser';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

interface Settings {
  defaultRootFolder: string | null;
  resolvedDefaultFolder: string;
}

interface HomeSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsChange?: (settings: Settings) => void;
}

export function HomeSettingsModal({ open, onOpenChange, onSettingsChange }: HomeSettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [localDefaultFolder, setLocalDefaultFolder] = useState<string>('');

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setLocalDefaultFolder(data.defaultRootFolder || '');
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  useEscapeDismiss(open, () => onOpenChange(false), () => {
    if (isSaving || isLoading) {
      return;
    }
    void handleSave();
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultRootFolder: localDefaultFolder.trim() || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        onSettingsChange?.(data);
        onOpenChange(false);
      }
    } catch (e) {
      console.error('Failed to save settings:', e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleFolderSelect = (path: string) => {
    setLocalDefaultFolder(path);
  };

  const handleReset = () => {
    setLocalDefaultFolder('');
  };

  if (!open) return null;

  return (
    <>
      <dialog className="modal modal-open">
        <div className="modal-box max-w-lg p-6 border border-base-300 rounded-xl shadow-xl bg-base-100">
          <h3 className="font-bold text-lg text-base-content">Settings</h3>
          <p className="text-xs text-base-content/60 mt-1 mb-5">Configure your application preferences.</p>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <span className="loading loading-spinner loading-md"></span>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Theme Selection */}
              <div className="form-control w-full">
                <label className="label pt-0 pb-1">
                  <span className="label-text text-xs font-medium">Color Theme</span>
                </label>
                <div className="text-xs text-base-content/60 mb-2.5">
                  Choose your preferred color theme for the application.
                </div>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-sm flex-1 text-xs gap-1.5 ${theme === 'system' ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                    onClick={() => setTheme('system')}
                    disabled={!mounted}
                  >
                    <i className="iconoir-computer text-[15px]" aria-hidden="true" />
                    System
                  </button>
                  <button
                    className={`btn btn-sm flex-1 text-xs gap-1.5 ${theme === 'light' ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                    onClick={() => setTheme('light')}
                    disabled={!mounted}
                  >
                    <i className="iconoir-sun-light text-[15px]" aria-hidden="true" />
                    Light
                  </button>
                  <button
                    className={`btn btn-sm flex-1 text-xs gap-1.5 ${theme === 'dark' ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                    onClick={() => setTheme('dark')}
                    disabled={!mounted}
                  >
                    <i className="iconoir-moon-sat text-[15px]" aria-hidden="true" />
                    Dark
                  </button>
                </div>
              </div>

              {/* Default Root Folder */}
              <div className="form-control w-full">
                <label className="label pt-0 pb-1">
                  <span className="label-text text-xs font-medium">Default Root Folder</span>
                </label>
                <div className="text-xs text-base-content/60 mb-2.5">
                  The starting folder when browsing for new repositories. Leave empty to use your home folder.
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={settings?.resolvedDefaultFolder || 'User home folder'}
                    className="input input-sm input-bordered w-full font-mono text-xs"
                    value={localDefaultFolder}
                    onChange={(e) => setLocalDefaultFolder(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-sm btn-ghost border border-base-300 btn-square" onClick={() => setFolderBrowserOpen(true)} title="Browse folders">
                    <i className="iconoir-folder text-[16px]" aria-hidden="true" />
                  </button>
                </div>
                {localDefaultFolder && (
                  <div className="mt-2">
                    <button type="button" className="link link-hover text-primary text-xs" onClick={handleReset}>
                      Reset to default (home folder)
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="modal-action pt-3 border-t border-base-200 mt-6">
             <button className="btn btn-sm btn-ghost" onClick={() => onOpenChange(false)}>Close</button>
             <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={isSaving || isLoading}>
               {isSaving && <span className="loading loading-spinner loading-xs"></span>}
               Save Folder Settings
             </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
            <button onClick={() => onOpenChange(false)}>close</button>
        </form>
      </dialog>

      <FileSystemBrowser
        open={folderBrowserOpen}
        onOpenChange={setFolderBrowserOpen}
        onSelect={handleFolderSelect}
        initialPath={localDefaultFolder || settings?.resolvedDefaultFolder}
        title="Select default root folder"
      />
    </>
  );
}
