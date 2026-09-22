use std::sync::Arc;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpToDate {
        current_version: String,
    },
    Downloading {
        version: String,
        current_version: String,
        body: Option<String>,
        downloaded: u64,
        total: Option<u64>,
        percent: u32,
    },
    Downloaded {
        version: String,
        current_version: String,
        body: Option<String>,
    },
    Error {
        message: String,
    },
}

pub struct UpdateManager {
    pub status: UpdateStatus,
    pub pending_update: Option<Update>,
    pub downloaded_bytes: Option<Vec<u8>>,
    pub tray_item: Option<MenuItem<Wry>>,
    pub is_checking_or_downloading: bool,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self {
            status: UpdateStatus::Idle,
            pending_update: None,
            downloaded_bytes: None,
            tray_item: None,
            is_checking_or_downloading: false,
        }
    }
}

pub struct UpdateState(pub Arc<tokio::sync::Mutex<UpdateManager>>);

pub fn init_state() -> UpdateState {
    UpdateState(Arc::new(tokio::sync::Mutex::new(UpdateManager::default())))
}

pub fn register_tray_item(app: &AppHandle, item: MenuItem<Wry>) {
    let state = app.state::<UpdateState>();
    let state_arc = state.0.clone();
    tauri::async_runtime::spawn(async move {
        let mut mgr = state_arc.lock().await;
        mgr.tray_item = Some(item);
    });
}

pub async fn check_and_download_silent(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    {
        let mgr = state.0.lock().await;
        if mgr.is_checking_or_downloading {
            return;
        }
        if matches!(mgr.status, UpdateStatus::Downloaded { .. }) {
            return;
        }
    }

    {
        let mut mgr = state.0.lock().await;
        mgr.is_checking_or_downloading = true;
        mgr.status = UpdateStatus::Checking;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[trident] Failed to initialize updater: {e}");
            let mut mgr = state.0.lock().await;
            mgr.is_checking_or_downloading = false;
            return;
        }
    };

    println!("[trident] Auto-updater: checking for updates...");
    match updater.check().await {
        Ok(Some(update)) => {
            println!("[trident] Auto-updater: new version available: v{}", update.version);
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            let body = update.body.clone();

            {
                let mut mgr = state.0.lock().await;
                mgr.status = UpdateStatus::Downloading {
                    version: version.clone(),
                    current_version: current_version.clone(),
                    body: body.clone(),
                    downloaded: 0,
                    total: None,
                    percent: 0,
                };
            }

            let mut downloaded = 0u64;
            let mut last_emit = std::time::Instant::now();
            let mut last_pct = 0u32;
            let version_for_cb = version.clone();
            let curr_for_cb = current_version.clone();
            let body_for_cb = body.clone();

            let res = update
                .download(
                    move |chunk_length, content_length| {
                        downloaded += chunk_length as u64;
                        let pct = if let Some(tot) = content_length {
                            if tot > 0 {
                                ((downloaded as f64 / tot as f64) * 100.0) as u32
                            } else {
                                0
                            }
                        } else {
                            0
                        };

                        if pct != last_pct || last_emit.elapsed() >= Duration::from_millis(300) {
                            last_pct = pct;
                            last_emit = std::time::Instant::now();
                            let _status = UpdateStatus::Downloading {
                                version: version_for_cb.clone(),
                                current_version: curr_for_cb.clone(),
                                body: body_for_cb.clone(),
                                downloaded,
                                total: content_length,
                                percent: pct,
                            };
                        }
                    },
                    || {
                        println!("[trident] Auto-updater: download complete.");
                    },
                )
                .await;

            match res {
                Ok(bytes) => {
                    println!("[trident] Auto-updater: downloaded {} bytes successfully", bytes.len());
                    let new_status = UpdateStatus::Downloaded {
                        version: version.clone(),
                        current_version: current_version.clone(),
                        body: body.clone(),
                    };

                    {
                        let mut mgr = state.0.lock().await;
                        mgr.pending_update = Some(update);
                        mgr.downloaded_bytes = Some(bytes);
                        mgr.status = new_status.clone();
                        if let Some(tray_item) = &mgr.tray_item {
                            let _ = tray_item.set_text(format!("Restart to Update to v{version}"));
                        }
                    }

                    let notif_body = format!(
                        "Version v{} is downloaded. Click the status bar menu to restart and apply.",
                        version
                    );
                    let _ = app
                        .notification()
                        .builder()
                        .title("Trident Update Ready")
                        .body(notif_body)
                        .show();
                }
                Err(e) => {
                    eprintln!("[trident] Auto-updater download failed: {e}");
                    let mut mgr = state.0.lock().await;
                    mgr.status = UpdateStatus::Idle;
                }
            }
        }
        Ok(None) => {
            println!("[trident] Auto-updater: Trident is up to date.");
            let status = UpdateStatus::UpToDate {
                current_version: app.package_info().version.to_string(),
            };
            let mut mgr = state.0.lock().await;
            mgr.status = status;
        }
        Err(e) => {
            eprintln!("[trident] Auto-updater check error: {e}");
            let err_status = UpdateStatus::Error {
                message: format!("Check failed: {e}"),
            };
            let mut mgr = state.0.lock().await;
            mgr.status = err_status;
        }
    }

    let mut mgr = state.0.lock().await;
    mgr.is_checking_or_downloading = false;
}

pub async fn check_and_download_manual(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let downloaded_version = {
        let mgr = state.0.lock().await;
        if mgr.is_checking_or_downloading {
            let _ = app
                .notification()
                .builder()
                .title("Trident Update")
                .body("Already checking for updates...")
                .show();
            return;
        }

        if let UpdateStatus::Downloaded { version, .. } = &mgr.status {
            Some(version.clone())
        } else {
            None
        }
    };

    if let Some(version) = downloaded_version {
        let restart = app
            .dialog()
            .message(format!(
                "Version v{version} is downloaded and ready to install.\n\nRestart Trident now to apply the update?"
            ))
            .title("Trident Update Ready")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart Now".into(),
                "Later".into(),
            ))
            .blocking_show();

        if restart {
            if let Err(e) = install_and_relaunch_inner(app).await {
                let _ = app
                    .dialog()
                    .message(format!("Failed to install update:\n\n{e}"))
                    .title("Update Error")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
        }
        return;
    }

    {
        let mut mgr = state.0.lock().await;
        mgr.is_checking_or_downloading = true;
        mgr.status = UpdateStatus::Checking;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let err_msg = format!("Failed to initialize updater: {e}");
            eprintln!("[trident] {err_msg}");
            let mut mgr = state.0.lock().await;
            mgr.status = UpdateStatus::Error { message: err_msg.clone() };
            mgr.is_checking_or_downloading = false;
            let _ = app
                .dialog()
                .message(&err_msg)
                .title("Update Error")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }
    };

    println!("[trident] Manual update: checking for updates...");
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            println!("[trident] Manual update: found v{version} (current: v{current_version})");

            let res = update
                .download(
                    |_chunk, _total| {},
                    || {
                        println!("[trident] Manual update: download complete.");
                    },
                )
                .await;

            match res {
                Ok(bytes) => {
                    {
                        let mut mgr = state.0.lock().await;
                        mgr.pending_update = Some(update);
                        mgr.downloaded_bytes = Some(bytes);
                        mgr.status = UpdateStatus::Downloaded {
                            version: version.clone(),
                            current_version: current_version.clone(),
                            body: None,
                        };

                        if let Some(tray_item) = &mgr.tray_item {
                            let _ = tray_item.set_text(format!("Restart to Update to v{version}"));
                        }
                    }

                    let restart = app
                        .dialog()
                        .message(format!(
                            "Version v{version} has been successfully downloaded.\n\nRestart Trident now to apply the update?"
                        ))
                        .title("Trident Update Ready")
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Restart Now".into(),
                            "Later".into(),
                        ))
                        .blocking_show();

                    if restart {
                        if let Err(e) = install_and_relaunch_inner(app).await {
                            let _ = app
                                .dialog()
                                .message(format!("Failed to install update:\n\n{e}"))
                                .title("Update Error")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                }
                Err(e) => {
                    let err_msg = format!("Download failed: {e}");
                    let mut mgr = state.0.lock().await;
                    mgr.status = UpdateStatus::Error { message: err_msg.clone() };
                    let _ = app
                        .dialog()
                        .message(&err_msg)
                        .title("Update Error")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
            }
        }
        Ok(None) => {
            let current_version = app.package_info().version.to_string();
            println!("[trident] Manual update: up to date (v{current_version}).");
            let mut mgr = state.0.lock().await;
            mgr.status = UpdateStatus::UpToDate {
                current_version: current_version.clone(),
            };

            let _ = app
                .dialog()
                .message(format!("Trident is up to date (version {current_version})."))
                .title("Trident Update")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(e) => {
            let err_msg = format!("Could not check for updates: {e}");
            let mut mgr = state.0.lock().await;
            mgr.status = UpdateStatus::Error { message: err_msg.clone() };

            let _ = app
                .dialog()
                .message(&err_msg)
                .title("Update Error")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }

    let mut mgr = state.0.lock().await;
    mgr.is_checking_or_downloading = false;
}

pub async fn handle_check_updates_click(app: &AppHandle) {
    check_and_download_manual(app).await;
}

pub async fn install_and_relaunch_inner(app: &AppHandle) -> Result<(), String> {
    let (pending_update, downloaded_bytes) = {
        let state = app.state::<UpdateState>();
        let mut mgr = state.0.lock().await;
        (mgr.pending_update.take(), mgr.downloaded_bytes.take())
    };

    if let (Some(update), Some(bytes)) = (pending_update, downloaded_bytes) {
        println!("[trident] Installing downloaded update package...");
        let install_result = tokio::task::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| format!("Install task panicked: {e}"))?;

        match install_result {
            Ok(_) => {
                println!("[trident] Update installed successfully! Stopping server and relaunching app...");
                crate::server::stop_server();
                app.restart();
            }
            Err(e) => {
                let err_msg = format!("Failed to install update: {e}");
                eprintln!("[trident] {err_msg}");
                let state = app.state::<UpdateState>();
                let mut mgr = state.0.lock().await;
                mgr.status = UpdateStatus::Error {
                    message: err_msg.clone(),
                };
                Err(err_msg)
            }
        }
    } else {
        Err("No downloaded update package ready to install.".to_string())
    }
}

pub fn start_background_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Initial check 10 seconds after startup
        tokio::time::sleep(Duration::from_secs(10)).await;
        check_and_download_silent(&app).await;

        // Recurring check every 1 hour
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            check_and_download_silent(&app).await;
        }
    });
}
