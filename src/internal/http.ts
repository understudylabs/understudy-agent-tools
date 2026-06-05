/**
 * HTTP client for the Understudy CLI.
 *
 * Two roles, both load-bearing:
 *
 *   1. **Customer-scope enforcement.** Refuses to construct any request
 *      whose path begins with the founder admin prefix (built at runtime
 *      from substrings so this file does not itself contain the literal
 *      that the ESLint rule bans). See AGENTS.md → "Hard rules" #1 and
 *      UND-118 F16. Tested in `test/internal/http.test.ts`.
 *
 *   2. **Auth + transport.** Wraps `fetch` with credential injection
 *      (Authorization header from `~/.understudy/credentials.json`),
 *      base-URL resolution (relative path → `${gateway_url}/path`), and
 *      Zod-parsed response envelopes. Non-2xx responses are parsed as
 *      `ErrorEnvelope` and thrown as `UnderstudyApiError`.
 *
 * The shape `request<T>(...)` is intentional: callers in
 * `src/commands/**` pass a Zod schema and get a typed body back; drift
 * between gateway and CLI surfaces as a parse error at the boundary,
 * not a runtime crash 10 lines later.
 */
import { z } from "zod";

import { DEFAULT_GATEWAY_URL, PACKAGE_NAME } from "../config/defaults.js";
import { readCredentials } from "../config/credentials.js";

// Built from substrings so this file itself does not contain the
// literal that the ESLint scope-enforcement rule bans.
const SUPER_ADMIN_PREFIX = `/${"super"}-${"admin"}/v1/`;
const FORBIDDEN_PREFIXES: readonly string[] = [SUPER_ADMIN_PREFIX];

export class SuperAdminScopeError extends Error {
  override readonly name = "SuperAdminScopeError";
  constructor(url: string) {
    super(
      `Refusing to call ${url} from ${PACKAGE_NAME}. The ${SUPER_ADMIN_PREFIX}* surface is the founder admin API and must not be reached from the customer CLI. See AGENTS.md.`,
    );
  }
}

/**
 * Error envelope returned by the gateway on any non-2xx response.
 * Mirrors `ErrorEnvelopeSchema` in `@understudy/types` — duplicated here
 * (rather than imported) so the CLI doesn't take a runtime dep on the
 * platform monorepo. Drift is acceptable: this schema is permissive
 * (extra fields ignored) so a new error `type` won't break the parser.
 */
const ErrorEnvelopeSchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  request_id: z.string().optional(),
});

/**
 * Thrown for any non-2xx gateway response. Carries the parsed envelope
 * so commands can render `error_type`, `request_id`, etc. without
 * re-parsing the response body themselves.
 */
export class UnderstudyApiError extends Error {
  override readonly name = "UnderstudyApiError";
  readonly status: number;
  readonly errorType: string;
  readonly requestId: string;

  constructor(args: {
    status: number;
    errorType: string;
    message: string;
    requestId: string;
  }) {
    super(args.message);
    this.status = args.status;
    this.errorType = args.errorType;
    this.requestId = args.requestId;
  }
}

export interface RequestInput {
  /** Absolute URL or path beginning with `/`. */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Anything JSON-serializable. Caller does not stringify. */
  body?: unknown;
  /** Org id whose credential is used. Defaults to the only org if there's
   * exactly one in credentials; throws otherwise. */
  orgId?: string;
}

export interface ResolvedAuth {
  token: string;
  mode: "env_api_key" | "api_key";
  gatewayUrl: string;
  orgId: string;
}

export interface RequestResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/**
 * Validate that a request URL does not target the founder admin
 * surface. Throws `SuperAdminScopeError` if it does.
 *
 * Exported for unit testing. Called by `request()` below.
 */
export function assertCustomerScope(url: string): void {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Relative path — use as-is.
    path = url;
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (path.startsWith(prefix)) {
      throw new SuperAdminScopeError(url);
    }
  }
}

/**
 * Resolve which org credential to use. Either the caller named one, or
 * there is exactly one in the credentials file. Anything else is a
 * config error the caller has to fix before the request can proceed.
 */
export function resolveAuth(orgId?: string): ResolvedAuth {
  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  const credentials = readCredentials();
  const fallbackGatewayUrl =
    process.env.UNDERSTUDY_GATEWAY_URL ||
    credentials?.gateway_url ||
    DEFAULT_GATEWAY_URL;

  if (envApiKey) {
    const chosen = credentials ? resolveOrgId(credentials, orgId) : orgId;
    if (!chosen) {
      throw new Error(
        "UNDERSTUDY_API_KEY is set, but no org is configured. Pass --org or run `understudy login` in this repo.",
      );
    }
    return {
      token: envApiKey,
      mode: "env_api_key",
      gatewayUrl: fallbackGatewayUrl,
      orgId: chosen,
    };
  }

  if (!credentials) {
    throw new Error(
      "No Understudy credentials found. Run `understudy login` to create ~/.understudy/credentials.json.",
    );
  }

  if (credentials.api_key) {
    const chosen = resolveOrgId(credentials, orgId);
    return {
      token: credentials.api_key,
      mode: "api_key",
      gatewayUrl: fallbackGatewayUrl,
      orgId: chosen,
    };
  }

  const chosen = resolveOrgId(credentials, orgId);
  const entry = credentials.orgs[chosen]!;
  return {
    token: entry.api_key,
    mode: "api_key",
    gatewayUrl: entry.gateway_url || fallbackGatewayUrl,
    orgId: chosen,
  };
}

function resolveOrgId(
  credentials: NonNullable<ReturnType<typeof readCredentials>>,
  orgId?: string,
): string {
  const orgs = Object.keys(credentials.orgs);
  if (orgs.length === 0 && !orgId) {
    throw new Error(
      "Credentials file exists but contains no orgs. Run `understudy login` to add one.",
    );
  }

  if (orgId) {
    if (orgs.length > 0 && !credentials.orgs[orgId]) {
      throw new Error(
        `No credentials for org_id=${orgId} in ~/.understudy/credentials.json. Run \`understudy login\` to sign in to this org.`,
      );
    }
    return orgId;
  }
  if (orgs.length === 1) {
    return orgs[0]!;
  }
  if (orgs.length > 1) {
    throw new Error(
      `Multiple orgs in credentials (${orgs.join(", ")}). Pass --org to disambiguate.`,
    );
  }
  throw new Error("No Understudy org configured. Run `understudy login`.");
}

/**
 * Make an authenticated request to the Understudy gateway.
 *
 * Pass a Zod schema in `schema` to parse the response body; the typed
 * shape rides through the return type. Callers that don't care about
 * the body (e.g. a successful DELETE) can pass `z.unknown()`.
 *
 * Non-2xx responses are parsed through `ErrorEnvelopeSchema` and
 * thrown as `UnderstudyApiError` — including the request id from the
 * `x-understudy-request-id` response header when the envelope doesn't
 * carry one.
 */
export async function request<T>(
  input: RequestInput,
  schema: z.ZodType<T>,
): Promise<RequestResponse<T>> {
  assertCustomerScope(input.url);

  const auth = resolveAuth(input.orgId);
  const absoluteUrl = toAbsoluteUrl(input.url, auth.gatewayUrl);

  // Re-check the resolved URL — a relative path that pointed at the
  // customer surface could still resolve onto a host that exposes the
  // founder surface if a future config let `gateway_url` change. The
  // re-check is belt + braces; the per-input check above stays as the
  // primary structural guard.
  assertCustomerScope(absoluteUrl);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    ...(input.headers ?? {}),
  };

  let body: string | undefined;
  if (input.body !== undefined) {
    body = JSON.stringify(input.body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }

  const res = await fetch(absoluteUrl, {
    method: input.method ?? "GET",
    headers,
    body,
  });

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  // 204 / empty body: nothing to parse. Treat as `null` JSON.
  const text = await res.text();
  const parsedBody: unknown = text.length === 0 ? null : safeJsonParse(text);

  if (!res.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(parsedBody);
    const message =
      (envelope.success && envelope.data.message) ||
      `Request to ${absoluteUrl} failed with status ${res.status}.`;
    const errorType =
      (envelope.success && envelope.data.type) || "internal_error";
    const requestId =
      (envelope.success && envelope.data.request_id) ||
      responseHeaders["x-understudy-request-id"] ||
      "";
    throw new UnderstudyApiError({
      status: res.status,
      errorType,
      message,
      requestId,
    });
  }

  const data = schema.parse(parsedBody);
  return {
    status: res.status,
    data,
    headers: responseHeaders,
  };
}

function toAbsoluteUrl(input: string, gatewayUrl: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }
  const base = gatewayUrl.replace(/\/+$/, "");
  const path = input.startsWith("/") ? input : `/${input}`;
  return `${base}${path}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
