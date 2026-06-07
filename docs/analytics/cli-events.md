# CLI Analytics Events

Use lowercase snake-case event names prefixed by `cli_`.

Every event includes:

- `app: "understudy_cli"`
- `install_id` in the event envelope
- `event_version`
- `version`
- `command_platform`
- `command_arch`
- `signup_intent_id` when present
- `org_id` and `project_slug` when known

## Funnel

Primary activation funnel:

1. `cli_login_started`
2. `cli_login_completed`
3. `cli_activation_status_checked`
4. `cli_run_completed`

Pre-key signup events are platform-owned because they happen before the CLI has
an API key. `cli_login_started` and `cli_login_failed` are only emitted when a
previous credential or `UNDERSTUDY_API_KEY` already exists; first-time login
attempts start in the platform-owned signup flow and emit `cli_login_completed`
after the credential is minted.

## Events

| Event | Purpose | Key properties |
| --- | --- | --- |
| `cli_login_started` | Existing user or agent started a CLI login attempt. | `mode`, `signup_intent_id` |
| `cli_login_completed` | User has a stored Understudy credential. | `mode`, `org_id`, `user_id`, `signup_intent_id` |
| `cli_login_failed` | Existing user or agent failed a CLI login attempt. | `mode`, `error_kind`, `signup_intent_id` |
| `cli_activation_status_checked` | User or agent verified local auth state. | `configured`, `signed_in`, `org_id`, `project_slug` |
| `cli_projects_listed` | User inspected project context. | `org_id`, `result_count` |
| `cli_projects_created` | User created a project. | `org_id`, `project_slug` |
| `cli_projects_switched` | User selected a project for the repo. | `org_id`, `project_slug` |
| `cli_projects_deleted` | User soft-deleted a project. | `org_id`, `project_slug` |
| `cli_api_keys_listed` | User inspected org API keys. | `org_id`, `result_count` |
| `cli_api_keys_created` | User minted another org key. | `org_id` |
| `cli_api_keys_revoked` | User revoked an org key. | `org_id` |
| `cli_models_listed` | User or agent inspected public Understudy model IDs. | `org_id`, `result_count` |
| `cli_workloads_listed` | User or agent listed project workloads. | `org_id`, `project_slug`, `result_count` |
| `cli_workloads_created` | User or agent created a project workload. | `org_id`, `project_slug` |
| `cli_workloads_updated` | User or agent updated workload metadata or capture state. | `org_id`, `project_slug` |
| `cli_workload_routes_updated` | User or agent routed a workload percentage to an Understudy model. | `org_id`, `result_count` |
| `cli_workload_routes_cleared` | User or agent cleared a workload model route. | `org_id` |
| `cli_run_started` | CLI injected credentials into a child process. | `command_kind`, `auth_source`, `org_id`, `project_slug` |
| `cli_run_completed` | Authenticated work completed successfully. | `command_kind`, `duration_ms`, `exit_code`, `org_id`, `project_slug` |
| `cli_run_failed` | Authenticated child process failed. | `command_kind`, `duration_ms`, `exit_code`, `org_id`, `project_slug` |
| `cli_skill_installed` | User installed the agent-facing skill. | `skill`, `global`, `reference_count` |
