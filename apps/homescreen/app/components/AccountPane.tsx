"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AccountCard, EndpointsCard } from "./SettingsPane";

type Any = Record<string, unknown>;

export function AccountPane({
  onSignedIn,
  prioritizeSignIn = false,
}: {
  onSignedIn?: () => void;
  prioritizeSignIn?: boolean;
} = {}) {
  const [status, setStatus] = useState<Any | null>(null);
  const [platforms, setPlatforms] = useState<Any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // login flow
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  const refresh = () => {
    invoke<Any>("account_status").then(setStatus).catch((e) => setErr(String(e)));
  };
  useEffect(() => {
    refresh();
    invoke<Any>("account_platforms")
      .then((v) => setPlatforms(((v.adapters as Any[]) || [])))
      .catch(() => {});
  }, []);

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

  // WorkOS AuthKit user session (PKCE via system browser). Parallel to the
  // sk_ org key: identity for management surfaces, not a replacement.
  const [userSession, setUserSession] = useState<Any | null>(null);
  const [userBusy, setUserBusy] = useState(false);
  const refreshUserSession = () => {
    invoke<Any>("auth_session_status").then(setUserSession).catch(() => {});
  };
  useEffect(refreshUserSession, []);
  const userSignIn = async () => {
    setUserBusy(true);
    setErr(null);
    try {
      await invoke("auth_login");
      refreshUserSession();
    } catch (e) {
      setErr(String(e));
    } finally {
      setUserBusy(false);
    }
  };
  const userSignOut = async () => {
    setUserBusy(true);
    try {
      await invoke("auth_logout");
      refreshUserSession();
    } catch (e) {
      setErr(String(e));
    } finally {
      setUserBusy(false);
    }
  };

  const userAuthCard = (
    <div className="card">
      <div className="card-row">
        <div>
          <div className="card-title">User sign-in</div>
          {userSession?.signed_in ? (
            <div className="svc-desc">
              signed in as {String(userSession.email ?? userSession.user_id ?? "")}
              {userSession.org_id ? ` · ${String(userSession.org_id)}` : ""}
            </div>
          ) : (
            <div className="svc-desc">
              {userSession?.configured === false
                ? "Not configured — set UNDERSTUDY_WORKOS_CLIENT_ID and UNDERSTUDY_AUTHKIT_DOMAIN (or ~/.understudy/desktop-auth.json)."
                : "Sign in with your Understudy account to manage routing, captures, and keys as yourself."}
            </div>
          )}
        </div>
        {userSession?.signed_in ? (
          <button className="btn" disabled={userBusy} onClick={userSignOut}>
            Sign out
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={userBusy || userSession?.configured === false}
            onClick={userSignIn}
          >
            {userBusy ? "Waiting for browser…" : "Sign in with browser"}
          </button>
        )}
      </div>
    </div>
  );

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
        <p className="pane-sub">Understudy identity, endpoints, and installing into coding agents.</p>
      </div>
      <div className="pane-body">
        {err && <div className="card err">{err}</div>}
        {!signedIn && prioritizeSignIn ? signInCard : null}
        {userAuthCard}

        {!signedIn && !prioritizeSignIn ? signInCard : null}
        {status ? (
          <AccountCard status={status} signedIn={signedIn} onSignedOut={refresh} />
        ) : null}
        {status ? <EndpointsCard status={status} /> : null}

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
