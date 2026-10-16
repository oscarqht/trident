export interface GitCredentials {
  username: string;
  token: string;
  serverUrl?: string;
}

/** Resolve the HTTP transport used by a linked PAT without changing the saved remote. */
export function getHttpRemoteUrl(remoteUrl: string, accountHost?: string): string | null {
  if (/^https?:\/\//.test(remoteUrl)) {
    try {
      if (accountHost) {
        const account = new URL(accountHost.includes('://') ? accountHost : `https://${accountHost}`);
        if (new URL(remoteUrl).origin !== account.origin) return null;
      }
      return remoteUrl;
    } catch {
      return null;
    }
  }

  let hostname: string;
  let repoPath: string;
  try {
    if (remoteUrl.startsWith('ssh://')) {
      const ssh = new URL(remoteUrl);
      hostname = ssh.hostname;
      repoPath = ssh.pathname.replace(/^\/+/, '');
    } else {
      const scp = remoteUrl.match(/^[^@/:]+@([^/:]+):(.+)$/);
      if (!scp) return null;
      hostname = scp[1];
      repoPath = scp[2].replace(/^\/+/, '');
    }
    if (!repoPath) return null;
    // SSH ports are unrelated to HTTP ports; use the linked account's web origin.
    const web = new URL(accountHost
      ? (accountHost.includes('://') ? accountHost : `https://${accountHost}`)
      : `https://${hostname}`);
    if (!['http:', 'https:'].includes(web.protocol) || web.hostname.toLowerCase() !== hostname.toLowerCase()) return null;
    return `${web.origin}/${repoPath}`;
  } catch {
    return null;
  }
}

/** Per-operation auth: override stale helpers/headers without saving secrets in Git config. */
export function getGitAuthConfig(remoteUrl: string, credentials: GitCredentials): string[] {
  const httpUrl = getHttpRemoteUrl(remoteUrl, credentials.serverUrl);
  if (!httpUrl) return [];
  const url = new URL(httpUrl);
  url.username = '';
  url.password = '';
  const key = `http.${url.href.replace(/\/$/, '')}.extraheader`;
  const auth = Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64');
  return [
    ...(httpUrl === remoteUrl ? [] : [`url.${httpUrl}.insteadOf=${remoteUrl}`]),
    `${key}=`, `${key}=AUTHORIZATION: basic ${auth}`,
    'credential.helper=', `credential.username=${credentials.username}`,
  ];
}
