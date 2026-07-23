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
import {
  formatRate,
  groupByProvider,
  rateCardFor,
} from "../lib/model-providers.mjs";
import "./cedar-summary.css";

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
        : "Managed supply, grouped by provider. Send the id as body.model, or route a workload to it.";

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
          Public model ids — Understudy picks the provider behind each id.
        </div>
        {models.length === 0 ? (
          <div className="card-sub" style={{ border: "1px dashed var(--border)", borderRadius: 6, padding: 14 }}>
            No models in the catalog yet.
          </div>
        ) : (
          groupByProvider(models).map(({ provider, models: rows }) => (
            <div key={provider.key} style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0 8px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <ProviderLogo provider={provider} />
                <span className="sm-cap" style={{ fontSize: 11 }}>{provider.label}</span>
              </div>
              {rows.map((model) => (
                <ModelRow key={model.id} model={model} />
              ))}
            </div>
          ))
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

    </>
  );
}

/**
 * Provider logo tile: /brand/providers/<file> on a light-neutral tile so
 * dark svgs stay legible. Falls back to a monogram tile; the img swaps in
 * automatically once it loads (and stays hidden if the file isn't there yet).
 */
function ProviderLogo({ provider }: { provider: { label: string; logo: string | null } }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImg = provider.logo && !failed;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 7,
        background: "#f2f2f0",
        border: "1px solid var(--border)",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {(!showImg || !loaded) && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 13,
            fontWeight: 600,
            color: "#1a1a18",
          }}
        >
          {provider.label.slice(0, 1)}
        </span>
      )}
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/brand/providers/${provider.logo}`}
          alt=""
          width={18}
          height={18}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            margin: "auto",
            display: loaded ? "block" : "none",
          }}
        />
      )}
    </span>
  );
}

function ModelRow({ model }: { model: CatalogModelRow }) {
  const rate = rateCardFor(model.id);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
          {model.display_name}
          {rate.local && <span className="sm-chip">local</span>}
        </div>
        <code
          className="cmd"
          style={{ display: "inline", padding: "1px 6px", userSelect: "all", fontSize: "0.72rem" }}
        >
          {model.id}
        </code>
      </div>
      <div className="sm-spacer" />
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          lineHeight: 1.6,
          textAlign: "right",
          color: "var(--text-2)",
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        {rate.local ? (
          <div style={{ color: "var(--text)" }}>$0/M local</div>
        ) : (
          <>
            <div style={{ color: "var(--text)" }}>
              {rate.input == null ? "—" : `${formatRate(rate.input)}/M uncached`}
            </div>
            <div>{rate.cached == null ? "—" : `${formatRate(rate.cached)}/M cached`}</div>
            <div>{rate.output == null ? "—" : `${formatRate(rate.output)}/M output`}</div>
          </>
        )}
      </div>
    </div>
  );
}
