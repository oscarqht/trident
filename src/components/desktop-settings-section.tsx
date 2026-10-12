'use client';

import { useState, useEffect, useCallback } from 'react';

export interface DesktopStatus {
  platform: string;
  fullDiskAccessGranted: boolean;
  autostartEnabled: boolean;
}

interface DesktopSettingsSectionProps {
  className?: string;
  cardVariant?: boolean;
}

export function DesktopSettingsSection({ className = '', cardVariant = false }: DesktopSettingsSectionProps) {
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTogglingAutostart, setIsTogglingAutostart] = useState(false);
  const [isOpeningFda, setIsOpeningFda] = useState(false);

  const loadDesktopStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/desktop');
      if (res.ok) {
        const data = await res.json();
        setDesktop(data);
      }
    } catch (e) {
      console.error('Failed to load desktop status:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDesktopStatus();

    const onFocus = () => {
      loadDesktopStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadDesktopStatus]);

  const handleToggleAutostart = async () => {
    if (isTogglingAutostart) return;
    setIsTogglingAutostart(true);
    try {
      const res = await fetch('/api/settings/desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle-autostart' }),
      });
      if (res.ok) {
        const data = await res.json();
        setDesktop(data);
      }
    } catch (e) {
      console.error('Failed to toggle autostart:', e);
    } finally {
      setIsTogglingAutostart(false);
    }
  };

  const handleGrantFullDiskAccess = async () => {
    if (isOpeningFda) return;
    setIsOpeningFda(true);
    try {
      const res = await fetch('/api/settings/desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open-full-disk-access' }),
      });
      if (res.ok) {
        const data = await res.json();
        setDesktop(data);
      }
    } catch (e) {
      console.error('Failed to open full disk access settings:', e);
    } finally {
      setIsOpeningFda(false);
    }
  };

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center py-4 ${className}`}>
        <span className="loading loading-spinner loading-xs text-base-content/50"></span>
      </div>
    );
  }

  const content = (
    <div className="space-y-4">
      {/* Full Disk Access (macOS only) */}
      {desktop?.platform === 'darwin' && (
        <div className="form-control w-full">
          <label className="label pt-0 pb-1">
            <span className="label-text text-xs font-medium">Full Disk Access</span>
          </label>
          <div className="text-xs text-base-content/60 mb-2">
            Grant Full Disk Access to avoid folder permission prompts when inspecting repositories.
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg border border-base-300 bg-base-200/40">
            <div className="flex items-center gap-2.5 min-w-0">
              <i className="iconoir-shield-check text-[18px] text-base-content/70 shrink-0" aria-hidden="true" />
              <span className="text-xs font-medium">
                {desktop.fullDiskAccessGranted ? 'Full Disk Access Enabled' : 'Access Not Granted'}
              </span>
            </div>
            {desktop.fullDiskAccessGranted ? (
              <span className="badge badge-sm badge-success gap-1 text-[11px] font-medium py-2 px-2.5">
                <i className="iconoir-check text-[12px]" aria-hidden="true" />
                Enabled
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-xs btn-primary gap-1"
                onClick={handleGrantFullDiskAccess}
                disabled={isOpeningFda}
              >
                {isOpeningFda && <span className="loading loading-spinner loading-xs" />}
                Grant Full Disk Access...
              </button>
            )}
          </div>
        </div>
      )}

      {/* Launch at Login */}
      <div className="form-control w-full">
        <div className="flex items-center justify-between p-3 rounded-lg border border-base-300 bg-base-200/40">
          <div>
            <div className="flex items-center gap-2">
              <i className="iconoir-log-in text-[17px] text-base-content/70 shrink-0" aria-hidden="true" />
              <span className="text-xs font-medium">Launch at Login</span>
            </div>
            <div className="text-xs text-base-content/60 mt-0.5 ml-6">
              Automatically start Trident when you log in to your computer.
            </div>
          </div>
          <div className="flex items-center gap-2 pl-3">
            {isTogglingAutostart ? (
              <span className="loading loading-spinner loading-xs text-primary" />
            ) : (
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-primary"
                checked={desktop?.autostartEnabled ?? false}
                onChange={handleToggleAutostart}
                disabled={isTogglingAutostart}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (cardVariant) {
    return (
      <div className={`border border-base-300 rounded-lg p-5 bg-base-100 ${className}`}>
        <h2 className="text-sm font-semibold text-base-content">Desktop Preferences</h2>
        <p className="text-xs text-base-content/60 mt-0.5 mb-4">
          Configure application system permissions and startup behavior.
        </p>
        {content}
      </div>
    );
  }

  return <div className={className}>{content}</div>;
}
