"use client";

// Settings — faithful port of the hosted control plane's settings surfaces
// (org / account and project settings). Traditional management UI on the
// app's existing tokens/primitives; server components + server actions
// become client loaders over Tauri commands (settings.rs → admin/v1 with
// the credentials.json sk_ key; the key never enters the webview).
//
// Deliberate deltas from the web (auth model, not design):
// - Identity is credential-derived. sk_ keys carry no WorkOS user, so the
//   web's email/name/user-id fields become org / auth mode / key suffix.
// - Sign out maps to `account_logout` (the web's /logout route).

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/base-ui/dialog";
import type { Scope } from "../lib/nav";
import {
  deleteConfirmed,
  normalizeProjects,
  projectForScope,
  renameState,
  type ProjectRow,
} from "../lib/settings-logic.mjs";

type Any = Record<string, unknown>;

export function SettingsPane({ scope }: { scope: Scope }) {
  const [status, setStatus] = useState<Any | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    invoke<Any>("account_status")
      .then(setStatus)
      .catch((e) => setStatusErr(String(e)));
  }, []);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const signedIn = Boolean(status?.signed_in);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Settings</h1>
        <p className="pane-sub">
          Your identity, your workspace, and the endpoints this app manages.
        </p>
      </div>
      <div className="pane-body">
        {statusErr ? <div className="chat-err">{statusErr}</div> : null}
        {!status && !statusErr ? (
          <div className="card">
            <div className="card-sub">Loading account…</div>
          </div>
        ) : null}
        {status ? (
          <AccountCard
            status={status}
            signedIn={signedIn}
            onSignedOut={refreshStatus}
          />
        ) : null}
        {status ? <EndpointsCard status={status} /> : null}
        {signedIn ? <ProjectSettings scope={scope} /> : null}
      </div>
    </>
  );
}

// ---- org / account (web: (control-plane)/settings/page.tsx) ----

function AccountCard({
  status,
  signedIn,
  onSignedOut,
}: {
  status: Any;
  signedIn: boolean;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Account</div>
        <div className="card-sub">
          Sign in to view account settings — use the API keys pane to sign in
          or create an account.
        </div>
      </div>
    );
  }

  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("account_logout");
      onSignedOut();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div className="card-title" style={{ marginBottom: 4 }}>Account</div>
          <div className="card-sub" style={{ marginBottom: 12 }}>
            Identity comes from your Understudy credential — managed at
            sign-in, not here.
          </div>
        </div>
        <button className="btn" disabled={busy} onClick={signOut}>
          {busy ? "Signing out" : "Sign out"}
        </button>
      </div>
      {err ? <div className="chat-err">{err}</div> : null}
      <div className="settings-field-grid">
        <SettingsField
          label="organization"
          value={typeof status.org_id === "string" ? status.org_id : "no organization"}
        />
        <SettingsField
          label="auth mode"
          value={typeof status.auth_mode === "string" ? status.auth_mode : "—"}
        />
        <SettingsField
          label="api key"
          value={
            typeof status.api_key_suffix === "string"
              ? `sk_…${status.api_key_suffix}`
              : "—"
          }
        />
      </div>
    </div>
  );
}

function EndpointsCard({ status }: { status: Any }) {
  const gateway =
    typeof status.gateway_url === "string"
      ? status.gateway_url
      : "https://api.understudylabs.com";
  // Derive the dashboard endpoint from the resolved gateway host rather than
  // embedding a control-plane URL literal: the gateway's `api.` host maps to
  // the `app.` dashboard host on the same domain.
  const dashboard =
    typeof status.dashboard_url === "string"
      ? status.dashboard_url
      : gateway.replace(/\/\/api\./, "//app.");
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Endpoints</div>
      <div className="card-sub" style={{ marginBottom: 12 }}>
        Where your traffic and control-plane calls go.
      </div>
      <div className="settings-field-grid">
        <SettingsField label="gateway (proxy traffic)" value={gateway} />
        <SettingsField label="dashboard" value={dashboard} />
      </div>
    </div>
  );
}

function SettingsField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="settings-field-label">{label}</p>
      <code className="settings-field-value">{value}</code>
    </div>
  );
}

// ---- project settings (web: p/[project_slug]/settings/*) ----

function ProjectSettings({ scope }: { scope: Scope }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>("settings_projects_list")
      .then((value) => {
        if (!cancelled) {
          setErr(null);
          setProjects(normalizeProjects(value));
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const project = useMemo(() => {
    if (!projects) return null;
    if (selectedSlug) {
      const chosen = projects.find((p) => p.slug === selectedSlug);
      if (chosen) return chosen;
    }
    return projectForScope(projects, scope.projectId);
  }, [projects, selectedSlug, scope.projectId]);

  return (
    <>
      <div className="pane-head" style={{ marginTop: 8 }}>
        <h2 className="pane-title" style={{ fontSize: 15 }}>Project settings</h2>
        <p className="pane-sub">
          Rename the project, look up its identifiers, or retire it.
        </p>
      </div>
      {err ? (
        <div className="chat-err">
          {err}{" "}
          <button className="btn" style={{ marginLeft: 8 }} onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}
      {!projects && !err ? (
        <div className="card">
          <div className="card-sub">Loading projects…</div>
        </div>
      ) : null}
      {projects && projects.length === 0 ? (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>No projects</div>
          <div className="card-sub">
            This organization has no projects yet. Create one with{" "}
            <code>understudy init</code> or from the dashboard.
          </div>
        </div>
      ) : null}
      {projects && projects.length > 1 && project ? (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="card-sub" style={{ marginBottom: 0 }}>Project</span>
          <select
            className="assign-select"
            value={project.slug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            aria-label="Project"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.slug}>
                {typeof p.name === "string" && p.name ? p.name : p.slug}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {project ? (
        <>
          <RenameCard key={`rename-${project.id}`} project={project} onRenamed={reload} />
          <IdentityCard project={project} />
          <DangerZoneCard
            key={`danger-${project.id}`}
            project={project}
            onDeleted={() => {
              setSelectedSlug(null);
              reload();
            }}
          />
        </>
      ) : null}
    </>
  );
}

function RenameCard({
  project,
  onRenamed,
}: {
  project: ProjectRow;
  onRenamed: () => void;
}) {
  const currentName = typeof project.name === "string" ? project.name : project.slug;
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const { name: trimmed, dirty } = renameState(name, currentName);

  const save = async () => {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await invoke("settings_project_rename", {
        slug: project.slug,
        name: trimmed,
      });
      setSaved(true);
      onRenamed();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Project name</div>
      <div className="card-sub" style={{ marginBottom: 12 }}>
        Display name only. The slug is immutable — it is the identity your
        code sends in <code>x-understudy-project</code>, so renaming never
        breaks live traffic.
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !pending) void save();
        }}
        style={{ display: "flex", gap: 10, alignItems: "center", maxWidth: 480 }}
      >
        <input
          className="assign-select"
          style={{ flex: 1 }}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          maxLength={120}
          disabled={pending}
          aria-label="Project name"
        />
        <button type="submit" className="btn" disabled={!dirty || pending}>
          {pending ? "Saving" : "Save"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="settings-danger-text">{error}</p>
      ) : null}
      {saved ? <p className="card-sub" style={{ marginTop: 8 }}>Saved.</p> : null}
    </div>
  );
}

function IdentityCard({ project }: { project: ProjectRow }) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Identity</div>
      <div className="card-sub" style={{ marginBottom: 12 }}>
        References for the CLI, SDK headers, and support requests.
      </div>
      <div className="settings-field-grid">
        <SettingsField label="slug" value={project.slug} />
        <SettingsField label="project id" value={project.id} />
        <SettingsField
          label="organization"
          value={typeof project.org_id === "string" ? project.org_id : "—"}
        />
        <SettingsField
          label="created"
          value={
            typeof project.created_at === "string"
              ? project.created_at.slice(0, 10)
              : "—"
          }
        />
      </div>
    </div>
  );
}

function DangerZoneCard({
  project,
  onDeleted,
}: {
  project: ProjectRow;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const confirmed = deleteConfirmed(confirmation, project.slug);
  const projectName =
    typeof project.name === "string" && project.name ? project.name : project.slug;

  const doDelete = async () => {
    setError(null);
    setPending(true);
    try {
      await invoke("settings_project_delete", { slug: project.slug });
      setOpen(false);
      onDeleted();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card settings-danger-card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div className="card-title settings-danger-text" style={{ marginBottom: 4 }}>
            Danger zone
          </div>
          <div className="card-sub">
            Deleting a project removes it from listings and stops the gateway
            from resolving its slug. Existing captures stay in storage; the
            slug becomes reusable.
          </div>
        </div>
        <button
          type="button"
          className="btn settings-danger-btn"
          onClick={() => setOpen(true)}
        >
          Delete project
        </button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen && !pending) {
            setConfirmation("");
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {projectName}</DialogTitle>
            <DialogDescription>
              Gateway requests tagged{" "}
              <code>x-understudy-project: {project.slug}</code> will stop
              resolving. This cannot be undone from the app.
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="settings-delete-confirmation" className="card-sub">
              Type <code>{project.slug}</code> to confirm
            </label>
            <input
              id="settings-delete-confirmation"
              className="assign-select"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={project.slug}
              disabled={pending}
              autoFocus
            />
          </div>
          {error ? (
            <p role="alert" className="settings-danger-text">{error}</p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn settings-danger-btn"
              disabled={!confirmed || pending}
              onClick={() => void doDelete()}
            >
              {pending ? "Deleting" : "Delete project"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
