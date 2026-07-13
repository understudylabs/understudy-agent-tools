"use client";

import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./base-ui/dialog";
import { compactModelId, isDetailedModelCard, modelCardFor } from "../lib/model-cards";

type ModelRoute = "local" | "cloud" | "anthropic";

export type ModelRuntimeContext = {
  slotId?: number;
  active: boolean;
  loading?: boolean;
  thinking?: boolean;
};

export function ModelCardDrawer({
  modelId,
  label,
  route,
  runtime,
}: {
  modelId: string;
  label: string;
  route: ModelRoute;
  runtime: ModelRuntimeContext;
}) {
  const card = modelCardFor(modelId);
  const localCard = route === "local" && isDetailedModelCard(card) ? card : null;
  const runtimeLabel = runtime.loading
    ? "Loading"
    : runtime.active
      ? "Ready"
      : "Unavailable";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="model-card-trigger"
          aria-label={`About ${label}`}
          title={`About ${label}`}
        >
          <Info aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="model-card-dialog">
        <DialogHeader className="model-card-header">
          <div className="model-card-title-row">
            <div>
              <DialogTitle>{card?.alias ?? label}</DialogTitle>
              <DialogDescription>{compactModelId(modelId)}</DialogDescription>
            </div>
            <div className="model-card-badges" aria-label="Current model state">
              <span>{route}</span>
              <span className={runtime.active ? "good" : ""}>{runtimeLabel}</span>
            </div>
          </div>
        </DialogHeader>

        {localCard ? (
          <div className="model-card-grid">
            <section className="model-card-section provenance">
              <h3>What this is</h3>
              <ModelCardFact label="Base" value={localCard.provenance.base_model} mono />
              <ModelCardFact label="Source" value={localCard.provenance.source_checkpoint} mono />
              <ModelCardFact label="Conversion" value={localCard.provenance.conversion} mono />
              <ModelCardFact label="Training" value={localCard.provenance.understudy_training} />
              <ModelCardFact label="License" value={localCard.provenance.license} />
            </section>

            <section className="model-card-section">
              <h3>How it runs</h3>
              <div className="model-card-decode">
                <span><b>{localCard.decode_contract.temperature}</b> temp</span>
                <span><b>{localCard.decode_contract.top_p}</b> top-p</span>
                <span><b>{localCard.decode_contract.top_k}</b> top-k</span>
              </div>
              <p>{localCard.decode_contract.warning}</p>
              <p className="model-card-mono">
                Required: {localCard.decode_contract.required_server_flags.join(" ")}
              </p>
            </section>

            <section className="model-card-section">
              <h3>What we verified</h3>
              <div className="model-card-certification">
                <span>{localCard.certification.status}</span>
                <time>{localCard.certification.certified_at}</time>
              </div>
              <div className="model-card-checks">
                {localCard.certification.verified.map((item) => <span key={item}>{item}</span>)}
              </div>
              <p>{localCard.certification.scope}</p>
            </section>

            <section className="model-card-section">
              <h3>When to use it</h3>
              <ModelCardFact label="Role" value={localCard.routing_hints.role} />
              <ModelCardFact
                label="Escalate"
                value={localCard.routing_hints.escalate_when.join(" · ")}
              />
              <ModelCardFact label="Next" value={localCard.routing_hints.escalate_to} />
              <ModelCardFact
                label="Footprint"
                value={`${localCard.footprint.disk_gb} GB disk${
                  localCard.footprint.peak_runtime_memory_gb
                    ? ` · ${localCard.footprint.peak_runtime_memory_gb} GB measured peak`
                    : ""
                } · ${localCard.footprint.runtime}`}
              />
            </section>
          </div>
        ) : (
          <section className="model-card-section model-card-provider">
            <h3>{route === "local" ? "Local snapshot" : "Provider route"}</h3>
            <p>
              {route === "local"
                ? "This local model has no published Understudy model card yet. Its name and current runtime state are still shown here without inferring training or certification."
                : "This model is served by the configured provider. Provenance, decode settings, and certification are determined by that route rather than a local Understudy snapshot."}
            </p>
          </section>
        )}

        <footer className="model-card-context">
          <span>Current chat</span>
          <strong>{route === "local" && runtime.slotId != null ? `Slot ${runtime.slotId}` : route}</strong>
          {route === "local" && <strong>{runtime.thinking ? "Thinking on" : "Thinking off"}</strong>}
          <span className="model-card-context-note">No frozen experiment is linked to this chat.</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ModelCardFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <dl className="model-card-fact">
      <dt>{label}</dt>
      <dd className={mono ? "model-card-mono" : undefined}>{value}</dd>
    </dl>
  );
}
