'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { FileSystemBrowser } from '@/components/fs-browser';
import { DesktopSettingsSection } from '@/components/desktop-settings-section';
import { ThemeToggle } from '@/components/theme-toggle';

interface Settings {
  defaultRootFolder: string | null;
  resolvedDefaultFolder: string;
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [localDefaultFolder, setLocalDefaultFolder] = useState<string>('');
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    setMounted(true);
    loadSettings();
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

  const handleSave = async () => {
    setIsSaving(true);
    setSavedSuccess(false);
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
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 3000);
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

  return (
    <div className="min-h-screen bg-base-200/50">
      {/* Header */}
      <header className="border-b border-base-300 bg-base-100 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="btn btn-ghost btn-sm btn-square"
              title="Back to repositories"
            >
              <i className="iconoir-arrow-left text-lg" aria-hidden="true" />
            </Link>
            <h1 className="text-base font-semibold">Settings</h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <span className="loading loading-spinner loading-md"></span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Color Theme */}
            <div className="border border-base-300 rounded-lg p-5 bg-base-100">
              <h2 className="text-sm font-semibold text-base-content">Appearance</h2>
              <p className="text-xs text-base-content/60 mt-0.5 mb-4">
                Choose your preferred color theme for the application.
              </p>
              <div className="flex gap-2 max-w-md">
                <button
                  type="button"
                  className={`btn btn-sm flex-1 text-xs gap-1.5 ${theme === 'system' ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                  onClick={() => setTheme('system')}
                  disabled={!mounted}
                >
                  <i className="iconoir-computer text-[15px]" aria-hidden="true" />
                  System
                </button>
                <button
                  type="button"
                  className={`btn btn-sm flex-1 text-xs gap-1.5 ${theme === 'light' ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                  onClick={() => setTheme('light')}
                  disabled={!mounted}
                >
                  <i className="iconoir-sun-light text-[15px]" aria-hidden="true" />
                  Light
                </button>
                <button
                  type="button"
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
            <div className="border border-base-300 rounded-lg p-5 bg-base-100">
              <h2 className="text-sm font-semibold text-base-content">Default Root Folder</h2>
              <p className="text-xs text-base-content/60 mt-0.5 mb-4">
                The starting folder when browsing for new repositories. Leave empty to use your home folder.
              </p>
              <div className="form-control w-full max-w-lg">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={settings?.resolvedDefaultFolder || 'User home folder'}
                    className="input input-sm input-bordered w-full font-mono text-xs"
                    value={localDefaultFolder}
                    onChange={(e) => setLocalDefaultFolder(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost border border-base-300 btn-square"
                    onClick={() => setFolderBrowserOpen(true)}
                    title="Browse folders"
                  >
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
                <div className="flex items-center gap-3 mt-4 pt-3 border-t border-base-200">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleSave}
                    disabled={isSaving}
                  >
                    {isSaving && <span className="loading loading-spinner loading-xs" />}
                    Save Folder Settings
                  </button>
                  {savedSuccess && (
                    <span className="text-xs text-success flex items-center gap-1 font-medium">
                      <i className="iconoir-check text-[14px]" aria-hidden="true" />
                      Saved
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Desktop Preferences (Full Disk Access & Launch at Login) */}
            <DesktopSettingsSection cardVariant />
          </div>
        )}
      </main>

      <FileSystemBrowser
        open={folderBrowserOpen}
        onOpenChange={setFolderBrowserOpen}
        onSelect={handleFolderSelect}
        initialPath={localDefaultFolder || settings?.resolvedDefaultFolder}
        title="Select default root folder"
      />
    </div>
  );
}
