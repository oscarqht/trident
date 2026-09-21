'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';
import type { EmojiClickData } from 'emoji-picker-react';
import { Theme, EmojiStyle } from 'emoji-picker-react';

// Dynamic import with SSR disabled to prevent hydration mismatch and window reference errors
const EmojiPicker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col items-center justify-center h-[380px] w-full gap-2 text-sm text-base-content/60">
      <span className="loading loading-spinner loading-md text-primary" />
      <span>Loading emoji picker...</span>
    </div>
  ),
});

const PRESET_EMOJIS = [
  '🚀', '⚡', '📦', '💻', '🛠️', '🔥', '🤖', '🌐',
  '🎨', '📱', '🧪', '✨', '🔒', '📚', '🎯', '💡',
];

interface RepoEmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

export function RepoEmojiPicker({
  value,
  onChange,
  onClear,
  disabled = false,
}: RepoEmojiPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const pickerTheme = useMemo(() => {
    return resolvedTheme === 'dark' ? Theme.DARK : Theme.LIGHT;
  }, [resolvedTheme]);

  // Close on outside click and Escape
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onChange(emojiData.emoji);
    setIsOpen(false);
  };

  const handlePickRandom = () => {
    if (disabled) return;
    const candidates = PRESET_EMOJIS.filter((e) => e !== value);
    const random = candidates[Math.floor(Math.random() * candidates.length)];
    onChange(random);
  };

  return (
    <div className="relative inline-block w-full">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        {/* Main interactive Icon Avatar / Button */}
        <div className="relative group shrink-0">
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            onClick={() => setIsOpen((prev) => !prev)}
            title={value ? 'Click to change emoji' : 'Click to choose an emoji'}
            className={`
              w-16 h-16 rounded-2xl flex items-center justify-center text-3xl
              transition-all duration-150 select-none cursor-pointer
              border shadow-xs
              ${
                value
                  ? 'bg-base-200/60 hover:bg-base-200 border-base-300 hover:border-primary/50 hover:shadow-md'
                  : 'bg-base-200/30 hover:bg-base-200/70 border-dashed border-base-300 hover:border-primary text-base-content/40'
              }
              focus:outline-hidden focus:ring-2 focus:ring-primary/40 focus:border-primary
              ${isOpen ? 'ring-2 ring-primary/40 border-primary' : ''}
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {value ? (
              <span className="leading-none transform group-hover:scale-110 transition-transform duration-150">
                {value}
              </span>
            ) : (
              <i className="iconoir-emoji text-2xl transform group-hover:scale-110 transition-transform duration-150" />
            )}
          </button>

          {/* Badge indicator on bottom corner */}
          <div
            className={`
              absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-base-100 border border-base-300 shadow-xs
              flex items-center justify-center text-xs pointer-events-none text-base-content/70
              group-hover:text-primary group-hover:border-primary/50 transition-colors
            `}
          >
            <i className="iconoir-edit-pencil text-[12px]" />
          </div>
        </div>

        {/* Action controls & quick presets */}
        <div className="flex flex-col gap-2.5 flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setIsOpen((prev) => !prev)}
              className="btn btn-sm btn-outline gap-1.5"
            >
              <i className="iconoir-emoji text-[16px]" />
              <span>{value ? 'Change Emoji' : 'Choose Emoji'}</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={handlePickRandom}
              className="btn btn-sm btn-ghost gap-1.5"
              title="Pick a random emoji"
            >
              <span className="text-base leading-none">🎲</span>
              <span className="hidden sm:inline text-xs">Random</span>
            </button>

            {value && (
              <button
                type="button"
                disabled={disabled}
                onClick={onClear}
                className="btn btn-sm btn-ghost text-error/80 hover:text-error gap-1"
                title="Remove current icon"
              >
                <i className="iconoir-trash text-[15px]" />
                <span className="text-xs">Remove</span>
              </button>
            )}

            {/* Quick manual input */}
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-xs text-base-content/50">Custom:</span>
              <input
                type="text"
                disabled={disabled}
                placeholder="Paste"
                value={value}
                onChange={(e) => {
                  const chars = Array.from(e.target.value);
                  onChange(chars.slice(-1).join(''));
                }}
                className="input input-bordered input-xs w-16 text-center text-sm rounded-md"
                title="Directly type or paste an emoji character"
              />
            </div>
          </div>

          {/* Quick preset emojis */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-base-content/50 mr-1 select-none">Quick pick:</span>
            {PRESET_EMOJIS.slice(0, 10).map((emoji) => {
              const isSelected = value === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(emoji)}
                  className={`
                    w-7 h-7 rounded-lg text-sm flex items-center justify-center cursor-pointer
                    transition-all duration-100 hover:scale-115 active:scale-95
                    ${
                      isSelected
                        ? 'bg-primary/20 ring-1 ring-primary shadow-xs font-bold'
                        : 'bg-base-200/60 hover:bg-base-200'
                    }
                  `}
                  title={`Select ${emoji}`}
                >
                  <span className="leading-none">{emoji}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Popover containing web-based emoji picker */}
      {isOpen && (
        <div
          ref={popoverRef}
          className={`
            absolute left-0 mt-3 z-50
            rounded-2xl shadow-2xl border border-base-300 bg-base-100
            overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150
          `}
          style={{ width: 'min(380px, 92vw)' }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-base-200 flex items-center justify-between bg-base-200/40">
            <div className="flex items-center gap-2">
              <span className="text-lg">✨</span>
              <span className="font-semibold text-sm">Select Repository Icon</span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-base-content"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Emoji Picker Component */}
          <div className="p-1 [&_.epr-main]:!border-none [&_.epr-main]:!bg-transparent">
            <EmojiPicker
              onEmojiClick={handleEmojiClick}
              theme={pickerTheme}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis={true}
              searchPlaceHolder="Search emoji by name or keyword..."
              width="100%"
              height={380}
              previewConfig={{
                showPreview: false,
              }}
              skinTonesDisabled={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}
