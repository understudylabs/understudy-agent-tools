"use client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

export type ServiceState = {
  id: string;
  name: string;
  desc: string;
  state: string;
};

export type SlotView = {
  id: number;
  model_id: string | null;
  state: string; // running | loading | stopped | error
  port: number | null;
  mem_gb: number;
  load_ms: number | null;
};

export type ResidencySnapshot = {
  slots: SlotView[];
  used_gb: number;
  usable_gb: number;
};

export type Machine = { chip: string; memory_gb: number };

export type Metrics = {
  cpu_pct: number;
  mem_used_gb: number;
  mem_total_gb: number;
};

export type StatusSnapshot = {
  connected: boolean;
  services: ServiceState[];
  machine: Machine;
  metrics: Metrics;
  residency: ResidencySnapshot;
  local_base_url: string;
};

export type StatusController = {
  snap: StatusSnapshot | null;
  busy: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => void;
};

export function useStatus(): StatusController {
  const [snap, setSnap] = useState<StatusSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    invoke<StatusSnapshot>("get_status")
      .then(setSnap)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const unsubStatus = listen<StatusSnapshot>("status-changed", (e) => setSnap(e.payload));
    const unsubRes = listen("residency-changed", () => refresh());
    const poll = setInterval(refresh, 2000);
    return () => {
      unsubStatus.then((u) => u());
      unsubRes.then((u) => u());
      clearInterval(poll);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("connect");
    } finally {
      setBusy(false);
      refresh();
    }
  }, [refresh]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("disconnect");
    } finally {
      setBusy(false);
      refresh();
    }
  }, [refresh]);

  return { snap, busy, connect, disconnect, refresh };
}
