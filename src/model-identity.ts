export const MODEL_IDENTITY_SCHEMA = "understudy.model_identity.v1" as const;

export type ModelIdentityRgb = [number, number, number];

export type ModelIdentityTint = {
  palette_id: string;
  rgb: ModelIdentityRgb;
  css: string;
};

export type ModelIdentityCertification = {
  status: "evaluated" | "files_unavailable" | "terminal";
  local_only: true;
  evaluated_at: string | null;
};

export type CanonicalModelIdentity = {
  schema_version: typeof MODEL_IDENTITY_SCHEMA;
  id: string;
  kind: "classifier";
  display_name: string;
  tint: ModelIdentityTint;
  lineage: {
    training_run_id: string;
    requested_base_model_id: string | null;
    resolved_base_model_id: string | null;
  };
  artifact: {
    path: string | null;
    size_bytes: number | null;
    available: boolean;
  };
  certification: ModelIdentityCertification;
};

const MODEL_IDENTITY_PALETTE: ReadonlyArray<{
  id: string;
  rgb: ModelIdentityRgb;
}> = [
  { id: "mint", rgb: [158, 219, 211] },
  { id: "cyan", rgb: [103, 232, 249] },
  { id: "violet", rgb: [167, 139, 250] },
  { id: "amber", rgb: [242, 179, 76] },
  { id: "clay", rgb: [217, 119, 87] },
  { id: "rose", rgb: [244, 114, 182] },
];

export function modelIdentityTint(modelId: string): ModelIdentityTint {
  let hash = 2_166_136_261;
  for (let index = 0; index < modelId.length; index += 1) {
    hash ^= modelId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const selected = MODEL_IDENTITY_PALETTE[(hash >>> 0) % MODEL_IDENTITY_PALETTE.length];
  const rgb: ModelIdentityRgb = [...selected.rgb];
  return {
    palette_id: selected.id,
    rgb,
    css: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`,
  };
}

export function createClassifierModelIdentity(input: {
  modelId: string;
  displayName: string;
  runId: string;
  requestedBaseModelId: string | null;
  resolvedBaseModelId: string | null;
  artifactPath: string | null;
  artifactSizeBytes: number | null;
  artifactAvailable: boolean;
  runStatus: "completed" | "failed" | "cancelled";
  evaluatedAt: string | null;
}): CanonicalModelIdentity {
  return {
    schema_version: MODEL_IDENTITY_SCHEMA,
    id: input.modelId,
    kind: "classifier",
    display_name: input.displayName,
    tint: modelIdentityTint(input.modelId),
    lineage: {
      training_run_id: input.runId,
      requested_base_model_id: input.requestedBaseModelId,
      resolved_base_model_id: input.resolvedBaseModelId,
    },
    artifact: {
      path: input.artifactPath,
      size_bytes: input.artifactSizeBytes,
      available: input.artifactAvailable,
    },
    certification: {
      status: input.runStatus !== "completed"
        ? "terminal"
        : input.artifactAvailable ? "evaluated" : "files_unavailable",
      local_only: true,
      evaluated_at: input.runStatus === "completed" ? input.evaluatedAt : null,
    },
  };
}
