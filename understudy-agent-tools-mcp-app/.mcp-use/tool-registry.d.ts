// Auto-generated tool registry types - DO NOT EDIT MANUALLY
// This file is regenerated whenever tools are added, removed, or updated during development
// Generated at: 2026-06-27T18:20:59.020Z

declare module "mcp-use/react" {
  interface ToolRegistry {
    "get-understudy-ladder-status": {
      input: { "artifacts": Record<string, unknown> };
      output: { "stage": string; "readyFor": string; "present": Array<string>; "missing": Array<string>; "blockers": Array<string>; "nextAction": string; "nextCommand": string | null; "requiredSkill": string };
    };
    "inspect-understudy-skill": {
      input: { "skill": string; "includeReference": boolean };
      output: Record<string, unknown>;
    };
    "next-understudy-action": {
      input: { "objective": string; "constraints": Array<string>; "artifacts": Record<string, unknown> };
      output: { "objective": string; "constraints": Array<string>; "stage": string; "action": string; "command": string | null; "skill": string; "rationale": Array<string>; "approvalRequiredFor": Array<string> };
    };
    "produce-understudy-improvement-report": {
      input: { "workloadName": string; "objective": string; "baseline": { "model"?: string | undefined; "quality"?: number | undefined; "latencyMs"?: number | undefined; "costUsdPer1k"?: number | undefined }; "candidate": { "model"?: string | undefined; "quality"?: number | undefined; "latencyMs"?: number | undefined; "costUsdPer1k"?: number | undefined }; "artifacts": Record<string, unknown> };
      output: Record<string, unknown>;
    };
    "search-understudy-skills": {
      input: { "query"?: string | undefined; "category": "all" | "install" | "capture" | "optimize" | "routing" | "cost" | "workflow" };
      output: { "query": string; "category": string; "results": Array<{ "name": string; "description": string; "path": string; "hasReference": boolean; "category": string }>; "total": number };
    };
    "understudy-account-status": {
      input: { "orgId"?: string | undefined };
      output: { "ok": boolean; "configured": boolean; "org_id": string | null; "gateway_url": string | null; "auth_mode": string | null; "error"?: string | undefined };
    };
    "understudy-cli-guide": {
      input: { "focus": "overview" | "install" | "capture" | "optimize" | "gateway" | "models" | "privacy" };
      output: { "focus": string; "commands": Array<string>; "notes": Array<string>; "sources": Array<string> };
    };
    "understudy-get-route": {
      input: { "orgId"?: string | undefined; "project"?: string | undefined; "projectId"?: string | undefined; "workload": string };
      output: { "ok"?: boolean | undefined; "org_id"?: string | undefined; "project_id"?: string | undefined; "project_slug"?: string | null | undefined; "workload_id"?: string | undefined; "workload_name"?: string | undefined; "route_model_id"?: string | null | undefined; "route_traffic_pct"?: number | undefined; "passthrough_traffic_pct"?: number | undefined; "capture_enabled"?: boolean | undefined; "is_default"?: boolean | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-list-captures": {
      input: { "orgId"?: string | undefined; "project"?: string | undefined; "projectId"?: string | undefined; "workload"?: string | undefined; "limit": number; "cursor"?: string | undefined };
      output: { "ok"?: boolean | undefined; "org_id"?: string | undefined; "project_id"?: string | undefined; "project_slug"?: string | null | undefined; "workload_id"?: string | null | undefined; "captures"?: Array<{ "request_id": string | null; "schema_version": string | null; "ts": string | null; "project_id": string | null; "workload_id": string | null; "mode": string | null; "provider": string | null; "endpoint": string | null; "requested_model": string | null; "upstream_model": string | null; "status_code": number | null; "latency_ms": number | null; "tags": { "count": number; "keys": Array<string> }; "customer_request_body": "present" | "absent"; "upstream_request_body": "present" | "absent"; "response_body": "present" | "absent" }> | undefined; "truncated"?: boolean | undefined; "cursor"?: string | null | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-list-models": {
      input: { "orgId"?: string | undefined };
      output: { "ok"?: boolean | undefined; "org_id"?: string | undefined; "models"?: Array<{ "id": string; "display_name"?: string | undefined; "name"?: string | undefined; "description"?: string | undefined; "capabilities"?: Array<string> | undefined; "context_window"?: number | null | undefined }> | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-list-projects": {
      input: { "orgId"?: string | undefined };
      output: { "ok"?: boolean | undefined; "org_id"?: string | undefined; "projects"?: Array<{ "id": string; "org_id"?: string | undefined; "slug": string; "name"?: string | undefined; "created_at"?: string | undefined; "settings"?: string | undefined; "deleted_at"?: string | null | undefined }> | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-list-workloads": {
      input: { "orgId"?: string | undefined; "project"?: string | undefined; "projectId"?: string | undefined };
      output: { "ok"?: boolean | undefined; "org_id"?: string | undefined; "project_id"?: string | undefined; "project_slug"?: string | null | undefined; "workloads"?: Array<{ "id": string; "project_id"?: string | undefined; "name": string; "capture_enabled"?: boolean | undefined; "route_model_id"?: string | null | undefined; "route_traffic_pct"?: number | null | undefined; "route_deployment_id"?: string | null | undefined; "is_default"?: boolean | undefined; "created_at"?: string | undefined; "updated_at"?: string | undefined }> | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-set-route-traffic": {
      input: { "orgId"?: string | undefined; "project"?: string | undefined; "projectId"?: string | undefined; "workload": string; "modelId"?: string | null | undefined; "trafficPct": number; "clear": boolean; "confirm": boolean };
      output: { "ok"?: boolean | undefined; "dryRun"?: boolean | undefined; "org_id"?: string | undefined; "project_id"?: string | undefined; "workload_id"?: string | undefined; "workload_name"?: string | undefined; "previous_route_model_id"?: string | null | undefined; "previous_route_traffic_pct"?: number | null | undefined; "route_model_id"?: string | null | undefined; "route_traffic_pct"?: number | null | undefined; "message"?: string | undefined; "error"?: string | undefined; "status"?: number | undefined; "requestId"?: string | undefined };
    };
    "understudy-submission-readiness": {
      input: { "includeToolCatalog": boolean };
      output: { "ok": boolean; "metadata": Record<string, unknown>; "manufact": Record<string, unknown>; "appStores": Record<string, unknown>; "safety": Array<string>; "toolCatalog"?: Array<Record<string, unknown>> | undefined; "submissionArtifacts": Array<string> };
    };
    "validate-understudy-proof-artifacts": {
      input: { "artifacts": Record<string, unknown> };
      output: { "ok": boolean; "present": Array<string>; "missing": Array<string>; "warnings": Array<string>; "recommendation": string; "localGateCommand": string };
    };
  }
}

export {};
