mod server;
mod tray;
mod updater;

use tauri::RunEvent;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        server::stop_server();
        default_hook(info);
    }));

    let builder = tauri::Builder::default()
        .manage(updater::init_state())
        .invoke_handler(tauri::generate_handler![
            updater::check_for_updates_manual,
            updater::get_update_status,
            updater::install_and_relaunch,
            updater::close_update_window,
            tray::cmd_check_full_disk_access,
            tray::cmd_open_full_disk_access_settings,
        ])
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                match server::start_server(app_handle.clone()).await {
                    Ok((server_url, _port)) => {
                        println!("[trident] Server running at {server_url}");
                        if let Err(e) = tray::setup_tray(&app_handle, server_url) {
                            eprintln!("[trident] Failed to setup tray: {e}");
                        }
                        updater::start_background_updater(app_handle.clone());

                        #[cfg(target_os = "macos")]
                        {
                            use tauri_plugin_notification::NotificationExt;
                            if !tray::check_full_disk_access() {
                                println!("[trident] Full Disk Access is not granted yet. Notifying user...");
                                let _ = app_handle
                                    .notification()
                                    .builder()
                                    .title("Trident Permissions")
                                    .body("Trident needs Full Disk Access to avoid folder permission prompts when inspecting repositories. Click the status bar icon to configure.")
                                    .show();
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[trident] Failed to start server: {e}");
                        let _ = app_handle
                            .dialog()
                            .message(format!("Failed to start Trident server:\n\n{e}"))
                            .title("Trident Error")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        app_handle.exit(1);
                    }
                }
            });

            #[cfg(unix)]
            {
                tauri::async_runtime::spawn(async {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut sigterm = signal(SignalKind::terminate()).ok();
                    let mut sigquit = signal(SignalKind::quit()).ok();
                    let mut sighup = signal(SignalKind::hangup()).ok();

                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {
                            println!("[trident] Received SIGINT, stopping server...");
                        }
                        _ = async {
                            if let Some(s) = sigterm.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {
                            println!("[trident] Received SIGTERM, stopping server...");
                        }
                        _ = async {
                            if let Some(s) = sigquit.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {
                            println!("[trident] Received SIGQUIT, stopping server...");
                        }
                        _ = async {
                            if let Some(s) = sighup.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {
                            println!("[trident] Received SIGHUP, stopping server...");
                        }
                    }

                    server::stop_server();
                    std::process::exit(0);
                });
            }

            #[cfg(windows)]
            {
                tauri::async_runtime::spawn(async {
                    let mut ctrl_c = tokio::signal::windows::ctrl_c().ok();
                    let mut ctrl_break = tokio::signal::windows::ctrl_break().ok();
                    let mut ctrl_close = tokio::signal::windows::ctrl_close().ok();
                    let mut ctrl_shutdown = tokio::signal::windows::ctrl_shutdown().ok();

                    tokio::select! {
                        _ = async {
                            if let Some(s) = ctrl_c.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {}
                        _ = async {
                            if let Some(s) = ctrl_break.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {}
                        _ = async {
                            if let Some(s) = ctrl_close.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {}
                        _ = async {
                            if let Some(s) = ctrl_shutdown.as_mut() {
                                s.recv().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {}
                    }

                    server::stop_server();
                    std::process::exit(0);
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    updater::handle_app_reopen(&handle).await;
                });
            }
            RunEvent::ExitRequested { code, api, .. } => {
                if code.is_none() {
                    // Keep app running in menu bar / status bar when windows close
                    api.prevent_exit();
                } else {
                    server::stop_server();
                }
            }
            RunEvent::Exit => {
                server::stop_server();
            }
            _ => {}
        }
    });
}
