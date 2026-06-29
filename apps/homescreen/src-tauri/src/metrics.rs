use serde::Serialize;
use std::sync::Mutex;
use sysinfo::System;

/// Static, detected-once machine summary shown on the Status pane.
#[derive(Serialize, Clone, Default)]
pub struct Machine {
    pub chip: String,
    pub memory_gb: u64,
}

pub fn detect_machine() -> Machine {
    let sys = System::new_all();
    let chip = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Apple Silicon".to_string());
    Machine {
        chip,
        memory_gb: sys.total_memory() / (1024 * 1024 * 1024),
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
        let mut sys = System::new_all();
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
