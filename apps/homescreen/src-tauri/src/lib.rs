mod aa;
mod account;
mod bin;
mod bootstrap;
mod chat;
mod commands;
mod db;
mod knowledge;
mod mcp;
mod metrics;
mod models;
mod moraine;
mod residency;
mod server;
mod sidecar;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("app data dir resolved");

            let machine = metrics::detect_machine();
            let residency = residency::Residency::new(machine.memory_gb);

            app.manage(db::Db(data_dir));
            app.manage(metrics::MetricsReader::new());
            app.manage(machine);
            app.manage(residency);

            // Re-warm the previously-warm model set (background-safe).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(r) = handle.try_state::<residency::Residency>() {
                    r.inner().restore(&handle);
                }
            });

            // Local API server (HTTP + MCP + A2A) for coding agents.
            server::start(app.handle().clone());

            // Menu-bar tray.
            let show = MenuItem::with_id(app, "show", "Show Understudy", true, None::<&str>)?;
            let conn = MenuItem::with_id(
                app,
                "connect",
                "Connect (start Moraine)",
                true,
                None::<&str>,
            )?;
            let disc = MenuItem::with_id(
                app,
                "disconnect",
                "Disconnect (stop Moraine)",
                true,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Understudy", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &conn, &disc, &sep, &quit])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("no default window icon")?;
            TrayIconBuilder::with_id("understudy-tray")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Understudy")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "connect" => {
                        let _ = bin::command("moraine").arg("up").status();
                    }
                    "disconnect" => {
                        let _ = bin::command("moraine").arg("down").status();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::connect,
            commands::disconnect,
            commands::list_models,
            commands::list_snapshot_models,
            commands::mlx_runtime_status,
            commands::set_app_icon,
            commands::bootstrap_status,
            commands::install_uv,
            commands::install_mlx_runtime,
            commands::install_understudy_agent_tools,
            commands::download_snapshot_model,
            commands::get_residency,
            commands::add_slot,
            commands::assign_slot,
            commands::warm_slot,
            commands::set_slot_thinking,
            commands::cool_slot,
            commands::remove_slot,
            commands::get_moraine_state,
            commands::list_traces,
            commands::search_traces,
            commands::open_trace,
            commands::install_moraine,
            commands::start_moraine,
            commands::stop_moraine,
            commands::account_status,
            commands::account_platforms,
            commands::account_keys,
            commands::account_captures,
            commands::account_login_send,
            commands::account_login_code,
            commands::account_logout,
            commands::knowledge_dossiers,
            commands::local_benchmarks,
            commands::fusion_benchmark_matrix,
            commands::record_fusion_benchmark,
            commands::fusion_benchmark_results,
            commands::sidekick_runs,
            commands::set_sidekick_run_feedback,
            commands::sidekick_decisions,
            commands::sidekick_events,
            commands::aa_models,
            commands::aa_attribution,
            commands::get_setting,
            commands::set_setting,
            commands::server_info,
            chat::chat_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
