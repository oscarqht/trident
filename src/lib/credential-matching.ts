interface RemoteCredential {
  type: 'github' | 'gitlab';
  serverUrl?: string;
}

/** Match actual remote hosts, never hostnames appearing inside a path or username. */
export function matchingCredentialsForRemote<T extends RemoteCredential>(remoteUrl: string, credentials: T[]): T[] {
  let remote: URL;
  let ssh: boolean;
  try {
    const scp = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(remoteUrl);
    if (!remoteUrl.includes('://') && scp) {
      remote = new URL(`ssh://${scp[1]}/${scp[2]}`);
    } else {
      remote = new URL(remoteUrl);
    }
    ssh = remote.protocol === 'ssh:';
    if (!ssh && remote.protocol !== 'https:' && remote.protocol !== 'http:') return [];
  } catch {
    return [];
  }

  return credentials.filter((credential) => {
    try {
      const server = new URL(credential.type === 'github' ? 'https://github.com' : credential.serverUrl!);
      // SSH ports identify the SSH service, independently of the saved HTTP API port.
      return ssh ? remote.hostname === server.hostname : remote.origin === server.origin;
    } catch {
      return false;
    }
  });
}
