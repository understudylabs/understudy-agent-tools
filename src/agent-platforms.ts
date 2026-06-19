export type AgentPlatformStatus = "supported" | "planned";

export type AgentPlatformAdapter = {
  id: string;
  displayName: string;
  status: AgentPlatformStatus;
  manifestPath: string;
  discovery: string;
  install: string[];
  reload: string;
  uninstall: string[];
  onboarding: string;
  notes: string[];
};

export const agentPlatformAdapters: AgentPlatformAdapter[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    status: "supported",
    manifestPath: ".claude-plugin/plugin.json",
    discovery: "Claude Code local marketplace plugin with skills discovered from skills/",
    install: [
      'REPO="$(git rev-parse --show-toplevel)"',
      'claude plugin marketplace add "$REPO"',
      "claude plugin install understudy@understudy-skills",
    ],
    reload: "Run /reload-plugins in Claude Code.",
    uninstall: [
      "claude plugin uninstall understudy@understudy-skills",
      "claude plugin marketplace remove understudy-skills",
    ],
    onboarding: "Run /understudy:onboard.",
    notes: [
      "Best current default for guided onboarding.",
      "The agent cannot run Claude slash commands; the developer runs reload and onboarding.",
    ],
  },
  {
    id: "cursor",
    displayName: "Cursor",
    status: "supported",
    manifestPath: ".cursor-plugin/plugin.json",
    discovery: "Cursor local plugin with skills discovered from skills/ at the plugin root",
    install: [
      'REPO="$(git rev-parse --show-toplevel)"',
      'mkdir -p "$HOME/.cursor/plugins/local"',
      'rm -rf "$HOME/.cursor/plugins/local/understudy"',
      'ln -s "$REPO" "$HOME/.cursor/plugins/local/understudy"',
    ],
    reload: "Restart Cursor or run Developer: Reload Window.",
    uninstall: ['rm -f "$HOME/.cursor/plugins/local/understudy"'],
    onboarding: "Ask Cursor Agent: Use the Understudy onboarding skill for this project.",
    notes: [
      "Uses Cursor's local plugin loader rather than a VSIX wrapper.",
      "A future VS Code/Cursor extension can call Cursor's plugin path API against the same plugin directory.",
    ],
  },
  {
    id: "codex",
    displayName: "Codex",
    status: "supported",
    manifestPath: ".codex-plugin/plugin.json",
    discovery: "Codex local marketplace plugin with skills discovered from skills/",
    install: [
      'REPO="$(git rev-parse --show-toplevel)"',
      'codex plugin marketplace add "$REPO"',
    ],
    reload: "Open /plugins in Codex, install or enable the understudy plugin, then start a new thread if needed.",
    uninstall: ["codex plugin marketplace remove understudy-skills"],
    onboarding: "Ask Codex: Use the Understudy onboarding skill for this project.",
    notes: [
      "The CLI registers the marketplace; the Codex plugin browser owns final install/enable.",
      "AGENTS.md remains repo guidance, but the plugin is the reusable distribution unit.",
    ],
  },
];

export function findAgentPlatformAdapter(id: string): AgentPlatformAdapter | undefined {
  return agentPlatformAdapters.find((adapter) => adapter.id === id);
}
