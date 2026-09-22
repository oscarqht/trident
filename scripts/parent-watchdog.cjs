// Watchdog script to ensure Node.js server exits whenever the parent Tauri app exits.
// Preloaded into Node.js processes via --require.

(function initParentWatchdog() {
  const parentPid = parseInt(process.env.TRIDENT_PARENT_PID, 10);

  // If not spawned by the Trident desktop app, do nothing.
  if (!parentPid || parentPid <= 1) {
    return;
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
  // Tauri attaches a piped stdin to this process and keeps the write end open.
  // When Tauri terminates for ANY reason (normal exit, SIGKILL, crash, panic),
  // the OS automatically closes the write end of the pipe, emitting 'end'/'close' to stdin.
  if (process.stdin) {
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
