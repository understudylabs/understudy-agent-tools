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
  {
    id: "opencode",
    displayName: "OpenCode",
    status: "supported",
    manifestPath: ".opencode/adapter.json",
    discovery: "OpenCode skills/commands adapter: native skills discovered from .opencode/skills or ~/.config/opencode/skills; command markdown discovered from .opencode/commands or ~/.config/opencode/commands",
    install: [
      'REPO="$(git rev-parse --show-toplevel)"',
      'mkdir -p "$HOME/.config/opencode/skills" "$HOME/.config/opencode/commands"',
      'for skill in "$REPO"/skills/*; do [ -f "$skill/SKILL.md" ] || continue; dest="$HOME/.config/opencode/skills/$(basename "$skill")"; [ -e "$dest" ] || [ -L "$dest" ] || ln -s "$skill" "$dest"; done',
      '[ -e "$HOME/.config/opencode/commands/understudy-onboard.md" ] || ln -s "$REPO/.opencode/commands/understudy-onboard.md" "$HOME/.config/opencode/commands/understudy-onboard.md"',
    ],
    reload: "Restart OpenCode or open a new TUI session so it reloads global skills and commands.",
    uninstall: [
      'find "$HOME/.config/opencode/skills" -type l -lname "*/understudy-agent-tools/skills/*" -delete',
      'rm -f "$HOME/.config/opencode/commands/understudy-onboard.md"',
    ],
    onboarding: "Run /understudy-onboard, or ask OpenCode: Use the Understudy onboarding skill for this project.",
    notes: [
      ".opencode/adapter.json is an Understudy version/staleness sentinel, not an OpenCode plugin manifest.",
      "OpenCode JS/TS plugins are for lifecycle hooks; this adapter intentionally uses native skills and commands.",
      "OpenCode loads SKILL.md definitions natively; no copied skill content or provider calls are required.",
      "The installer links every public skill because OpenCode skill names are global and sibling skill references must stay intact.",
      "Symlink targets live outside many user projects, so OpenCode may ask before reading linked external resources.",
    ],
  },
  {
    id: "hermes",
    displayName: "Hermes Agent",
    status: "supported",
    manifestPath: ".hermes/adapter.json",
    discovery:
      "Hermes Agent registers a durable ~/.understudy/skills symlink (to the shared skills/ tree) in skills.external_dirs (~/.hermes/config.yaml); it discovers SKILL.md skills natively alongside ~/.hermes/skills, with local skills winning on name conflicts",
    install: [
      'REPO="$(git rev-parse --show-toplevel)"',
      'LINK="$HOME/.understudy/skills"',
      'CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"',
      'mkdir -p "$HOME/.understudy"; [ -e "$LINK" ] || ln -s "$REPO/skills" "$LINK"',
      `python3 -c "import sys,os,yaml;p,d=sys.argv[1],sys.argv[2];c=(yaml.safe_load(open(p)) or {}) if os.path.exists(p) else {};c=c if isinstance(c,dict) else {};s=c.get('skills') if isinstance(c.get('skills'),dict) else {};c['skills']=s;e=s.get('external_dirs') or [];e=[e] if isinstance(e,str) else (e if isinstance(e,list) else []);(d in e) or e.append(d);s['external_dirs']=e;os.makedirs(os.path.dirname(p) or '.',exist_ok=True);yaml.safe_dump(c,open(p,'w'),sort_keys=False)" "$CONFIG" "$LINK"`,
    ],
    reload: "Run /reload-skills in Hermes (or start a new `hermes` session) to rescan skills.external_dirs.",
    uninstall: [
      'CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"',
      'LINK="$HOME/.understudy/skills"',
      `python3 -c "import sys,os,yaml;p,d=sys.argv[1],sys.argv[2];c=(yaml.safe_load(open(p)) or {}) if os.path.exists(p) else {};s=c.get('skills') if isinstance(c.get('skills'),dict) else {};e=s.get('external_dirs') or [];e=[e] if isinstance(e,str) else (e if isinstance(e,list) else []);s['external_dirs']=[x for x in e if x!=d];yaml.safe_dump(c,open(p,'w'),sort_keys=False)" "$CONFIG" "$LINK"`,
      '[ -L "$LINK" ] && rm -f "$LINK"',
    ],
    onboarding: "In Hermes run /onboard, or ask Hermes: Use the Understudy onboarding skill for this project.",
    notes: [
      ".hermes/adapter.json is an Understudy version/staleness sentinel, not a Hermes plugin manifest.",
      "Hermes discovers SKILL.md skills natively; registering skills/ via skills.external_dirs needs no copies and keeps the shared tree as the single source of truth.",
      "The installer registers a stable ~/.understudy/skills symlink so the config entry survives checkout/package moves; a reinstall just re-points the link. external_dirs expands ~ and ${VAR} and silently skips missing paths.",
      "Edits to ~/.hermes/config.yaml are idempotent and back up the file first; /reload-skills rescans without a restart.",
      "Local ~/.hermes/skills entries win on name conflicts, so a few generically named skills may be shadowed by Hermes bundled skills.",
    ],
  },
  {
    id: "devin",
    displayName: "Devin",
    status: "supported",
    manifestPath: ".devin/adapter.json",
    discovery:
      "Devin reads AGENTS.md as an injected rule and accesses the shared skills/ tree directly from the cloned repo; .devin/skills is a symlink to skills/ for project-level discovery",
    install: [
      "npm install -g @understudylabs/understudy-agent-tools",
    ],
    reload: "Each Devin session starts fresh from a snapshot; no reload step is needed.",
    uninstall: [
      "npm uninstall -g @understudylabs/understudy-agent-tools",
    ],
    onboarding: "Ask Devin: Use the Understudy onboarding skill for this project.",
    notes: [
      ".devin/adapter.json is an Understudy version/staleness sentinel, not a manifest consumed by Devin.",
      "Devin is cloud-based: each session boots from a snapshot, so the install is a global npm package rather than a local plugin registration.",
      "Devin reads AGENTS.md automatically as a repository rule; the shared skills/ tree is accessible from the cloned repo without additional linking.",
      "For persistent installs, add the npm install to the Devin environment blueprint so every session starts with the CLI on PATH.",
      "Knowledge notes or playbooks can reference specific skills for guided workflows.",
    ],
  },
];

export function findAgentPlatformAdapter(id: string): AgentPlatformAdapter | undefined {
  return agentPlatformAdapters.find((adapter) => adapter.id === id);
}
