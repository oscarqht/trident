/* eslint-disable @typescript-eslint/no-require-imports */
// Watchdog script to ensure Node.js server exits whenever the parent Tauri app exits.
// Preloaded into Node.js processes via --require.

(function initParentWatchdog() {
  const parentPid = parseInt(process.env.TRIDENT_PARENT_PID, 10);

  // If not spawned by the Trident desktop app, do nothing.
  if (!parentPid || parentPid <= 1) {
    return;
  }

  // Prevent this watchdog script and parent PID from leaking to child processes
  // spawned by Node.js (e.g. bash scripts, npm, git hooks, worker child processes).
  delete process.env.TRIDENT_PARENT_PID;
  if (process.env.NODE_OPTIONS) {
    const cleaned = process.env.NODE_OPTIONS
      .replace(/(?:^|\s+)--require\s+["']?[^"']*(?:trident-)?parent-watchdog\.c?js["']?/g, '')
      .trim();
    if (cleaned) {
      process.env.NODE_OPTIONS = cleaned;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  }

  function isProcessAlive(pid) {
    if (!pid || pid <= 1) return false;
    try {
      // process.kill(pid, 0) does not send a signal; it only checks process existence.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // If error is EPERM, the process exists but cannot be signaled -> it is alive.
      // If ESRCH, the process does not exist -> it is dead.
      return Boolean(err && err.code === 'EPERM');
    }
  }

  function terminate() {
    try {
      process.exit(0);
    } catch {
      process.kill(process.pid, 'SIGKILL');
    }
  }

  // 1. Stdin pipe monitoring:
  // Tauri attaches a piped stdin ONLY to its direct child process and keeps the write end open.
  // When Tauri terminates for ANY reason (normal exit, SIGKILL, crash, panic),
  // the OS automatically closes the write end of the pipe, emitting 'end'/'close' to stdin.
  // We MUST ONLY monitor stdin if:
  // - This process is the direct child of the parent Tauri app (process.ppid === parentPid)
  // - process.stdin is not a TTY
  // Subprocesses (bash, npm, git, etc.) have their own stdin that may reach EOF naturally and
  // must never cause process termination.
  if (process.ppid === parentPid && process.stdin && !process.stdin.isTTY) {
    try {
      process.stdin.resume();
      process.stdin.on('end', terminate);
      process.stdin.on('close', terminate);
      process.stdin.on('error', terminate);
    } catch {}
  }

  // 2. Periodic parent PID & PPID check (defense-in-depth heartbeat):
  // Polls every 500ms to verify that the parent Tauri app is still alive.
  const timer = setInterval(() => {
    // On Unix, when the parent dies, process.ppid is reparented to 1 (launchd / init).
    if (process.ppid !== parentPid && process.ppid === 1) {
      terminate();
      return;
    }
    if (!isProcessAlive(parentPid)) {
      terminate();
    }
  }, 500);

  if (timer.unref) {
    timer.unref();
  }
})();

// Ensure Node.js server process has user tool directories (bun, cargo, pnpm, etc.)
// in process.env.PATH when launched by the desktop GUI app.
(function augmentPath() {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const homeDir = os.homedir();
    const delimiter = path.delimiter;
    const currentPaths = (process.env.PATH || '').split(delimiter).filter(Boolean);
    const candidateDirs = [];

    if (process.platform !== 'win32') {
      try {
        const { execSync } = require('child_process');
        const shell = process.env.SHELL || '/bin/zsh';
        const shellPath = execSync(`${shell} -l -c 'echo -n "$PATH"'`, {
          encoding: 'utf-8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (shellPath) {
          candidateDirs.push(...shellPath.split(':').filter(Boolean));
        }
      } catch {}

      candidateDirs.push(
        path.join(homeDir, '.bun', 'bin'),
        path.join(homeDir, '.cargo', 'bin'),
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, 'Library', 'pnpm'),
        path.join(homeDir, '.pnpm'),
        path.join(homeDir, '.deno', 'bin'),
        path.join(homeDir, '.config', 'yarn', 'global', 'node_modules', '.bin'),
        path.join(homeDir, '.yarn', 'bin'),
        path.join(homeDir, '.fnm', 'current', 'bin'),
        path.join(homeDir, '.volta', 'bin'),
        path.join(homeDir, '.asdf', 'shims'),
        path.join(homeDir, '.asdf', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
      );
    } else {
      candidateDirs.push(
        path.join(homeDir, '.bun', 'bin'),
        path.join(homeDir, '.cargo', 'bin'),
        path.join(homeDir, 'AppData', 'Local', 'pnpm'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm'),
        'C:\\Program Files\\Git\\bin',
        'C:\\Program Files\\Git\\usr\\bin',
        'C:\\Program Files\\nodejs'
      );
    }

    const seen = new Set();
    const finalPaths = [];
    for (const dir of candidateDirs) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        try {
          if (fs.existsSync(dir)) {
            finalPaths.push(dir);
          }
        } catch {}
      }
    }
    for (const dir of currentPaths) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        finalPaths.push(dir);
      }
    }

    if (finalPaths.length > 0) {
      process.env.PATH = finalPaths.join(delimiter);
    }

    const bunDir = path.join(homeDir, '.bun');
    if (!process.env.BUN_INSTALL && fs.existsSync(bunDir)) {
      process.env.BUN_INSTALL = bunDir;
    }
  } catch {}
})();

