use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::models::{self, MLX_PORT};

const SERVING_MANIFEST_VERSION: &str = "understudy.serving.v1";

/// Reserved unified memory for macOS + this app, off-limits to warm models.
pub const HEADROOM_GB: f32 = 24.0;

/// Weight files are not the runtime peak: Metal allocations, KV cache, prompt
/// buffers, and one Python server add material unified-memory pressure. Keep
/// the budget deliberately conservative because an IOGPU allocation failure
/// can panic macOS rather than returning a recoverable process error.
const RUNTIME_WEIGHT_MULTIPLIER: f32 = 1.30;
const RUNTIME_SERVER_OVERHEAD_GB: f32 = 2.0;
const DYNAMIC_HEADROOM_GB: f32 = 16.0;
const GPU_EVICTION_SETTLE_TIME: Duration = Duration::from_secs(2);

/// Very large checkpoints run exclusively. This includes current 8-bit and
/// BF16 26B candidates while allowing the certified compressed ladder to stay
/// warm together when the conservative aggregate budget fits.
const EXCLUSIVE_MODEL_WEIGHTS_GB: f32 = 24.0;

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

/// Lock with poison recovery: a panic in one holder must not brick every
/// later status/snapshot call. Slot bookkeeping stays consistent across any
/// single mutation, so taking the inner value is safe.
fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn expand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

fn estimated_runtime_gb(weights_gb: f32) -> f32 {
    weights_gb * RUNTIME_WEIGHT_MULTIPLIER + RUNTIME_SERVER_OVERHEAD_GB
}

fn available_memory_gb() -> f32 {
    let mut system = System::new_all();
    system.refresh_memory();
    system.available_memory() as f32 / (1024.0 * 1024.0 * 1024.0)
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
        let mut g = locked(&self.next_id);
        *g += 1;
        *g
    }
    /// Hands out the current port and advances, so the first slot on a fresh
    /// launch binds MLX_PORT itself — the port LOCAL_BASE_URL advertises.
    fn alloc_port(&self) -> u16 {
        let mut g = locked(&self.next_port);
        let port = *g;
        *g += 1;
        port
    }

    pub fn snapshot(&self) -> ResidencySnapshot {
        let inner = locked(&self.inner);
        self.snapshot_from(&inner)
    }

    /// Add an empty slot; returns its id.
    pub fn add_slot(&self) -> u32 {
        let id = self.alloc_id();
        locked(&self.inner).push(Resident {
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
        let mut inner = locked(&self.inner);
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
        let mut inner = locked(&self.inner);
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
        let inner = locked(&self.inner);
        let r = inner
            .iter()
            .find(|r| r.id == slot_id)
            .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
        Ok(matches!(r.state, SlotState::Warm))
    }

    pub fn remove(&self, slot_id: u32) -> anyhow::Result<()> {
        let mut inner = locked(&self.inner);
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
        let inner = locked(&self.inner);
        inner.iter().find(|r| r.id == slot_id).and_then(|r| {
            if matches!(r.state, SlotState::Warm) {
                r.port.zip(r.model_path.clone())
            } else {
                None
            }
        })
    }

    /// Resolve the preferred warm local sidekick endpoint.
    pub fn sidekick_endpoint(
        &self,
        exclude_slot_id: Option<u32>,
    ) -> Option<(u32, u16, String, String)> {
        let inner = locked(&self.inner);
        let candidates: Vec<_> = inner
            .iter()
            .filter(|r| {
                matches!(r.state, SlotState::Warm)
                    && Some(r.id) != exclude_slot_id
                    && r.port.is_some()
                    && r.model_path.is_some()
                    && r.model_id.is_some()
            })
            .collect();
        let preferred = candidates
            .iter()
            .copied()
            .find(|r| {
                r.model_id
                    .as_deref()
                    .map(|id| id.contains("e2b") || id.contains("understudy-small"))
                    .unwrap_or(false)
            })
            .or_else(|| candidates.first().copied())?;
        Some((
            preferred.id,
            preferred.port?,
            preferred.model_path.clone()?,
            preferred.model_id.clone()?,
        ))
    }

    /// Warm a slot: enforce a conservative runtime budget, spawn mlx_vlm.server,
    /// and poll until ready. Heavy checkpoints are exclusive by construction.
    pub fn warm(&self, app: &AppHandle, slot_id: u32) -> anyhow::Result<()> {
        // 1. Validate without changing state. A rejected preflight must never
        // leave a slot stuck in Loading.
        let (model_id, model_path, mem_gb, thinking) = {
            let inner = locked(&self.inner);
            let r = inner
                .iter()
                .find(|r| r.id == slot_id)
                .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
            if matches!(r.state, SlotState::Warm) {
                return Ok(());
            }
            if matches!(r.state, SlotState::Loading) {
                anyhow::bail!("slot {slot_id} is already loading");
            }
            if r.model_path.is_none() {
                anyhow::bail!("slot has no model assigned");
            }
            (
                r.model_id.clone().unwrap_or_default(),
                r.model_path.clone().unwrap_or_default(),
                r.mem_gb,
                r.thinking,
            )
        };

        // 2. Make room before loading any Metal buffers. Large checkpoints
        // evict every other active server; all checkpoints use the estimated
        // runtime peak rather than their on-disk weight size.
        let evicted = self.evict_until_fits(slot_id, mem_gb)?;
        if evicted {
            // Child::wait confirms process exit, but Metal/IOGPU teardown can
            // finish asynchronously. Do not load the next checkpoint into the
            // same allocator teardown window.
            std::thread::sleep(GPU_EVICTION_SETTLE_TIME);
        }
        let estimated_gb = estimated_runtime_gb(mem_gb);
        let available_gb = available_memory_gb();
        if available_gb < estimated_gb + DYNAMIC_HEADROOM_GB {
            // Eviction may already have changed the live plan. Persist that
            // safer state even though this candidate is rejected.
            self.persist(app);
            let _ = app.emit("residency-changed", self.snapshot());
            anyhow::bail!(
                "refusing to warm {model_id}: estimated runtime {:.1} GB plus {:.0} GB dynamic headroom exceeds {:.1} GB currently available; cool other workloads and retry",
                estimated_gb,
                DYNAMIC_HEADROOM_GB,
                available_gb,
            );
        }

        // Validate a serving manifest before changing the slot state.
        let _ = serving_command(&model_path, 0, thinking)?;

        // 3. Reserve a port and flip to Loading only after preflight passes.
        let port = {
            let mut inner = locked(&self.inner);
            let r = inner
                .iter_mut()
                .find(|r| r.id == slot_id)
                .ok_or_else(|| anyhow::anyhow!("slot not found: {slot_id}"))?;
            let port = r.port.unwrap_or_else(|| self.alloc_port());
            r.port = Some(port);
            r.state = SlotState::Loading;
            port
        };

        // The command was validated with a placeholder port. Build it again
        // with the reserved port before spawning.
        let mut command = serving_command(&model_path, port, thinking)?;

        // 4. Spawn the server process and attach it.
        let child = match command.stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            Ok(child) => child,
            Err(err) => {
                let mut inner = locked(&self.inner);
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
            let mut inner = locked(&self.inner);
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
            let mut inner = locked(&residency.inner);
            if let Some(r) = inner.iter_mut().find(|r| r.id == slot_id) {
                if ready {
                    r.state = SlotState::Warm;
                    r.load_ms = Some(load_ms);
                    r.last_used = Instant::now();
                } else if let Some(mut child) = r.child.take() {
                    // The server may still be loading weights; kill it so a
                    // timed-out slot doesn't keep tens of GB resident while
                    // showing as Error.
                    let _ = child.kill();
                    let _ = child.wait();
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
                if let Err(err) =
                    app.state::<Db>()
                        .record_benchmark(&model_id, None, mem_gb, Some(load_ms))
                {
                    eprintln!("understudy db: record_benchmark failed: {err:#}");
                }
            }
        });
        Ok(())
    }

    pub fn cool(&self, slot_id: u32) -> anyhow::Result<()> {
        let mut inner = locked(&self.inner);
        self.cool_locked(&mut inner, slot_id)
    }

    fn cool_locked(&self, inner: &mut [Resident], slot_id: u32) -> anyhow::Result<()> {
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

    /// Estimated runtime memory attributed to slots other than `exclude`.
    /// Warm and loading slots both count so concurrent loads cannot each pass
    /// preflight against the same memory.
    fn used_gb_locked(&self, inner: &[Resident], exclude: Option<u32>) -> f32 {
        inner
            .iter()
            .filter(|r| Some(r.id) != exclude)
            .filter(|r| matches!(r.state, SlotState::Warm | SlotState::Loading))
            .map(|r| estimated_runtime_gb(r.mem_gb))
            .sum()
    }

    /// Prepare one candidate safely. Very large checkpoints are exclusive;
    /// otherwise evict least-recently-used active slots until the conservative
    /// runtime estimate fits. Fail closed if even an empty machine is too small.
    fn evict_until_fits(&self, slot_id: u32, weights_gb: f32) -> anyhow::Result<bool> {
        let need_gb = estimated_runtime_gb(weights_gb);
        if need_gb > self.usable_gb {
            anyhow::bail!(
                "model needs an estimated {:.1} GB runtime memory, above the {:.1} GB safe residency budget",
                need_gb,
                self.usable_gb,
            );
        }
        let mut evicted = false;
        loop {
            let mut inner = locked(&self.inner);
            // Exclusivity is symmetric: warming a heavy model clears every
            // other active slot, and warming a small model clears any active
            // heavy slot. A later small warm must not silently recreate the
            // dangerous mixed residency state.
            if weights_gb >= EXCLUSIVE_MODEL_WEIGHTS_GB {
                let victims: Vec<u32> = inner
                    .iter()
                    .filter(|r| r.id != slot_id)
                    .filter(|r| matches!(r.state, SlotState::Warm | SlotState::Loading))
                    .map(|r| r.id)
                    .collect();
                for victim in victims {
                    self.cool_locked(&mut inner, victim)?;
                    evicted = true;
                }
            } else {
                let heavy_victims: Vec<u32> = inner
                    .iter()
                    .filter(|r| r.id != slot_id)
                    .filter(|r| matches!(r.state, SlotState::Warm | SlotState::Loading))
                    .filter(|r| r.mem_gb >= EXCLUSIVE_MODEL_WEIGHTS_GB)
                    .map(|r| r.id)
                    .collect();
                for victim in heavy_victims {
                    self.cool_locked(&mut inner, victim)?;
                    evicted = true;
                }
            }
            if self.used_gb_locked(&inner, Some(slot_id)) + need_gb <= self.usable_gb {
                return Ok(evicted);
            }
            let victim = inner
                .iter()
                .filter(|x| {
                    x.id != slot_id && matches!(x.state, SlotState::Warm | SlotState::Loading)
                })
                .min_by_key(|x| x.last_used)
                .map(|x| x.id);
            match victim {
                Some(vid) => {
                    self.cool_locked(&mut inner, vid)?;
                    evicted = true;
                }
                None => anyhow::bail!(
                    "model needs an estimated {:.1} GB runtime memory but no safe eviction plan remains",
                    need_gb,
                ),
            }
        }
    }

    fn snapshot_from(&self, inner: &[Resident]) -> ResidencySnapshot {
        let used = self.used_gb_locked(inner, None);
        let slots = inner
            .iter()
            .map(|r| SlotView {
                id: r.id,
                model_id: r.model_id.clone(),
                state: r.state.as_str().to_string(),
                port: r.port,
                mem_gb: r.mem_gb,
                load_ms: r.load_ms,
                thinking: r.thinking,
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
        let inner = locked(&self.inner);
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
        if let Err(err) = app.state::<Db>().save_residency(&rows) {
            eprintln!("understudy db: save_residency failed: {err:#}");
        }
        // Keep the agent card's warm-model facts current on every commit
        // (warm/cool/assign) so external agents see live runtime truth.
        let warm: Vec<crate::agent_card::WarmModel> = rows
            .iter()
            .filter(|r| r.warm)
            .filter_map(|r| {
                Some(crate::agent_card::WarmModel {
                    id: r.model_id.clone()?,
                    port: r.port,
                    model_path: r.model_path.clone().unwrap_or_default(),
                })
            })
            .collect();
        crate::agent_card::record_warm_models(&warm);
    }

    /// On launch, rebuild slots from the persisted plan and re-warm the warm set.
    pub fn restore(&self, app: &AppHandle) {
        let rows = app.state::<Db>().load_residency().unwrap_or_default();
        if rows.is_empty() {
            return;
        }
        let max_id = rows.iter().map(|r| r.slot_id).max().unwrap_or(0);
        // Next allocation hands out this value directly, so start one past
        // the highest restored port (or at MLX_PORT when none had one).
        let next_port = rows
            .iter()
            .filter_map(|r| r.port)
            .max()
            .map(|p| p + 1)
            .unwrap_or(MLX_PORT);
        {
            let mut inner = locked(&self.inner);
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
            *locked(&self.next_id) = max_id;
            *locked(&self.next_port) = next_port;
        }
        // Re-warm the previously-warm set (best-effort, background). Heavy
        // experiment checkpoints never auto-restore after a crash or restart;
        // an explicit warm is required so a bad GPU-memory state cannot loop.
        for r in rows.into_iter().filter(|r| r.warm) {
            if r.mem_gb >= EXCLUSIVE_MODEL_WEIGHTS_GB {
                eprintln!(
                    "understudy residency: leaving heavy model {} stopped after restart; explicit warm required",
                    r.model_id.as_deref().unwrap_or("unknown"),
                );
                continue;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn resident(id: u32, state: SlotState, mem_gb: f32) -> Resident {
        Resident {
            id,
            model_id: Some(format!("model-{id}")),
            model_path: Some(format!("/tmp/model-{id}")),
            state,
            port: None,
            mem_gb,
            thinking: false,
            load_ms: None,
            last_used: Instant::now(),
            child: None,
        }
    }

    #[test]
    fn first_port_matches_advertised_base_url() {
        let residency = Residency::new(64);
        assert_eq!(residency.alloc_port(), MLX_PORT);
        assert_eq!(residency.alloc_port(), MLX_PORT + 1);
        assert!(models::LOCAL_BASE_URL.contains(&MLX_PORT.to_string()));
    }

    #[test]
    fn loading_slots_count_against_budget() {
        let residency = Residency::new(64);
        {
            let mut inner = locked(&residency.inner);
            inner.push(resident(1, SlotState::Warm, 16.0));
            inner.push(resident(2, SlotState::Loading, 16.0));
            inner.push(resident(3, SlotState::Error, 16.0));
            inner.push(resident(4, SlotState::Stopped, 16.0));
        }
        let inner = locked(&residency.inner);
        assert_eq!(residency.used_gb_locked(&inner, None), 45.6);
        // The fit check for a slot must not double-count that slot itself.
        assert_eq!(residency.used_gb_locked(&inner, Some(2)), 22.8);
        drop(inner);
        assert_eq!(residency.snapshot().used_gb, 45.6);
    }

    #[test]
    fn heavy_models_are_exclusive_and_runtime_budgeted() {
        let residency = Residency::new(128);
        {
            let mut inner = locked(&residency.inner);
            inner.push(resident(1, SlotState::Warm, 16.0));
            inner.push(resident(2, SlotState::Loading, 7.0));
            inner.push(resident(3, SlotState::Stopped, 48.0));
        }
        residency.evict_until_fits(3, 48.0).unwrap();
        let inner = locked(&residency.inner);
        assert!(matches!(inner[0].state, SlotState::Stopped));
        assert!(matches!(inner[1].state, SlotState::Stopped));
        assert!(matches!(inner[2].state, SlotState::Stopped));
        assert!((estimated_runtime_gb(48.0) - 64.4).abs() < 0.001);
    }

    #[test]
    fn warming_small_model_evicts_active_heavy_model() {
        let residency = Residency::new(128);
        {
            let mut inner = locked(&residency.inner);
            inner.push(resident(1, SlotState::Warm, 48.0));
            inner.push(resident(2, SlotState::Stopped, 7.0));
        }
        assert!(residency.evict_until_fits(2, 7.0).unwrap());
        let inner = locked(&residency.inner);
        assert!(matches!(inner[0].state, SlotState::Stopped));
        assert!(matches!(inner[1].state, SlotState::Stopped));
    }

    #[test]
    fn model_larger_than_safe_runtime_budget_is_rejected() {
        let residency = Residency::new(64);
        let error = residency.evict_until_fits(1, 48.0).unwrap_err();
        assert!(error
            .to_string()
            .contains("above the 40.0 GB safe residency budget"));
    }

    #[test]
    fn poisoned_lock_does_not_brick_snapshots() {
        let residency = std::sync::Arc::new(Residency::new(64));
        locked(&residency.inner).push(resident(1, SlotState::Warm, 8.0));
        let clone = residency.clone();
        let _ = std::thread::spawn(move || {
            let _guard = clone.inner.lock().unwrap();
            panic!("poison the residency lock");
        })
        .join();
        let snap = residency.snapshot();
        assert_eq!(snap.slots.len(), 1);
        assert!((snap.used_gb - 12.4).abs() < 0.001);
    }
}
