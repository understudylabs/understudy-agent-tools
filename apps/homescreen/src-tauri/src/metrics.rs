use serde::Serialize;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

fn resource_system() -> System {
    System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    )
}

/// Static, detected-once machine summary shown on the Status pane.
#[derive(Serialize, Clone, Default)]
pub struct Machine {
    pub chip: String,
    pub memory_gb: u64,
}

fn total_memory_bytes(sys: &System) -> u64 {
    let detected = sys.total_memory();
    if detected > 0 {
        return detected;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0)
    }
    #[cfg(not(target_os = "macos"))]
    0
}

pub fn detect_machine() -> Machine {
    // A full sysinfo refresh also enumerates every process. Doing that twice in
    // Tauri setup delayed the event loop long enough for macOS to show a
    // beachball. Machine identity only needs CPU and memory facts.
    let mut sys = resource_system();
    // `new_with_specifics` may report zero total memory during early macOS
    // app startup. Force one refresh before sizing the residency budget.
    sys.refresh_memory();
    let chip = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Apple Silicon".to_string());
    Machine {
        chip,
        memory_gb: total_memory_bytes(&sys) / (1024 * 1024 * 1024),
    }
}

/// Live resource usage. A System is held in state so CPU deltas accumulate between reads.
#[derive(Serialize, Clone)]
pub struct Metrics {
    pub cpu_pct: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
}

pub struct MetricsReader {
    sys: Mutex<System>,
}

impl MetricsReader {
    pub fn new() -> Self {
        let mut sys = resource_system();
        sys.refresh_cpu_usage();
        Self {
            sys: Mutex::new(sys),
        }
    }

    pub fn read(&self) -> Metrics {
        let mut sys = self.sys.lock().expect("metrics lock");
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let cpus = sys.cpus();
        let cpu = if cpus.is_empty() {
            0.0
        } else {
            cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
        };
        let gib = 1024.0 * 1024.0 * 1024.0;
        Metrics {
            cpu_pct: cpu,
            mem_total_gb: sys.total_memory() as f32 / gib,
            mem_used_gb: sys.used_memory() as f32 / gib,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_detection_never_reports_zero_memory() {
        assert!(detect_machine().memory_gb > 0);
    }
}
