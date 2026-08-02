export const SATURATION_CERTIFICATE_SCHEMA_VERSION = "understudy.ladder_saturation.v1" as const;

export type SaturationInput = {
  fixture_sha256: string;
  incumbent: {
    mean_score: number;
    exact_match_rate: number;
    by_band: Record<string, { mean_score: number; exact_match_rate: number; count?: number }>;
  };
  threshold?: number;
  created_at?: string;
};

export type SaturationCertificate = SaturationInput & {
  schema_version: typeof SATURATION_CERTIFICATE_SCHEMA_VERSION;
  threshold: number;
  saturated: boolean;
  usable: boolean;
  status: "pass" | "fail";
  reason: string;
};

export function buildSaturationCertificate(input: SaturationInput): SaturationCertificate {
  if (!/^[a-f0-9]{64}$/.test(input.fixture_sha256)) throw new Error("fixture_sha256 must be a SHA-256");
  const threshold = input.threshold ?? 0.95;
  if (!(threshold > 0 && threshold <= 1)) throw new Error("threshold must be in (0, 1]");
  const saturated = input.incumbent.mean_score >= threshold || input.incumbent.exact_match_rate >= threshold;
  return {
    schema_version: SATURATION_CERTIFICATE_SCHEMA_VERSION,
    ...input,
    threshold,
    saturated,
    usable: !saturated,
    status: saturated ? "fail" : "pass",
    reason: saturated
      ? "Incumbent dev mean or exact-match rate meets the saturation threshold."
      : "Incumbent dev mean and exact-match rate are below the saturation threshold.",
  };
}
