use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::models::{self, MLX_PORT};

const SERVING_MANIFEST_VERSION: &str = "understudy.serving.v1";

/// Reserved unified memory for macOS + this app, off-limits to warm models.
pub const HEADROOM_GB: f32 = 24.0;

/// What we persist + restore across launches.
#[derive(Clone)]
pub struct PersistedSlot {
    pub slot_id: u32,
    pub model_id: Option<String>,
    pub model_path: Option<String>,
    pub warm: bool,
    pub thinking: bool,
    pub port: Option<u16>,
    pub mem_gb: f32,
    pub ordinal: u32,
}

/// Frontend view of a slot.
#[derive(Serialize, Clone)]
pub struct SlotView {
    pub id: u32,
    pub model_id: Option<String>,
    pub state: String, // running | loading | stopped | error
    pub port: Option<u16>,
    pub mem_gb: f32,
    pub load_ms: Option<u64>,
    pub thinking: bool,
}

#[derive(Serialize, Clone)]
pub struct ResidencySnapshot {
    pub slots: Vec<SlotView>,
    pub used_gb: f32,
    pub usable_gb: f32,
}

struct Resident {
    id: u32,
    model_id: Option<String>,
    model_path: Option<String>,
    state: SlotState,
    port: Option<u16>,
    mem_gb: f32,
    thinking: bool,
    load_ms: Option<u64>,
    last_used: Instant,
    child: Option<Child>,
}

#[derive(Clone, Copy)]
enum SlotState {
    Stopped,
    Loading,
    Warm,
    Error,
}

impl SlotState {
    fn as_str(&self) -> &'static str {
        match self {
            SlotState::Stopped => "stopped",
            SlotState::Loading => "loading",
            SlotState::Warm => "running",
            SlotState::Error => "error",
        }
    }
}

/// Multi-slot warm-model residency under a unified-memory budget.
pub struct Residency {
    inner: Mutex<Vec<Resident>>,
    next_id: Mutex<u32>,
    next_port: Mutex<u16>,
    usable_gb: f32,
}

#[derive(Deserialize)]
struct ServingManifest {
    schema_version: String,
    server: ServingServer,
}

#[derive(Deserialize)]
struct ServingServer {
    launcher: String,
    model_arg: String,
    cwd: Option<String>,
    required_flags: Option<Vec<String>>,
}

fn expand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

fn serving_command(model_path: &str, port: u16, thinking: bool) -> anyhow::Result<Command> {
    let manifest_path = Path::new(model_path).join("understudy.serving.json");
    if !manifest_path.exists() {
        let mut cmd = Command::new(crate::bin::mlx_server());
        cmd.args([
            "--model",
            model_path,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ]);
        if thinking {
            cmd.arg("--enable-thinking");
        }
        return Ok(cmd);
    }

    let manifest: ServingManifest =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)?;
    if manifest.schema_version != SERVING_MANIFEST_VERSION {
        anyhow::bail!(
            "unsupported serving manifest version {} at {}",
            manifest.schema_version,
            manifest_path.display()
        );
    }

    let launcher: Vec<&str> = manifest.server.launcher.split_whitespace().collect();
    let Some((program, rest)) = launcher.split_first() else {
        anyhow::bail!(
            "serving manifest has an empty launcher at {}",
            manifest_path.display()
        );
    };

    let use_mlx_script = *program == "python" && rest == ["-m", "mlx_vlm.server"];
    let mut cmd = if use_mlx_script {
        Command::new(crate::bin::mlx_server())
    } else {
        let mut cmd = Command::new(crate::bin::resolve(program));
        cmd.args(rest);
        cmd
    };
    cmd.arg(manifest.server.model_arg).arg(model_path).args([
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
    ]);
    if let Some(flags) = manifest.server.required_flags {
        cmd.args(flags);
    }
    if thinking {
        cmd.arg("--enable-thinking");
    }
    if let Some(cwd) = manifest.server.cwd {
        cmd.current_dir(expand_home(&cwd));
    }
    Ok(cmd)
}

impl Residency {
    pub fn new(memory_gb: u64) -> Self {
        Self {
            inner: Mutex::new(vec![]),
            next_id: Mutex::new(0),
            next_port: Mutex::new(MLX_PORT),
            usable_gb: (memory_gb as f32 - HEADROOM_GB).max(0.0),
        }
    }

    fn alloc_id(&self) -> u32 {
        let mut g = self.next_id.lock().unwrap();
        *g += 1;
        *g
    }
    fn alloc_port(&self) -> u16 {
        let mut g = self.next_port.lock().unwrap();
        *g += 1;
        *g
    }

    pub fn snapshot(&self) -> ResidencySnapshot {
        let inner = self.inner.lock().unwrap();
        let mut used = 0.0;
        let slots = inner
            .iter()
            .map(|r| {
                if matches!(r.state, SlotState::Warm) {
                    used += r.mem_gb;
                }
                SlotView {
                    id: r.id,
                    model_id: r.model_id.clone(),
                    state: r.state.as_str().to_string(),
                    port: r.port,
                    mem_gb: r.mem_gb,
                    load_ms: r.load_ms,
                    thinking: r.thinking,
                }
            })
            .collect();
        ResidencySnapshot {
            slots,
            used_gb: used,
            usable_gb: self.usable_gb,
        }
    }

    /// Add an empty slot; returns its id.
    pub fn add_slot(&self) -> u32 {
        let id = self.alloc_id();
        self.inner.lock().unwrap().push(Resident {
            id,
            model_id: None,
            model_path: None,
            state: SlotState::Stopped,
            port: None,
            mem_gb: 0.0,
            thinking: false,
            load_ms: None,
            last_used: Instant::now(),
            child: None,
        });
        id
    }

    pub fn assign(&self, slot_id: u32, model_id: &str) -> anyhow::Result<()> {
        let model = models::list()
            .into_iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| anyhow::anyhow!("model not found: {model_id}"))?;
        let mut inner = self.inner.lock().unwrap();
        let r = inner
            .iter_mut()
            .find(|r| r.id == slot_id)
            .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
        // Cool if currently warm.
        if let Some(child) = r.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        r.child = None;
        r.model_id = Some(model.id.clone());
        r.model_path = Some(model.path.clone());
        r.mem_gb = model.size_gb;
        r.thinking = false;
        r.state = SlotState::Stopped;
        r.load_ms = None;
        Ok(())
    }

    pub fn set_thinking(&self, slot_id: u32, thinking: bool) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let r = inner
            .iter_mut()
            .find(|r| r.id == slot_id)
            .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
        if matches!(r.state, SlotState::Loading) {
            anyhow::bail!("slot is already loading");
        }
        r.thinking = thinking;
        Ok(())
    }

    pub fn is_warm(&self, slot_id: u32) -> anyhow::Result<bool> {
        let inner = self.inner.lock().unwrap();
        let r = inner
            .iter()
            .find(|r| r.id == slot_id)
            .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
        Ok(matches!(r.state, SlotState::Warm))
    }

    pub fn remove(&self, slot_id: u32) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(idx) = inner.iter().position(|r| r.id == slot_id) {
            if let Some(child) = inner[idx].child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            inner.remove(idx);
        }
        Ok(())
    }

    /// Resolve a warm slot's endpoint + model path for chat.
    pub fn endpoint(&self, slot_id: u32) -> Option<(u16, String)> {
        let inner = self.inner.lock().unwrap();
        inner.iter().find(|r| r.id == slot_id).and_then(|r| {
            if matches!(r.state, SlotState::Warm) {
                r.port.zip(r.model_path.clone()).map(|(p, path)| (p, path))
            } else {
                None
            }
        })
    }

    /// Warm a slot: enforce budget (LRU evict), spawn mlx_vlm.server, poll until ready.
    pub fn warm(&self, app: &AppHandle, slot_id: u32) -> anyhow::Result<()> {
        // 1. Validate, reserve a port, flip to Loading (one short-lived borrow).
        let (port, model_id, model_path, mem_gb, thinking) = {
            let mut inner = self.inner.lock().unwrap();
            let r = inner
                .iter_mut()
                .find(|r| r.id == slot_id)
                .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
            if r.model_path.is_none() {
                anyhow::bail!("slot has no model assigned");
            }
            let port = r.port.unwrap_or_else(|| self.alloc_port());
            r.port = Some(port);
            r.state = SlotState::Loading;
            (
                port,
                r.model_id.clone().unwrap_or_default(),
                r.model_path.clone().unwrap_or_default(),
                r.mem_gb,
                r.thinking,
            )
        };

        // 2. Make room under the budget before the process loads weights.
        self.evict_until_fits(slot_id, mem_gb);

        // 3. Spawn the server process and attach it.
        let child = match serving_command(&model_path, port, thinking)?
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let mut inner = self.inner.lock().unwrap();
                if let Some(r) = inner.iter_mut().find(|r| r.id == slot_id) {
                    r.child = None;
                    r.state = SlotState::Error;
                }
                let snapshot = self.snapshot_from(&inner);
                drop(inner);
                let _ = app.emit("residency-changed", snapshot);
                anyhow::bail!("failed to start local model server: {err}");
            }
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(r) = inner.iter_mut().find(|r| r.id == slot_id) {
                r.child = Some(child);
            }
        }

        // Background: poll until the endpoint is up, then flip to Warm + record load time.
        let app = app.clone();
        let started = Instant::now();
        tauri::async_runtime::spawn(async move {
            let ready = wait_ready(port).await;
            let load_ms = started.elapsed().as_millis() as u64;
            let residency = app.state::<Residency>();
            let mut inner = residency.inner.lock().unwrap();
            if let Some(r) = inner.iter_mut().find(|r| r.id == slot_id) {
                if ready {
                    r.state = SlotState::Warm;
                    r.load_ms = Some(load_ms);
                    r.last_used = Instant::now();
                } else if r.child.is_some() {
                    r.state = SlotState::Error;
                } else {
                    r.state = SlotState::Stopped;
                }
            }
            let snapshot = residency.snapshot_from(&inner);
            drop(inner);
            let _ = app.emit("residency-changed", snapshot);
            // Persist + benchmark record.
            if ready {
                residency.persist(&app);
                let _ = app
                    .state::<Db>()
                    .record_benchmark(&model_id, None, mem_gb, Some(load_ms));
            }
        });
        Ok(())
    }

    pub fn cool(&self, slot_id: u32) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        self.cool_locked(&mut inner, slot_id)
    }

    fn cool_locked(&self, inner: &mut Vec<Resident>, slot_id: u32) -> anyhow::Result<()> {
        if let Some(r) = inner.iter_mut().find(|r| r.id == slot_id) {
            if let Some(child) = r.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            r.child = None;
            r.state = SlotState::Stopped;
        }
        Ok(())
    }

    fn used_gb_locked(&self, inner: &Vec<Resident>) -> f32 {
        inner
            .iter()
            .filter(|r| matches!(r.state, SlotState::Warm))
            .map(|r| r.mem_gb)
            .sum()
    }

    /// Evict least-recently-used warm slots (never `slot_id`) until `need_gb` fits.
    fn evict_until_fits(&self, slot_id: u32, need_gb: f32) {
        loop {
            let mut inner = self.inner.lock().unwrap();
            if self.used_gb_locked(&inner) + need_gb <= self.usable_gb {
                return;
            }
            let victim = inner
                .iter()
                .filter(|x| x.id != slot_id && matches!(x.state, SlotState::Warm))
                .min_by_key(|x| x.last_used)
                .map(|x| x.id);
            match victim {
                Some(vid) => {
                    let _ = self.cool_locked(&mut inner, vid);
                }
                None => return,
            }
        }
    }

    fn snapshot_from(&self, inner: &Vec<Resident>) -> ResidencySnapshot {
        let mut used = 0.0;
        let slots = inner
            .iter()
            .map(|r| {
                if matches!(r.state, SlotState::Warm) {
                    used += r.mem_gb;
                }
                SlotView {
                    id: r.id,
                    model_id: r.model_id.clone(),
                    state: r.state.as_str().to_string(),
                    port: r.port,
                    mem_gb: r.mem_gb,
                    load_ms: r.load_ms,
                    thinking: r.thinking,
                }
            })
            .collect();
        ResidencySnapshot {
            slots,
            used_gb: used,
            usable_gb: self.usable_gb,
        }
    }

    /// Persist the current plan (which slots exist + which should be warm).
    pub fn persist(&self, app: &AppHandle) {
        let inner = self.inner.lock().unwrap();
        let rows: Vec<PersistedSlot> = inner
            .iter()
            .enumerate()
            .map(|(i, r)| PersistedSlot {
                slot_id: r.id,
                model_id: r.model_id.clone(),
                model_path: r.model_path.clone(),
                warm: matches!(r.state, SlotState::Warm),
                thinking: r.thinking,
                port: r.port,
                mem_gb: r.mem_gb,
                ordinal: i as u32,
            })
            .collect();
        let _ = app.state::<Db>().save_residency(&rows);
    }

    /// On launch, rebuild slots from the persisted plan and re-warm the warm set.
    pub fn restore(&self, app: &AppHandle) {
        let rows = app.state::<Db>().load_residency().unwrap_or_default();
        if rows.is_empty() {
            return;
        }
        let max_id = rows.iter().map(|r| r.slot_id).max().unwrap_or(0);
        let max_port = rows
            .iter()
            .filter_map(|r| r.port)
            .max()
            .unwrap_or(MLX_PORT - 1);
        {
            let mut inner = self.inner.lock().unwrap();
            for r in &rows {
                inner.push(Resident {
                    id: r.slot_id,
                    model_id: r.model_id.clone(),
                    model_path: r.model_path.clone(),
                    state: SlotState::Stopped,
                    port: r.port,
                    mem_gb: r.mem_gb,
                    thinking: r.thinking,
                    load_ms: None,
                    last_used: Instant::now(),
                    child: None,
                });
            }
            *self.next_id.lock().unwrap() = max_id;
            *self.next_port.lock().unwrap() = max_port;
        }
        // Re-warm the previously-warm set (best-effort, background).
        for r in rows.into_iter().filter(|r| r.warm) {
            let _ = self.warm(app, r.slot_id);
        }
    }
}

async fn wait_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let deadline = Instant::now() + std::time::Duration::from_secs(180);
    while Instant::now() < deadline {
        if client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    false
}

#[allow(dead_code)]
fn _unused(_: SystemTime) {}
