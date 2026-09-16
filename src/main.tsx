import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import HomePage from './app/page';
import CredentialsPage from './app/credentials/page';
import WorkspaceLayout from './app/workspace/layout';
import WorkspacePage from './app/workspace/page';
import ChangesPage from './app/workspace/changes/page';
import ConflictsPage from './app/workspace/conflicts/page';
import HistoryPage from './app/workspace/history/page';
import StashesPage from './app/workspace/stashes/page';
import SettingsPage from './app/workspace/settings/page';
import CustomScriptsPage from './app/workspace/custom-scripts/page';
import { Providers } from './app/providers';
import './app/globals.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BrowserRouter>
        <Providers>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/workspace" element={<WorkspaceLayout />}>
              <Route index element={<WorkspacePage />} />
              <Route path="changes" element={<ChangesPage />} />
              <Route path="conflicts" element={<ConflictsPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="stashes" element={<StashesPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="custom-scripts" element={<CustomScriptsPage />} />
            </Route>
          </Routes>
        </Providers>
      </BrowserRouter>
    </React.StrictMode>
  );
}
