export type ByokProvider = "anthropic" | "openai";

export const UNDERSTUDY_API_KEY_ENV: string;
export const DEFAULT_WORKLOAD_NAME: string;
export const DEFAULT_PROJECT_SLUG: string;
export const DEFAULT_GATEWAY_URL: string;

export const BYOK_PROVIDERS: Record<
  ByokProvider,
  {
    label: string;
    providerEnvName: string;
    endpoint: string;
    authHeader: string;
    body: string;
    sdkSnippet: (
      projectSlug: string | null,
      workloadName: string,
      baseUrl: string,
    ) => string;
  }
>;

export function buildByokEnvSnippet(
  provider: ByokProvider,
  understudyKey?: string | null,
): string;

export function buildManagedEnvSnippet(understudyKey?: string | null): string;

export function buildManagedCurlSnippet(input: {
  modelId: string;
  projectSlug?: string | null;
  workloadName?: string | null;
  baseUrl?: string | null;
}): string;

export function buildManagedSdkSnippet(input: {
  modelId: string;
  projectSlug?: string | null;
  workloadName?: string | null;
  baseUrl?: string | null;
}): string;

export function buildByokCurlSnippet(input: {
  provider: ByokProvider;
  projectSlug?: string | null;
  workloadName?: string | null;
  baseUrl?: string | null;
}): string;

export function buildByokSdkSnippet(input: {
  provider: ByokProvider;
  projectSlug?: string | null;
  workloadName?: string | null;
  baseUrl?: string | null;
}): string;

export function maskSecret(value: string): string;

export function pickDefaultProjectSlug(
  projects: Array<{ slug: string }>,
  preferred?: string | null,
): string;
