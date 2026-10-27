#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

const DEFAULT_HTTP_PORT: u16 = 3000;
const DEFAULT_P2P_PORT: u16 = 4001;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct AppConfig {
    http_port: u16,
    p2p_port: u16,
    data_dir: String,
    bootstrap_peers: Vec<String>,
    auto_unlock: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            http_port: DEFAULT_HTTP_PORT,
            p2p_port: DEFAULT_P2P_PORT,
            data_dir: default_data_dir(),
            bootstrap_peers: vec![],
            auto_unlock: true,
        }
    }
}

fn default_data_dir() -> String {
    let mut base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.push("ddn");
    base.to_string_lossy().to_string()
}

fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("ddn");
    p.push("config.json");
    p
}

fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(c) = serde_json::from_str(&s) {
                return c;
            }
        }
    }
    AppConfig::default()
}

#[derive(Default)]
struct NodeHandle {
    running: Arc<AtomicBool>,
}

fn resolve_frontend_path(app: &tauri::App) -> String {
    let candidates = [
        app.path()
            .resolve("frontend/dist", tauri::path::BaseDirectory::Resource)
            .ok(),
        app.path()
            .resolve("../../frontend/dist", tauri::path::BaseDirectory::Resource)
            .ok(),
        app.path()
            .resolve("../frontend/dist", tauri::path::BaseDirectory::Resource)
            .ok(),
    ];
    for c in candidates.iter().flatten() {
        if c.join("index.html").exists() {
            return c.to_string_lossy().to_string();
        }
    }
    "./frontend/dist".to_string()
}

fn start_node(
    app: &tauri::App,
    cfg: &AppConfig,
) -> Result<NodeHandle, Box<dyn std::error::Error>> {
        let sidecar = match app
        .path()
        .resolve("ddn-node", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ddn-node sidecar not available yet: {}", e);
            return Ok(NodeHandle::default());
        }
    };

    let mut cmd = std::process::Command::new(sidecar);

    cmd.env("DDN_HTTP_PORT", cfg.http_port.to_string())
        .env("DDN_P2P_PORT", cfg.p2p_port.to_string())
        .env("DDN_DATA_DIR", &cfg.data_dir)
        .env("DDN_ENABLE_CHAIN", "1")
        .env(
            "DDN_FRONTEND_PATH",
            resolve_frontend_path(app),
        );

    if !cfg.bootstrap_peers.is_empty() {
        cmd.env("DDN_BOOTSTRAP_PEERS", cfg.bootstrap_peers.join(","));
    }

    cmd.spawn()?;
    println!(
        "DDN node sidecar started (HTTP :{}, P2P :{})",
        cfg.http_port, cfg.p2p_port
    );

    Ok(NodeHandle {
        running: Arc::new(AtomicBool::new(true)),
    })
}

#[tauri::command]
async fn get_node_status(
    state: tauri::State<'_, NodeHandle>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "running": state.running.load(Ordering::SeqCst) }))
}

fn wait_for_node(timeout_secs: u64) {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{}/api/identity", DEFAULT_HTTP_PORT);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if client.get(&url).send().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("ddn-node did not become ready within {}s", timeout_secs);
}

fn main() {
    tauri::Builder::default()
        .manage(NodeHandle::default())
        .invoke_handler(tauri::generate_handler![get_node_status])
        .setup(|app| {
            let cfg = load_config();
            {
                let handle_state = app.state::<NodeHandle>();
                match start_node(app, &cfg) {
                    Ok(_) => handle_state.running.store(true, Ordering::SeqCst),
                    Err(e) => eprintln!("failed to start sidecar: {}", e),
                }
            }

            wait_for_node(10);

            let tray_menu = MenuBuilder::new(app.handle())
                .item(&MenuItem::with_id(
                    app.handle(),
                    "open",
                    "Open Main Window",
                    true,
                    None::<&str>,
                )?)
                .separator()
                .item(&MenuItem::with_id(
                    app.handle(),
                    "toggle",
                    "Stop Node",
                    true,
                    None::<&str>,
                )?)
                .separator()
                .item(&MenuItem::with_id(
                    app.handle(),
                    "settings",
                    "Settings",
                    true,
                    None::<&str>,
                )?)
                .separator()
                .item(&MenuItem::with_id(
                    app.handle(),
                    "quit",
                    "Quit",
                    true,
                    None::<&str>,
                )?)
                .build()?;

            let icon_path = app
        .path()
        .resolve("icons/16x16.png", tauri::path::BaseDirectory::Resource)
        .unwrap_or_else(|_| PathBuf::from("icons/16x16.png"));
    let tray = TrayIconBuilder::new()
        .tooltip("Decentralized Data Network")
        .icon(tauri::image::Image::from_path(icon_path)?)
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .build(app.handle())?;

            let _ = tray;

            let window = app.get_webview_window("main").unwrap();
            window.show()?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let window = app.get_webview_window("main").unwrap();
                let _ = window.show();
                let _ = window.set_focus();
            }
            "toggle" => {
                println!("Toggle node: restart logic not yet implemented");
            }
            "settings" => {
                println!("Open settings window (not yet implemented)");
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
