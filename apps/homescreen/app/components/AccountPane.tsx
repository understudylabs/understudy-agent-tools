"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Any = Record<string, unknown>;
type AppIconId = "classic" | "graphite" | "stamp" | "paper";

const APP_ICONS: { id: AppIconId; label: string; src: string }[] = [
  { id: "classic", label: "Classic", src: "/brand/app-icons/classic.png" },
  { id: "graphite", label: "Graphite", src: "/brand/app-icons/graphite.png" },
  { id: "stamp", label: "Stamp", src: "/brand/app-icons/stamp.png" },
  { id: "paper", label: "Paper", src: "/brand/app-icons/paper.png" },
];

export function AccountPane({
  onSignedIn,
  prioritizeSignIn = false,
}: {
  onSignedIn?: () => void;
  prioritizeSignIn?: boolean;
} = {}) {
  const [status, setStatus] = useState<Any | null>(null);
  const [keys, setKeys] = useState<Any | null>(null);
  const [platforms, setPlatforms] = useState<Any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [srv, setSrv] = useState<{ base_url: string; token: string } | null>(null);
  const [appIcon, setAppIcon] = useState<AppIconId>("classic");
  const [iconBusy, setIconBusy] = useState<AppIconId | null>(null);

  // login flow
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  const refresh = () => {
    invoke<Any>("account_status").then(setStatus).catch((e) => setErr(String(e)));
  };
  useEffect(() => {
    const storedIcon = localStorage.getItem("understudy-app-icon") as AppIconId | null;
    if (storedIcon && APP_ICONS.some((icon) => icon.id === storedIcon)) {
      setAppIcon(storedIcon);
    }
    refresh();
    invoke<Any>("account_platforms")
      .then((v) => setPlatforms(((v.adapters as Any[]) || [])))
      .catch(() => {});
    invoke<{ base_url: string; token: string } | null>("server_info")
      .then(setSrv)
      .catch(() => {});
  }, []);

  const chooseAppIcon = async (icon: AppIconId) => {
    setIconBusy(icon);
    setErr(null);
    try {
      await invoke("set_app_icon", { iconId: icon });
      setAppIcon(icon);
      localStorage.setItem("understudy-app-icon", icon);
    } catch (e) {
      setErr(String(e));
    } finally {
      setIconBusy(null);
    }
  };

  const signedIn = Boolean(status?.signed_in);

  const sendCode = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("account_login_send", { email });
      setCodeSent(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const signIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("account_login_code", { code });
      setCode("");
      setCodeSent(false);
      refresh();
      onSignedIn?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await invoke("account_logout");
      setKeys(null);
      refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const showKeys = async () => {
    try {
      const v = await invoke<Any>("account_keys");
      setKeys(v);
    } catch (e) {
      setErr(String(e));
    }
  };

  const signInCard = (
    <div className="card account-sign-in-card">
      <div className="card-title" style={{ marginBottom: 4 }}>Sign in / create account</div>
      <div className="card-sub" style={{ marginBottom: 10 }}>
        Use GLM 5.2 immediately while Understudy prepares private local chat.
      </div>
      <div className="chat-input" style={{ padding: 0 }}>
        <input className="assign-select" style={{ flex: 1 }} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={busy || !email.includes("@")} onClick={sendCode}>{busy ? "…" : "Send code"}</button>
      </div>
      {codeSent && (
        <div className="chat-input" style={{ padding: 0, marginTop: 8 }}>
          <input className="assign-select" style={{ flex: 1 }} placeholder="one-time code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn primary" disabled={busy || !code.trim()} onClick={signIn}>Sign in</button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Account</h1>
        <p className="pane-sub">Understudy identity, API keys, and installing into coding agents.</p>
      </div>
      <div className="pane-body">
        {err && <div className="card err">{err}</div>}
        {!signedIn && prioritizeSignIn ? signInCard : null}

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>App icon</div>
          <div className="card-sub" style={{ marginBottom: 12 }}>
            Applies to the active app window and menu-bar icon.
          </div>
          <div className="app-icon-grid">
            {APP_ICONS.map((icon) => (
              <button
                key={icon.id}
                type="button"
                className={"app-icon-choice" + (appIcon === icon.id ? " active" : "")}
                aria-pressed={appIcon === icon.id}
                disabled={iconBusy !== null}
                onClick={() => chooseAppIcon(icon.id)}
              >
                <img src={icon.src} alt="" draggable={false} />
                <span>{iconBusy === icon.id ? "Applying" : icon.label}</span>
              </button>
            ))}
          </div>
        </div>

        {srv && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Serving server · for coding agents</div>
            <div className="card-sub" style={{ marginBottom: 10 }}>Point an MCP-capable agent at this endpoint with the bearer token.</div>
            <div className="cmd">{srv.base_url}/mcp</div>
            <div className="cmd">Authorization: Bearer {srv.token}</div>
          </div>
        )}

        {!signedIn ? (
          prioritizeSignIn ? null : signInCard
        ) : (
          <>
            <div className="card">
              <div className="card-row">
                <div>
                  <div className="card-title">Signed in</div>
                  <div className="svc-desc">org {String(status?.org_id ?? "")} · project {String(status?.project_slug ?? "")}</div>
                  <div className="svc-desc">key ••••{String(status?.api_key_suffix ?? "")} · {String(status?.gateway_url ?? "")}</div>
                </div>
                <button className="btn" disabled={busy} onClick={logout}>Sign out</button>
              </div>
            </div>

            <div className="card">
              <div className="card-row">
                <div className="card-title">API keys</div>
                <button className="btn" onClick={showKeys}>Show</button>
              </div>
              {keys && <pre className="tool-out" style={{ marginTop: 8 }}>{JSON.stringify(keys, null, 2)}</pre>}
            </div>
          </>
        )}

        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Install into coding agents</div>
          {platforms === null ? <div className="card-sub">Loading platforms…</div> :
            platforms.map((p) => (
              <div key={String(p.id)} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div className="card-row">
                  <div className="svc-name">{String(p.displayName ?? p.id)} <span className="svc-state">{String(p.status ?? "")}</span></div>
                </div>
                {((p.install as string[]) || []).map((cmd, i) => <div key={i} className="cmd">{cmd}</div>)}
                {p.onboarding ? <div className="svc-desc" style={{ marginTop: 6 }}>{String(p.onboarding)}</div> : null}
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
