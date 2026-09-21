'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/toaster';
import { CommandPalette } from '@/components/command-palette';
import { CustomScriptExecutionProvider } from '@/contexts/custom-script-execution-context';
import { ScriptDock } from '@/components/git/script-dock';
import { ScriptModal } from '@/components/git/script-modal';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
        <CustomScriptExecutionProvider>
          {children}
          <CommandPalette />
          <Toaster />
          <ScriptDock />
          <ScriptModal />
        </CustomScriptExecutionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
