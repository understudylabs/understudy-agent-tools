"use client";
// Faithful port of the hosted control plane's /models page:
// catalog table + "call directly" curl card + "route a workload" pointer.
// Server component data-fetch becomes a native Tauri command
// (admin_supported_models) so the sk_ credential never reaches the webview.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  catalogCurlExample,
  normalizeSupportedModels,
  type CatalogModelRow,
} from "../lib/model-catalog.mjs";

type AdminModelsResponse = {
  signed_in: boolean;
  reason: string | null;
  models: unknown[];
};

type LoadState =
  | { phase: "loading" }
  | { phase: "signed-out"; reason: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; models: CatalogModelRow[] };

export function ModelCatalogPane() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    invoke<AdminModelsResponse>("admin_supported_models")
      .then((res) => {
        if (cancelled) return;
        if (!res.signed_in) {
          setState({
            phase: "signed-out",
            reason: res.reason ?? "Sign in to browse the model catalog.",
          });
          return;
        }
        setState({ phase: "ready", models: normalizeSupportedModels(res.models) });
      })
      .catch((e) => {
        if (!cancelled) setState({ phase: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const description =
    state.phase === "signed-out"
      ? "Sign in to browse the model catalog."
      : state.phase === "error"
        ? "The model catalog could not be loaded."
        : "Models Understudy serves from managed supply. Use them two ways: send the id as body.model on any request, or route a workload to one without changing code.";

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Model catalog</h1>
        <p className="pane-sub">{description}</p>
      </div>
      <div className="pane-body">
        {state.phase === "loading" && (
          <div className="card">
            <div className="card-sub">Loading…</div>
          </div>
        )}
        {state.phase === "signed-out" && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 6 }}>Access</div>
            <div className="card-sub">{state.reason}</div>
            <div className="svc-desc" style={{ marginTop: 8 }}>
              Sign in from the Account pane or run{" "}
              <code className="cmd" style={{ display: "inline", padding: "2px 6px" }}>
                understudy login
              </code>
              .
            </div>
          </div>
        )}
        {state.phase === "error" && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 6 }}>Attention</div>
            <div className="chat-err">{state.message}</div>
          </div>
        )}
        {state.phase === "ready" && <Catalog models={state.models} />}
      </div>
    </>
  );
}

function Catalog({ models }: { models: CatalogModelRow[] }) {
  const exampleModelId = models[0]?.id ?? "model-id";
  return (
    <>
      <div className="card">
        <div className="card-row" style={{ marginBottom: 4 }}>
          <div className="card-title">Catalog</div>
          <span className="badge-outline">{models.length} active</span>
        </div>
        <div className="card-sub" style={{ marginBottom: 10 }}>
          Public model ids — no provider accounts, no deployment details.
          Understudy picks the provider behind each id.
        </div>
        {models.length === 0 ? (
          <div className="card-sub" style={{ border: "1px dashed var(--border)", borderRadius: 6, padding: 14 }}>
            No models in the catalog yet.
          </div>
        ) : (
          <table className="catalog-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <Th>model</Th>
                <Th>id</Th>
                <Th align="right">added</Th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 500 }}>{model.display_name}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <code
                      className="cmd"
                      style={{ display: "inline", padding: "1px 6px", userSelect: "all" }}
                    >
                      {model.id}
                    </code>
                  </td>
                  <td className="card-sub" style={{ padding: "8px 10px", textAlign: "right" }}>
                    {model.added || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Call a catalog model directly</div>
        <div className="card-sub" style={{ marginBottom: 10 }}>
          Any Understudy key can request a catalog model by id — no routing
          setup, served managed with no fallback.
        </div>
        <pre className="tool-out">{catalogCurlExample(exampleModelId)}</pre>
        <p className="svc-desc" style={{ marginTop: 8 }}>
          The response&apos;s{" "}
          <code className="cmd" style={{ display: "inline", padding: "1px 6px" }}>
            x-understudy-effective-model
          </code>{" "}
          header confirms which model served the request.
        </p>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Route a workload instead</div>
        <div className="card-sub">
          Keep your code on its current provider and shift a traffic slice to a
          catalog model from each project&apos;s Routing page. Routing is not
          ported to Desktop yet — use the web control plane for now.
        </div>
      </div>
    </>
  );
}

function Th({ children, align }: { children: string; align?: "right" }) {
  return (
    <th
      className="card-sub"
      style={{
        padding: "6px 10px",
        textAlign: align ?? "left",
        fontSize: "0.62rem",
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.16em",
      }}
    >
      {children}
    </th>
  );
}
