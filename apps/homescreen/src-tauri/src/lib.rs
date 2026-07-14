mod aa;
mod account;
mod agent_card;
mod agent_ops;
mod anthropic;
mod bin;
mod bootstrap;
mod chat;
mod chat_attachments;
mod commands;
mod conversation_runtime;
mod conversation_sidecar;
mod creds;
mod custom_evals;
mod db;
mod gepa;
mod knowledge;
mod mcp;
mod metrics;
mod models;
mod moraine;
mod residency;
mod rlm;
mod route_policy;
mod server;
mod sidecar;
mod supervision_export;
mod supervision_review;
mod supervision_tiebreaker;
mod tool_proof;
mod workload_drop;

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

            let db = db::Db::open(data_dir).expect("understudy database opened");
            app.manage(db);
            app.manage(metrics::MetricsReader::new());
            app.manage(machine);
            app.manage(residency);
            // Agent-facing registries behind the local API server: model
            // download progress + the single-flight benchmark run gate.
            app.manage(agent_ops::Downloads::new());
            app.manage(agent_ops::BenchRuns::new());

            // Re-warm the previously-warm model set (background-safe).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(r) = handle.try_state::<residency::Residency>() {
                    r.inner().restore(&handle);
                }
            });

            // Refresh the model catalog from the snapshot service in the
            // background; snapshots() serves the bundled fallback until (and
            // unless) a live catalog lands.
            tauri::async_runtime::spawn(async {
                let _ = models::refresh_catalog().await;
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
            commands::runtime_cache_health,
            commands::anthropic_models,
            commands::anthropic_status,
            commands::anthropic_key_set,
            commands::connect,
            commands::disconnect,
            commands::list_models,
            commands::list_snapshot_models,
            commands::mlx_runtime_status,
            commands::set_app_icon,
            commands::bootstrap_status,
            commands::desktop_health,
            commands::install_uv,
            commands::install_mlx_runtime,
            commands::install_understudy_agent_tools,
            commands::start_snapshot_download,
            commands::list_snapshot_downloads,
            commands::snapshot_download_status,
            commands::cancel_snapshot_download,
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
            gepa::gepa_demo_run,
            gepa::gepa_load_run,
            commands::local_benchmarks,
            commands::fusion_benchmark_matrix,
            commands::fusion_route_recommendation,
            commands::fusion_route_decisions,
            commands::record_fusion_benchmark,
            commands::fusion_benchmark_results,
            commands::fusion_benchmark_summary,
            commands::fusion_benchmark_run_summary,
            commands::export_fusion_benchmark_comparison,
            commands::export_automationbench_handoff,
            commands::chat_runs,
            commands::chat_route_metrics,
            commands::chat_session_latest,
            commands::chat_sessions_list,
            commands::chat_session_get,
            commands::chat_session_save,
            chat_attachments::chat_attachments_store,
            chat_attachments::chat_attachments_hydrate,
            chat_attachments::chat_attachments_delete_session,
            commands::run_fusion_benchmark,
            commands::run_fusion_benchmark_matrix,
            commands::run_fusion_benchmark_matrix_live,
            custom_evals::import_custom_eval,
            custom_evals::list_custom_evals,
            custom_evals::delete_custom_eval,
            custom_evals::run_custom_eval,
            custom_evals::run_custom_eval_live,
            commands::sidekick_runs,
            commands::sidekick_metrics,
            commands::set_sidekick_run_feedback,
            commands::record_supervisor_feedback,
            commands::supervisor_feedback_for_session,
            supervision_review::supervision_review_queue,
            supervision_tiebreaker::supervision_tiebreaker_status,
            supervision_tiebreaker::supervision_tiebreaker_set_route,
            supervision_tiebreaker::supervision_tiebreaker_set_enabled,
            supervision_tiebreaker::supervision_tiebreaker_analyze,
            supervision_tiebreaker::record_tiebreaker_feedback,
            tool_proof::desktop_tool_proof_run,
            tool_proof::desktop_tool_proof_list,
            tool_proof::desktop_tool_proof_prepare,
            workload_drop::compile_dropped_workload,
            commands::sidekick_decisions,
            commands::sidekick_events,
            commands::sidekick_session_summaries,
            commands::aa_models,
            commands::aa_attribution,
            commands::get_setting,
            commands::set_setting,
            commands::server_info,
            conversation_sidecar::conversation_runtime_start,
            conversation_sidecar::conversation_runtime_repair,
            conversation_sidecar::conversation_runtime_cancel,
            rlm::rlm_demo_catalog,
            rlm::rlm_plan,
            rlm::run_rlm_live,
            chat::chat_stream,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // A normal quit owns server teardown. If the app crashes,
                // residency restore reaps only exact orphaned path+port
                // matches before it can warm another model.
                if let Some(residency) = app.try_state::<residency::Residency>() {
                    residency.shutdown();
                }
                // Graceful shutdown: the agent card must not keep
                // advertising a dead pid as a healthy local daemon.
                agent_card::mark_stopped();
            }
        });
}
