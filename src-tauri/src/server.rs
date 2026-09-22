use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

static RUNNING_PID: Mutex<Option<u32>> = Mutex::const_new(None);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Check if a local port is available to bind
fn is_port_available(port: u16) -> bool {
    // If an existing service accepts connections, the port is occupied
    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return false;
    }
    if std::net::TcpStream::connect(("::1", port)).is_ok() {
        return false;
    }
    // Verify both IPv4 and IPv6 can bind
    if TcpListener::bind(("0.0.0.0", port)).is_err() {
        return false;
    }
    if TcpListener::bind(("::", port)).is_err() {
        return false;
    }
    true
}

/// Find an available port starting from `start_port`
pub fn find_available_port(start_port: u16, max_attempts: u16) -> Option<u16> {
    for port in start_port..(start_port + max_attempts) {
        if is_port_available(port) {
            return Some(port);
        }
    }
    None
}

/// Discover Node.js executable on the user's system
pub fn discover_node_binary() -> Option<PathBuf> {
    // 1. Check if "node" is directly runnable from current PATH
    if let Ok(output) = std::process::Command::new("node").arg("--version").output() {
        if output.status.success() {
            return Some(PathBuf::from("node"));
        }
    }

    // Common fixed paths on macOS and Linux
    let known_paths = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/bin/node",
    ];

    for path_str in &known_paths {
        let p = Path::new(path_str);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }

    // Check Home directory paths (~/.nvm, ~/.fnm, ~/.volta)
    if let Some(home) = dirs::home_dir() {
        let fnm_node = home.join(".fnm/current/bin/node");
        if fnm_node.is_file() {
            return Some(fnm_node);
        }

        let volta_node = home.join(".volta/bin/node");
        if volta_node.is_file() {
            return Some(volta_node);
        }

        let asdf_node = home.join(".asdf/shims/node");
        if asdf_node.is_file() {
            return Some(asdf_node);
        }

        // Check NVM versions
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(nvm_versions) {
                let mut versions: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("bin/node"))
                    .filter(|p| p.is_file())
                    .collect();
                versions.sort();
                if let Some(latest) = versions.pop() {
                    return Some(latest);
                }
            }
        }
    }

    // Query user login shell as fallback (GUI apps on macOS don't inherit terminal PATH)
    #[cfg(unix)]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if let Ok(output) = std::process::Command::new(&shell)
                .args(["-l", "-i", "-c", "which node"])
                .output()
            {
                if output.status.success() {
                    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let p = PathBuf::from(path_str);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    None
}

/// Build an augmented PATH environment string so simple-git can find 'git' and 'node'
fn augmented_path() -> String {
    let mut paths = Vec::new();
    if let Ok(existing) = std::env::var("PATH") {
        paths.push(existing);
    }
    // Prepend standard tool directories
    paths.push("/opt/homebrew/bin".to_string());
    paths.push("/usr/local/bin".to_string());
    paths.push("/usr/bin".to_string());
    paths.push("/bin".to_string());

    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".nvm").to_string_lossy().to_string());
        paths.push(home.join(".fnm/current/bin").to_string_lossy().to_string());
        paths.push(home.join(".volta/bin").to_string_lossy().to_string());
    }

    paths.join(":")
}

enum ServerEntry {
    Standalone { app_root: PathBuf, script: PathBuf },
    Cli { app_root: PathBuf, script: PathBuf },
}

/// Locate the server entrypoint (standalone server.js or bin/trident-git.mjs)
fn resolve_entry_script(app: &AppHandle) -> Result<ServerEntry, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let parent = cwd.parent().unwrap_or(&cwd);

    // 1. Check packaged resource directory (.next/standalone or root server.js)
    if let Ok(res_dir) = app.path().resource_dir() {
        let up_standalone = res_dir.join("_up_/.next/standalone/server.js");
        if up_standalone.is_file() {
            return Ok(ServerEntry::Standalone {
                app_root: res_dir.join("_up_/.next/standalone"),
                script: up_standalone,
            });
        }

        let standalone_in_res = res_dir.join("standalone/server.js");
        if standalone_in_res.is_file() {
            return Ok(ServerEntry::Standalone {
                app_root: res_dir.join("standalone"),
                script: standalone_in_res,
            });
        }

        let dot_next_standalone = res_dir.join(".next/standalone/server.js");
        if dot_next_standalone.is_file() {
            return Ok(ServerEntry::Standalone {
                app_root: res_dir.join(".next/standalone"),
                script: dot_next_standalone,
            });
        }

        let server_in_res = res_dir.join("server.js");
        if server_in_res.is_file() {
            return Ok(ServerEntry::Standalone {
                app_root: res_dir.clone(),
                script: server_in_res,
            });
        }

        let script_in_res = res_dir.join("bin/trident-git.mjs");
        if script_in_res.is_file() {
            return Ok(ServerEntry::Cli {
                app_root: res_dir,
                script: script_in_res,
            });
        }
    }

    // 2. Check local workspace for .next/standalone/server.js
    let standalone_in_cwd = cwd.join(".next/standalone/server.js");
    if standalone_in_cwd.is_file() {
        return Ok(ServerEntry::Standalone {
            app_root: cwd.join(".next/standalone"),
            script: standalone_in_cwd,
        });
    }

    let standalone_in_parent = parent.join(".next/standalone/server.js");
    if standalone_in_parent.is_file() {
        return Ok(ServerEntry::Standalone {
            app_root: parent.join(".next/standalone"),
            script: standalone_in_parent,
        });
    }

    // 3. Check CLI launcher script
    let script_in_cwd = cwd.join("bin/trident-git.mjs");
    if script_in_cwd.is_file() {
        return Ok(ServerEntry::Cli {
            app_root: cwd,
            script: script_in_cwd,
        });
    }

    let script_in_parent = parent.join("bin/trident-git.mjs");
    if script_in_parent.is_file() {
        return Ok(ServerEntry::Cli {
            app_root: parent.to_path_buf(),
            script: script_in_parent,
        });
    }

    Err(format!(
        "Could not locate Next.js server entrypoint (.next/standalone/server.js or bin/trident-git.mjs). Checked cwd: {}",
        cwd.display()
    ))
}

/// Start the background Next.js server
pub async fn start_server(app: AppHandle) -> Result<(String, u16), String> {
    let node_bin = discover_node_binary().ok_or_else(|| {
        "Node.js executable was not found. Please ensure Node.js is installed on your system.".to_string()
    })?;

    let entry = resolve_entry_script(&app)?;

    let port = find_available_port(3100, 50).ok_or_else(|| {
        "Could not find an available local port in range 3100-3150.".to_string()
    })?;

    let mut cmd = std::process::Command::new(&node_bin);

    match entry {
        ServerEntry::Standalone { app_root, script } => {
            println!(
                "[trident] Using Node: {:?}, Standalone Script: {:?}, Port: {}",
                node_bin, script, port
            );
            cmd.arg(&script)
                .current_dir(&app_root)
                .env("PORT", port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("PATH", augmented_path())
                .env("NODE_ENV", "production");
        }
        ServerEntry::Cli { app_root, script } => {
            println!(
                "[trident] Using Node: {:?}, CLI Script: {:?}, Port: {}",
                node_bin, script, port
            );
            let mut args = vec![
                script.to_string_lossy().to_string(),
                "-p".to_string(),
                port.to_string(),
            ];
            let build_id = app_root.join(".next/BUILD_ID");
            if !build_id.exists() {
                println!("[trident] No production build found; running in dev mode");
                args.push("--dev".to_string());
            }
            cmd.args(&args)
                .current_dir(&app_root)
                .env("PORT", port.to_string())
                .env("PATH", augmented_path())
                .env("NODE_ENV", if build_id.exists() { "production" } else { "development" });
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Run in new process group so child processes can be terminated cleanly
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Next.js process with Node ({:?}): {e}", node_bin))?;

    let pid = child.id();
    {
        let mut running = RUNNING_PID.lock().await;
        *running = Some(pid);
    }

    println!("[trident] Spawned Next.js server (PID: {pid}) on port {port}");

    // Monitor process health and wait until HTTP port responds
    let server_url = format!("http://127.0.0.1:{port}");
    let wait_url = server_url.clone();

    tokio::task::spawn(async move {
        // Poll for server readiness
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(45);
        let mut ready = false;

        while start.elapsed() < timeout {
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                return;
            }

            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                ready = true;
                break;
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        if ready {
            println!("[trident] Server is ready at {wait_url}");
        } else {
            eprintln!("[trident] Warning: Server readiness poll timed out for {wait_url}");
        }
    });

    Ok((server_url, port))
}

/// Terminate the running Next.js background server
pub fn stop_server() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);

    if let Ok(mut running) = RUNNING_PID.try_lock() {
        if let Some(pid) = running.take() {
            println!("[trident] Stopping Next.js server (PID: {pid})...");

            #[cfg(unix)]
            {
                // Kill process group and pid
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &format!("-{pid}")])
                    .output();
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .output();
                std::thread::sleep(Duration::from_millis(200));
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", &format!("-{pid}")])
                    .output();
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .output();
            }

            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }

            println!("[trident] Server stopped.");
        }
    }
}
