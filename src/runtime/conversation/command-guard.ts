import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommandGuardDecision =
  | { decision: "allow" }
  | {
      decision: "block";
      rule_id: string;
      reason: string;
      severity: "high" | "critical";
    };

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "exec_command",
  "run_command",
  "run_shell_command",
  "shell",
  "terminal",
]);

type GuardRule = {
  id: string;
  reason: string;
  severity: "high" | "critical";
  matches: (command: string) => boolean;
};

function executableText(command: string): string {
  return command
    .normalize("NFKC")
    .replace(/\\\r?\n/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .trim();
}

function isClearlyInertTextCommand(command: string): boolean {
  if (/[;&|\n]|\$\(|`|<\(|>\(/.test(command)) return false;
  return /^(?:(?:command\s+)?(?:rg|grep|ag|ack)\b|git\b[^\n]*\b(?:commit|log)\b|(?:echo|printf)\b)/i.test(
    command,
  );
}

function invocation(command: string, executable: string): string[] {
  const matches: string[] = [];
  const pattern = new RegExp(`\\b${executable}\\s+([^;&|\\n]+)`, "gi");
  for (const match of command.matchAll(pattern)) matches.push(match[1]);
  return matches;
}

function shellWords(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
    word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"),
  );
}

function recursiveForcedRemove(command: string): { matched: boolean; critical: boolean } {
  for (const args of invocation(command, "rm")) {
    const words = shellWords(args);
    const recursive = words.some(
      (word) => word === "--recursive" || /^-[^-]*r/.test(word),
    );
    const forced = words.some(
      (word) => word === "--force" || /^-[^-]*f/.test(word),
    );
    if (!recursive || !forced) continue;
    const operands = words.filter((word) => !word.startsWith("-"));
    const critical = operands.some((operand) => {
      const target = operand.replace(/\/+$/, "") || "/";
      return (
        ["/", ".", "..", "~", "$HOME", "${HOME}"].includes(target) ||
        /^(?:\/|~|\$HOME|\$\{HOME\})\/\*$/.test(operand) ||
        /\$(?:\{?[A-Za-z_][A-Za-z0-9_]*\}?)(?:\/|\*|$)/.test(operand)
      );
    });
    return { matched: true, critical };
  }
  return { matched: false, critical: false };
}

const RULES: GuardRule[] = [
  {
    id: "shell.fork-bomb",
    reason: "This command appears to create an unbounded process fork bomb.",
    severity: "critical",
    matches: (command) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(command),
  },
  {
    id: "filesystem.rm-critical-target",
    reason: "Recursive forced deletion targets a root, home, working directory, or variable-derived path.",
    severity: "critical",
    matches: (command) => recursiveForcedRemove(command).critical,
  },
  {
    id: "filesystem.rm-recursive-force",
    reason: "Recursive forced deletion can permanently remove uncommitted or user data.",
    severity: "high",
    matches: (command) => recursiveForcedRemove(command).matched,
  },
  {
    id: "storage.raw-device-write",
    reason: "This command formats, erases, or writes directly to a block device.",
    severity: "critical",
    matches: (command) =>
      /\b(?:mkfs(?:\.[A-Za-z0-9_+-]+)?|wipefs)\b/i.test(command) ||
      /\bdiskutil\s+(?:eraseDisk|zeroDisk|secureErase)\b/i.test(command) ||
      /\bdd\b[^;&|\n]*\bof\s*=\s*\/dev\//i.test(command),
  },
  {
    id: "process.mass-kill",
    reason: "This command can terminate every process available to the current user or system.",
    severity: "critical",
    matches: (command) =>
      /\bkill\b[^;&|\n]*(?:-9\s+-1|--signal\s+KILL\s+-1)\b/i.test(command) ||
      /\bpkill\b[^;&|\n]*\s-(?:9|KILL)\b[^;&|\n]*(?:\.\*|\^\.\*\$)/i.test(command),
  },
  {
    id: "git.discard-worktree",
    reason: "This Git operation can discard uncommitted work or unreachable local commits.",
    severity: "high",
    matches: (command) =>
      /\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/i.test(command) ||
      /\bgit\b[^;&|\n]*\bclean\b(?=[^;&|\n]*-[A-Za-z]*f)[^;&|\n]*/i.test(command) ||
      /\bgit\b[^;&|\n]*\bcheckout\s+--(?:\s|$)/i.test(command) ||
      /\bgit\b[^;&|\n]*\brestore\b/i.test(command) ||
      /\bgit\b[^;&|\n]*\bbranch\b[^;&|\n]*(?:-D|--delete\s+--force)\b/i.test(command) ||
      /\bgit\b[^;&|\n]*\bstash\s+(?:clear|drop)\b/i.test(command),
  },
  {
    id: "git.rewrite-remote",
    reason: "This Git operation can overwrite remote history.",
    severity: "high",
    matches: (command) => /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*--force(?:=|\s|$)/i.test(command),
  },
  {
    id: "database.destructive-ddl",
    reason: "This command contains destructive database DDL.",
    severity: "high",
    matches: (command) =>
      /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i.test(command) ||
      /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_]/i.test(command) ||
      /\b(?:dropdb|redis-cli\s+(?:FLUSHALL|FLUSHDB))\b/i.test(command),
  },
  {
    id: "infrastructure.destroy",
    reason: "This command destroys infrastructure, namespaces, or persistent container data.",
    severity: "high",
    matches: (command) =>
      /\b(?:terraform|tofu|pulumi)\s+destroy\b/i.test(command) ||
      /\bkubectl\b[^;&|\n]*\bdelete\s+(?:namespace|ns)\b/i.test(command) ||
      /\bdocker\s+(?:system|volume)\s+prune\b/i.test(command) ||
      /\bdocker\s+compose\b[^;&|\n]*\bdown\b[^;&|\n]*(?:-v|--volumes)\b/i.test(command),
  },
  {
    id: "cloud.bulk-delete",
    reason: "This command can recursively delete cloud data or an entire cloud project.",
    severity: "high",
    matches: (command) =>
      /\baws\s+s3\s+rm\b[^;&|\n]*--recursive\b/i.test(command) ||
      /\bgsutil\b[^;&|\n]*\brm\b[^;&|\n]*-[A-Za-z]*r/i.test(command) ||
      /\bgcloud\s+projects\s+delete\b/i.test(command) ||
      /\baz\s+group\s+delete\b/i.test(command),
  },
  {
    id: "supply-chain.remote-pipe-shell",
    reason: "Piping downloaded content directly into a shell executes unreviewed remote code.",
    severity: "high",
    matches: (command) =>
      /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/i.test(command),
  },
];

export function shellCommandFromToolCall(
  toolName: string,
  input: unknown,
): string | null | undefined {
  if (!SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return null;
}

export function classifyShellToolCall(toolName: string, input: unknown): CommandGuardDecision {
  const raw = shellCommandFromToolCall(toolName, input);
  if (raw === undefined) return { decision: "allow" };
  if (raw === null) {
    return {
      decision: "block",
      rule_id: "shell.malformed-command",
      reason: "Shell tools must provide a non-empty command, cmd, or script string.",
      severity: "high",
    };
  }
  const command = executableText(raw);
  if (isClearlyInertTextCommand(command)) return { decision: "allow" };
  const match = RULES.find((rule) => rule.matches(command));
  return match
    ? {
        decision: "block",
        rule_id: match.id,
        reason: match.reason,
        severity: match.severity,
      }
    : { decision: "allow" };
}

export function commandGuardBlockMessage(decision: Exclude<CommandGuardDecision, { decision: "allow" }>): string {
  return `Blocked by Understudy command guard [${decision.rule_id}]: ${decision.reason} Review and run this command manually if the destructive action is intentional.`;
}

export function enforceShellToolCall(toolName: string, input: unknown): void {
  const decision = classifyShellToolCall(toolName, input);
  if (decision.decision === "block") throw new Error(commandGuardBlockMessage(decision));
}

export function piCommandGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    const decision = classifyShellToolCall(event.toolName, event.input);
    if (decision.decision === "block") {
      return { block: true, reason: commandGuardBlockMessage(decision) };
    }
  });
}
