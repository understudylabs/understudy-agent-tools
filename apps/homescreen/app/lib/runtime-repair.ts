export type RuntimeRepairRequest = {
  runtime: string;
  reason: string;
  command: string;
};

export type VersionHealth = {
  id: string;
  label: string;
  available: boolean;
  installed_version?: string | null;
  latest_version?: string | null;
  update_available?: boolean | null;
  detail: string;
};

export type DesktopHealth = {
  checked_at: string;
  online: boolean;
  desktop: VersionHealth;
  cli: VersionHealth;
  mlx_vlm: VersionHealth;
  conversation_runtime: VersionHealth;
};

export type RepairPrompt = RuntimeRepairRequest & {
  title: string;
  actionLabel: string;
};

export const CLI_INSTALL_COMMAND =
  "https://github.com/understudylabs/understudy-agent-tools/releases/latest";

export const MLX_REPAIR_REQUEST: RuntimeRepairRequest = {
  runtime: "mlx-vlm",
  reason: "The local model runtime is missing or unhealthy.",
  command: "understudy models runtime repair",
};

export const CONVERSATION_RUNTIME_REPAIR_REQUEST: RuntimeRepairRequest = {
  runtime: "conversation-runtime",
  reason: "The managed conversation runtime is missing, stale, or unhealthy.",
  command: "understudy runtime repair",
};

export function isMissingMlxVlmError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("mlx-vlm") ||
    text.includes("mlx_vlm") ||
    (text.includes("local model server") &&
      (text.includes("not found") ||
        text.includes("no such file") ||
        text.includes("did not become ready")))
  );
}

export function isConversationRuntimeError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("conversation runtime") ||
    text.includes("vercel-ai-sdk") ||
    text.includes("understudy-conversation-runtime-event")
  );
}

export function promptForRuntimeRequest(request: RuntimeRepairRequest): RepairPrompt {
  return {
    ...request,
    title: request.runtime === "mlx-vlm" ? "Local models need repair" : "Runtime needs repair",
    actionLabel: "Repair with CLI",
  };
}

export function promptForHealth(health: DesktopHealth): RepairPrompt | null {
  if (!health.cli.available) {
    return {
      runtime: "cli",
      title: "Desktop CLI needs repair",
      reason: "Restore the self-contained CLI included with Understudy Desktop.",
      command: CLI_INSTALL_COMMAND,
      actionLabel: "Restore CLI",
    };
  }
  if (health.cli.update_available === true) {
    const versions = health.cli.latest_version
      ? `${health.cli.installed_version ?? "installed"} → ${health.cli.latest_version}`
      : health.cli.detail;
    return {
      runtime: "cli",
      title: "Understudy Desktop update required",
      reason: versions,
      command: CLI_INSTALL_COMMAND,
      actionLabel: "Update Desktop",
    };
  }
  if (!health.mlx_vlm.available) {
    return promptForRuntimeRequest({
      ...MLX_REPAIR_REQUEST,
      reason: health.mlx_vlm.detail || MLX_REPAIR_REQUEST.reason,
    });
  }
  if (!health.conversation_runtime.available) {
    const reconnecting = health.conversation_runtime.detail.includes(
      "reconnecting automatically",
    );
    const prompt = promptForRuntimeRequest({
      ...CONVERSATION_RUNTIME_REPAIR_REQUEST,
      reason: health.conversation_runtime.detail || CONVERSATION_RUNTIME_REPAIR_REQUEST.reason,
    });
    return reconnecting
      ? {
          ...prompt,
          title: "Runtime reconnecting",
          actionLabel: "Reconnect now",
        }
      : prompt;
  }
  if (health.desktop.update_available === true) {
    return {
      runtime: "desktop",
      title: "Understudy Desktop update available",
      reason: `${health.desktop.installed_version ?? "installed"} → ${health.desktop.latest_version ?? "latest"}`,
      command: "https://github.com/understudylabs/understudy-agent-tools/releases/latest",
      actionLabel: "Open download",
    };
  }
  return null;
}
