// Service name for keytar storage
const SERVICE_NAME = 'trident-git-credentials';

// Credential types
export type CredentialType = 'github' | 'gitlab';

export interface BaseCredential {
  id: string;
  type: CredentialType;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubCredential extends BaseCredential {
  type: 'github';
}

export interface GitLabCredential extends BaseCredential {
  type: 'gitlab';
  serverUrl: string;
}

export type Credential = GitHubCredential | GitLabCredential;

// Metadata stored in local JSON (without sensitive token)
export interface CredentialMetadata {
  id: string;
  type: CredentialType;
  username: string;
  serverUrl?: string; // Only for GitLab
  createdAt: string;
  updatedAt: string;
}

import fs from 'fs';
import path from 'path';
import { getAppDataDir } from './platform-utils';

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytarPromise: Promise<KeytarModule | null> | null = null;
let keytarUnavailableReason: string | null = null;
let didLogKeytarWarning = false;

function keytarUnavailableMessage() {
  if (keytarUnavailableReason) {
    return `Secure credential storage is unavailable: ${keytarUnavailableReason}`;
  }
  return 'Secure credential storage is unavailable in this runtime.';
}

async function loadKeytar(): Promise<KeytarModule | null> {
  if (!keytarPromise) {
    keytarPromise = import('keytar')
      .then((module) => (module.default ?? module) as KeytarModule)
      .catch((error: unknown) => {
        keytarUnavailableReason = error instanceof Error ? error.message : String(error);
        if (!didLogKeytarWarning) {
          didLogKeytarWarning = true;
          console.warn(`[credentials] ${keytarUnavailableMessage()}`);
        }
        return null;
      });
  }
  return keytarPromise;
}

async function requireKeytar(): Promise<KeytarModule> {
  const keytar = await loadKeytar();
  if (!keytar) {
    throw new Error(keytarUnavailableMessage());
  }
  return keytar;
}


const DATA_DIR = getAppDataDir();
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

// Cache variable
let _credentialsCache: CredentialMetadata[] | null = null;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getCredentialsMetadata(): CredentialMetadata[] {
  if (_credentialsCache !== null) {
    return [..._credentialsCache];
  }

  if (!fs.existsSync(CREDENTIALS_FILE)) {
    _credentialsCache = [];
    return [];
  }
  try {
    const data = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    _credentialsCache = JSON.parse(data);
    return [..._credentialsCache!];
  } catch (error) {
    console.error('Failed to parse credentials.json', error);
    _credentialsCache = [];
    return [];
  }
}

function saveCredentialsMetadata(credentials: CredentialMetadata[]): void {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  _credentialsCache = [...credentials];
}

// Generate a unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Get account name for keytar (unique per credential)
function getKeytarAccount(id: string): string {
  return `credential-${id}`;
}

// GitHub API to verify token and get username
export async function verifyGitHubToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, error: 'Invalid or expired token' };
      }
      return { valid: false, error: `GitHub API error: ${response.status}` };
    }

    const data = await response.json();
    return { valid: true, username: data.login };
  } catch (error) {
    return { valid: false, error: `Failed to connect to GitHub: ${(error as Error).message}` };
  }
}

// GitLab API to verify token and get username
export async function verifyGitLabToken(serverUrl: string, token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    // Normalize server URL
    const baseUrl = serverUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/v4/user`, {
      headers: {
        'PRIVATE-TOKEN': token,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, error: 'Invalid or expired token' };
      }
      return { valid: false, error: `GitLab API error: ${response.status}` };
    }

    const data = await response.json();
    return { valid: true, username: data.username };
  } catch (error) {
    return { valid: false, error: `Failed to connect to GitLab server: ${(error as Error).message}` };
  }
}

// CRUD Operations

export async function getAllCredentials(): Promise<Credential[]> {
  const metadata = getCredentialsMetadata();
  return metadata.map((m) => {
    if (m.type === 'gitlab') {
      return {
        id: m.id,
        type: 'gitlab' as const,
        username: m.username,
        serverUrl: m.serverUrl!,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      };
    }
    return {
      id: m.id,
      type: 'github' as const,
      username: m.username,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  });
}

export async function getCredentialById(id: string): Promise<Credential | null> {
  const credentials = await getAllCredentials();
  return credentials.find((c) => c.id === id) || null;
}

export async function getCredentialToken(id: string): Promise<string | null> {
  // A broken native module is a storage failure, not a missing saved token.
  const keytar = await requireKeytar();
  return keytar.getPassword(SERVICE_NAME, getKeytarAccount(id));
}

export async function createGitHubCredential(token: string): Promise<{ success: boolean; credential?: GitHubCredential; error?: string }> {
  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  // Verify token first
  const verification = await verifyGitHubToken(token);
  if (!verification.valid || !verification.username) {
    return { success: false, error: verification.error || 'Failed to verify token' };
  }

  // Check if GitHub credential already exists
  const existing = getCredentialsMetadata();
  const existingGitHub = existing.find((c) => c.type === 'github' && c.username === verification.username);
  if (existingGitHub) {
    return { success: false, error: `A GitHub credential for ${verification.username} already exists. Please update or delete it first.` };
  }

  const id = generateId();
  const now = new Date().toISOString();

  // Store token securely
  await keytar.setPassword(SERVICE_NAME, getKeytarAccount(id), token);

  // Store metadata
  const metadata: CredentialMetadata = {
    id,
    type: 'github',
    username: verification.username,
    createdAt: now,
    updatedAt: now,
  };

  existing.push(metadata);
  saveCredentialsMetadata(existing);

  return {
    success: true,
    credential: {
      id,
      type: 'github',
      username: verification.username,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function createGitLabCredential(serverUrl: string, token: string): Promise<{ success: boolean; credential?: GitLabCredential; error?: string }> {
  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  // Normalize server URL
  const normalizedUrl = serverUrl.replace(/\/$/, '');

  // Verify token first
  const verification = await verifyGitLabToken(normalizedUrl, token);
  if (!verification.valid || !verification.username) {
    return { success: false, error: verification.error || 'Failed to verify token' };
  }

  // Check if GitLab credential for this server already exists
  const existing = getCredentialsMetadata();
  const existingGitLab = existing.find((c) => c.type === 'gitlab' && c.serverUrl === normalizedUrl && c.username === verification.username);
  if (existingGitLab) {
    return { success: false, error: `A GitLab credential for ${verification.username} on ${normalizedUrl} already exists. Please update or delete it first.` };
  }

  const id = generateId();
  const now = new Date().toISOString();

  // Store token securely
  await keytar.setPassword(SERVICE_NAME, getKeytarAccount(id), token);

  // Store metadata
  const metadata: CredentialMetadata = {
    id,
    type: 'gitlab',
    username: verification.username,
    serverUrl: normalizedUrl,
    createdAt: now,
    updatedAt: now,
  };

  existing.push(metadata);
  saveCredentialsMetadata(existing);

  return {
    success: true,
    credential: {
      id,
      type: 'gitlab',
      username: verification.username,
      serverUrl: normalizedUrl,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function updateCredential(id: string, token: string): Promise<{ success: boolean; credential?: Credential; error?: string }> {
  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  const metadata = getCredentialsMetadata();
  const index = metadata.findIndex((c) => c.id === id);

  if (index === -1) {
    return { success: false, error: 'Credential not found' };
  }

  const existing = metadata[index];

  // Verify the new token
  let verification;
  if (existing.type === 'github') {
    verification = await verifyGitHubToken(token);
  } else {
    verification = await verifyGitLabToken(existing.serverUrl!, token);
  }

  if (!verification.valid || !verification.username) {
    return { success: false, error: verification.error || 'Failed to verify token' };
  }

  // Update token in keytar
  await keytar.setPassword(SERVICE_NAME, getKeytarAccount(id), token);

  // Update metadata
  const now = new Date().toISOString();
  metadata[index] = {
    ...existing,
    username: verification.username,
    updatedAt: now,
  };
  saveCredentialsMetadata(metadata);

  if (existing.type === 'gitlab') {
    return {
      success: true,
      credential: {
        id,
        type: 'gitlab',
        username: verification.username,
        serverUrl: existing.serverUrl!,
        createdAt: existing.createdAt,
        updatedAt: now,
      },
    };
  }

  return {
    success: true,
    credential: {
      id,
      type: 'github',
      username: verification.username,
      createdAt: existing.createdAt,
      updatedAt: now,
    },
  };
}

export async function deleteCredential(id: string): Promise<{ success: boolean; error?: string }> {
  const metadata = getCredentialsMetadata();
  const index = metadata.findIndex((c) => c.id === id);

  if (index === -1) {
    return { success: false, error: 'Credential not found' };
  }

  // Delete from keytar when secure storage is available.
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE_NAME, getKeytarAccount(id));
  }

  // Remove from metadata
  metadata.splice(index, 1);
  saveCredentialsMetadata(metadata);

  return { success: true };
}

// Helper to find credential for a remote URL
export async function findCredentialForRemote(remoteUrl: string): Promise<{ credential: Credential; token: string } | null> {
  const credentials = await getAllCredentials();

  // Check if it's a GitHub URL
  if (remoteUrl.includes('github.com')) {
    const githubCred = credentials.find((c) => c.type === 'github');
    if (githubCred) {
      const token = await getCredentialToken(githubCred.id);
      if (token) {
        return { credential: githubCred, token };
      }
    }
  }

  // Check GitLab servers
  for (const cred of credentials) {
    if (cred.type === 'gitlab') {
      // Extract host from remote URL
      let host: string;
      try {
        if (remoteUrl.startsWith('git@')) {
          // SSH URL: git@gitlab.com:user/repo.git
          host = remoteUrl.split('@')[1].split(':')[0];
        } else {
          // HTTP URL
          host = new URL(remoteUrl).host;
        }
      } catch {
        continue;
      }

      // Check if the credential's server URL matches
      const credHost = new URL(cred.serverUrl).host;
      if (host === credHost) {
        const token = await getCredentialToken(cred.id);
        if (token) {
          return { credential: cred, token };
        }
      }
    }
  }

  return null;
}
