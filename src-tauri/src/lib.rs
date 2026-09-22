mod server;
mod tray;
mod updater;

use tauri::RunEvent;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(updater::init_state())
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
                        updater::start_background_updater(app_handle);
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
                    if tokio::signal::ctrl_c().await.is_ok() {
                        server::stop_server();
                        std::process::exit(0);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
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
