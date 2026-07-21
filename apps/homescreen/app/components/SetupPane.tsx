"use client";

// Setup pane — the desktop port of the web control plane's `/setup` page
// (understudy-platform apps/web/app/(control-plane)/setup/page.tsx +
// app/setup/Quickstart.tsx + components/CopyInstallCommand.tsx). Faithful,
// traditional: the same five-step quickstart, agent-install card, and
// request-scoping-header reference, restyled onto the desktop token system.
//
// Deliberate deltas from the web page, all forced by the surface change:
//   - Data loads through the `setup_info` Tauri command (creds stay native)
//     instead of a server component with a WorkOS session.
//   - The onboarding handoff panel is dropped: its channel is an HTTP cookie
//     minted by the web signup flow, and on desktop the signed-in sk_* is
//     already durable in ~/.understudy/credentials.json — there is no
//     "only time we'll show the plaintext" moment to replicate.
//   - Internal links (/keys, /models, /p/:slug/logs) become pane navigation.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Eye, EyeOff, Terminal } from "lucide-react";
import { Button } from "./base-ui/button";
import { Input } from "./base-ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./base-ui/select";
import {
  BYOK_PROVIDERS,
  buildByokCurlSnippet,
  buildByokEnvSnippet,
  buildByokSdkSnippet,
  buildManagedCurlSnippet,
  buildManagedEnvSnippet,
  buildManagedSdkSnippet,
  DEFAULT_WORKLOAD_NAME,
  maskSecret,
  pickDefaultProjectSlug,
  type ByokProvider,
} from "../lib/setup-snippets.mjs";
import type { PaneId } from "./Sidebar";

type Mode = "byo" | "managed";

type SetupInfo = {
  connected: boolean;
  reason: string | null;
  gateway_url: string;
  org_id: string | null;
  api_key_suffix: string | null;
  keys_count: number;
  projects: Array<{ id: string; slug: string; name: string }>;
  models: Array<{ id: string; display_name: string }>;
};

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash";

export function SetupPane({
  onNavigate,
}: {
  onNavigate?: (pane: PaneId) => void;
}) {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<SetupInfo>("setup_info")
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Setup</h1>
        <p className="pane-sub">
          Five steps from a key to flowing traffic. Nothing typed here is
          stored — this page only generates the snippets your code needs.
        </p>
      </div>
      <div className="pane-body">
        {err ? (
          <div className="card">
            <div className="card-title">Setup data could not be loaded</div>
            <p className="card-sub" style={{ marginTop: 6 }}>{err}</p>
          </div>
        ) : !info ? (
          <div className="card">
            <p className="card-sub">Loading setup…</p>
          </div>
        ) : !info.connected ? (
          <div className="card">
            <div className="card-title">Not connected</div>
            <p className="card-sub" style={{ marginTop: 6 }}>
              {info.reason ?? "Sign in to connect your traffic to the gateway."}
            </p>
            {onNavigate ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => onNavigate("account")}
              >
                Open Account
              </Button>
            ) : null}
          </div>
        ) : (
          <Quickstart info={info} onNavigate={onNavigate} />
        )}

        <AgentInstallCard />
        <ScopingHeadersCard />
      </div>
    </>
  );
}

/** Port of `apps/web/app/setup/Quickstart.tsx`. */
function Quickstart({
  info,
  onNavigate,
}: {
  info: SetupInfo;
  onNavigate?: (pane: PaneId) => void;
}) {
  const [mode, setMode] = useState<Mode>("byo");
  const [provider, setProvider] = useState<ByokProvider>("anthropic");
  const [modelId, setModelId] = useState<string>(info.models[0]?.id ?? "");
  const [understudyKey, setUnderstudyKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [projectSlug, setProjectSlug] = useState(() =>
    pickDefaultProjectSlug(info.projects, null),
  );
  const workloadName = DEFAULT_WORKLOAD_NAME;
  const baseUrl = info.gateway_url;
  const keysCount = info.keys_count;

  const snippets = useMemo(() => {
    if (mode === "byo") {
      return {
        env: buildByokEnvSnippet(provider, understudyKey),
        curl: buildByokCurlSnippet({ provider, projectSlug, workloadName, baseUrl }),
        sdk: buildByokSdkSnippet({ provider, projectSlug, workloadName, baseUrl }),
      };
    }
    return {
      env: buildManagedEnvSnippet(understudyKey),
      curl: modelId
        ? buildManagedCurlSnippet({ modelId, projectSlug, workloadName, baseUrl })
        : "# no catalog models available yet",
      sdk: modelId
        ? buildManagedSdkSnippet({ modelId, projectSlug, workloadName, baseUrl })
        : "// no catalog models available yet",
    };
  }, [mode, provider, modelId, projectSlug, workloadName, understudyKey, baseUrl]);

  return (
    <>
      <StepCard
        step={1}
        title="Choose a path"
        description="Both routes go through the same gateway and produce the same captures."
      >
        <div
          role="radiogroup"
          aria-label="Connection path"
          className="grid gap-2 sm:grid-cols-2"
        >
          <PathOption
            selected={mode === "byo"}
            onSelect={() => setMode("byo")}
            title="Bring your own key"
            detail="Keep your Anthropic or OpenAI account; the gateway proxies with your provider key."
          />
          <PathOption
            selected={mode === "managed"}
            onSelect={() => setMode("managed")}
            title="Managed models"
            detail="No provider account — call any catalog model with just your sk_* key."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {mode === "byo" ? (
            <div className="grid content-start gap-2">
              <FieldLabel>Provider</FieldLabel>
              <div
                role="radiogroup"
                aria-label="Provider"
                className="grid grid-cols-2 overflow-hidden rounded-md border border-[var(--border)]"
              >
                {(Object.keys(BYOK_PROVIDERS) as ByokProvider[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={provider === id}
                    onClick={() => setProvider(id)}
                    className={`px-3 py-2 text-[0.72rem] uppercase tracking-[0.14em] transition-colors ${
                      provider === id
                        ? "bg-[var(--c-hover)] text-[var(--c-ink)]"
                        : "text-[var(--c-ink-muted)] hover:text-[var(--c-ink)]"
                    }`}
                  >
                    {BYOK_PROVIDERS[id].label}
                  </button>
                ))}
              </div>
              <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
                Per-request BYO is Anthropic and OpenAI only today.
              </p>
            </div>
          ) : (
            <div className="grid content-start gap-2">
              <FieldLabel htmlFor="quickstart-model">Catalog model</FieldLabel>
              {info.models.length > 0 ? (
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger id="quickstart-model" className="w-full">
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {info.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm text-[var(--c-ink-muted)]">
                  No catalog models yet.
                </p>
              )}
              <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
                Browse details on the{" "}
                <PaneLink onNavigate={onNavigate} pane="models">
                  Models pane
                </PaneLink>
                .
              </p>
            </div>
          )}

          <div className="grid content-start gap-2">
            <FieldLabel htmlFor="quickstart-project">Project</FieldLabel>
            {info.projects.length > 0 ? (
              <Select value={projectSlug} onValueChange={setProjectSlug}>
                <SelectTrigger id="quickstart-project" className="w-full">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {info.projects.map((project) => (
                    <SelectItem key={project.id} value={project.slug}>
                      {project.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm text-[var(--c-ink-muted)]">
                No projects yet.
              </p>
            )}
            <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
              Every snippet also sends workload <code>main</code>. Create a
              named workload for each stable call site before sending
              production traffic, so captures and route replacements stay
              attributable.
            </p>
          </div>
        </div>
      </StepCard>

      <StepCard
        step={2}
        title="Set your environment"
        description="Optionally paste your sk_* below to make the snippet runnable as-is. It stays on this machine — never sent to Understudy."
        action={<CopyButton value={snippets.env} />}
      >
        <div className="grid gap-3">
          <div className="grid gap-2 sm:max-w-[28rem]">
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor="quickstart-key">
                Understudy key (optional)
              </FieldLabel>
              <span className="text-[0.68rem] uppercase tracking-[0.14em] text-[var(--c-ink-muted)]">
                {understudyKey ? maskSecret(understudyKey) : "placeholder used"}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] rounded-md border border-[var(--border)]">
              <Input
                id="quickstart-key"
                value={understudyKey}
                onChange={(event) => setUnderstudyKey(event.target.value)}
                type={showKey ? "text" : "password"}
                placeholder={
                  keysCount > 0
                    ? "Paste the sk_* value you saved"
                    : "Create a key on the API keys page first"
                }
                className="h-10 rounded-r-none border-0 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "Hide key" : "Show key"}
                className="rounded-l-none border-l border-[var(--border)]"
              >
                {showKey ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
            <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
              {keysCount} active {keysCount === 1 ? "key" : "keys"}
              {info.api_key_suffix
                ? ` · this app is signed in with a key ending ${info.api_key_suffix}`
                : ""}{" "}
              ·{" "}
              <PaneLink onNavigate={onNavigate} pane="account">
                manage keys
              </PaneLink>
            </p>
          </div>
          <CodeBlock code={snippets.env} />
          {mode === "byo" ? (
            <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
              Replace the provider placeholder with your own{" "}
              {BYOK_PROVIDERS[provider].label} key. Provider keys ride the{" "}
              <code className="font-mono">x-understudy-upstream-key</code>{" "}
              header per request — Understudy never stores them.
            </p>
          ) : null}
        </div>
      </StepCard>

      <StepCard
        step={3}
        title="Send the smoke test"
        description="One request proves the whole path: auth, routing, capture."
        action={
          <CopyButton
            value={snippets.curl}
            icon={<Terminal className="size-3.5" aria-hidden="true" />}
          />
        }
      >
        <CodeBlock code={snippets.curl} />
      </StepCard>

      <StepCard
        step={4}
        title="Wire up your SDK"
        description="The same change in application code: point the base URL at the gateway."
        action={<CopyButton value={snippets.sdk} />}
      >
        <CodeBlock code={snippets.sdk} />
      </StepCard>

      <StepCard
        step={5}
        title="Verify in captures"
        description="The smoke test appears in your capture stream within seconds. Check the response's x-understudy-route and x-understudy-effective-model headers to see how it resolved."
        action={
          onNavigate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate("capture")}
            >
              Open captures
            </Button>
          ) : null
        }
      />
    </>
  );
}

/** Port of `apps/web/components/CopyInstallCommand.tsx` plus its host card. */
function AgentInstallCard() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Command stays selectable below if clipboard permissions fail.
    }
  };

  return (
    <div className="card">
      <div className="card-title">Or let your agent do it</div>
      <p className="card-sub" style={{ marginTop: 2, marginBottom: 12 }}>
        The open-source agent tools teach Claude Code this whole flow —
        capture, evals, routing — and run it against your repo. One line, run
        from the repo you want to optimize:
      </p>
      <div className="grid min-w-0 gap-3">
        <div className="grid min-w-0 gap-0 rounded-md border border-[var(--border)] bg-[var(--c-hover)] sm:grid-cols-[minmax(0,1fr)_auto]">
          <pre className="min-w-0 overflow-x-auto px-4 py-3.5 text-[0.78rem] leading-[1.6]">
            <code className="font-mono select-all">{INSTALL_COMMAND}</code>
          </pre>
          <button
            type="button"
            onClick={copy}
            className="border-t border-[var(--border)] px-5 py-3.5 text-[0.68rem] font-medium uppercase tracking-[0.18em] transition-colors hover:bg-[var(--c-ink)] hover:text-[var(--c-paper)] sm:border-l sm:border-t-0"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <p className="text-xs leading-5 text-[var(--c-ink-muted)]">
          Run it from the repo you want to optimize. It installs the CLI and
          the Claude Code plugin, then opens Claude Code —{" "}
          <code className="font-mono">/understudy:onboard</code> takes it from
          there. MIT-licensed:{" "}
          <a
            href="https://github.com/understudylabs/understudy-agent-tools"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-[var(--c-ink)]"
          >
            github.com/understudylabs/understudy-agent-tools
          </a>{" "}
          · documented at{" "}
          <a
            href="https://docs.understudylabs.com/open-source/agent-tools"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-[var(--c-ink)]"
          >
            docs.understudylabs.com
          </a>
        </p>
      </div>
    </div>
  );
}

function ScopingHeadersCard() {
  return (
    <div className="card">
      <div className="card-title">Request scoping headers</div>
      <p className="card-sub" style={{ marginTop: 2, marginBottom: 12 }}>
        Set both on application traffic to bind captures and future route
        replacements to a stable call site. Missing values fall back to the
        rehearsal project and its main workload.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <HeaderField label="project scope" value="x-understudy-project: <slug>" />
        <HeaderField
          label="workload scope"
          value="x-understudy-workload: <name>"
        />
        <HeaderField
          label="bring your own key"
          value="x-understudy-upstream-key: <provider key>"
        />
        <HeaderField
          label="request tags"
          value='x-understudy-tags: {"env":"prod"}'
        />
      </div>
    </div>
  );
}

function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.68rem] font-medium uppercase tracking-[0.16em] text-[var(--c-ink-muted)]">
        {label}
      </p>
      <code className="mt-2 block select-all break-all rounded-md border border-[var(--border)] bg-[var(--c-hover)] p-3 font-mono text-xs text-[var(--c-ink)]">
        {value}
      </code>
    </div>
  );
}

function StepCard({
  step,
  title,
  description,
  action,
  children,
}: {
  step: number;
  title: string;
  description: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card min-w-0">
      <div className="card-row" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="card-title flex items-center gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center border border-[var(--c-stamp)]/60 text-[0.68rem] text-[var(--c-stamp)]">
              {step}
            </span>
            {title}
          </div>
          <p className="card-sub" style={{ marginTop: 4 }}>{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </div>
  );
}

function PathOption({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`grid min-w-0 content-start gap-1 rounded-md border p-4 text-left transition-colors ${
        selected
          ? "border-[var(--c-stamp)] bg-[var(--c-stamp)]/5"
          : "border-[var(--border)] hover:border-[var(--c-ink-muted)]"
      }`}
    >
      <span className="text-[0.72rem] font-medium uppercase tracking-[0.14em]">
        {title}
      </span>
      <span className="text-xs leading-5 text-[var(--c-ink-muted)]">
        {detail}
      </span>
    </button>
  );
}

function CopyButton({ value, icon }: { value: string; icon?: ReactNode }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          // The visible snippet remains selectable if clipboard fails.
        }
      }}
    >
      {icon ?? <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="max-h-[24rem] overflow-auto rounded-md border border-[var(--border)] bg-[var(--c-hover)] p-4 text-xs leading-6 text-[var(--c-ink)]">
      <code className="font-mono">{code}</code>
    </pre>
  );
}

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-sm font-medium text-[var(--c-ink)]"
    >
      {children}
    </label>
  );
}

function PaneLink({
  onNavigate,
  pane,
  children,
}: {
  onNavigate?: (pane: PaneId) => void;
  pane: PaneId;
  children: ReactNode;
}) {
  if (!onNavigate) return <span className="underline">{children}</span>;
  return (
    <button
      type="button"
      onClick={() => onNavigate(pane)}
      className="underline underline-offset-2 hover:text-[var(--c-ink)]"
    >
      {children}
    </button>
  );
}
