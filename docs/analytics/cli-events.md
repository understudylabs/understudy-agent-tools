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

1. `cli_login_completed`
2. `cli_activation_status_checked`
3. `cli_run_completed`

Pre-key signup events are platform-owned because they happen before the CLI has
an API key.

## Events

| Event | Purpose | Key properties |
| --- | --- | --- |
| `cli_login_completed` | User has a stored Understudy credential. | `mode`, `org_id`, `user_id`, `signup_intent_id` |
| `cli_activation_status_checked` | User or agent verified local auth state. | `configured`, `signed_in`, `org_id`, `project_slug` |
| `cli_projects_listed` | User inspected project context. | `org_id`, `result_count` |
| `cli_projects_created` | User created a project. | `org_id`, `project_slug` |
| `cli_projects_switched` | User selected a project for the repo. | `org_id`, `project_slug` |
| `cli_projects_deleted` | User soft-deleted a project. | `org_id`, `project_slug` |
| `cli_api_keys_listed` | User inspected org API keys. | `org_id`, `result_count` |
| `cli_api_keys_created` | User minted another org key. | `org_id` |
| `cli_api_keys_revoked` | User revoked an org key. | `org_id` |
| `cli_run_started` | CLI injected credentials into a child process. | `command_kind`, `auth_source`, `org_id`, `project_slug` |
| `cli_run_completed` | Authenticated work completed successfully. | `command_kind`, `duration_ms`, `exit_code`, `org_id`, `project_slug` |
| `cli_run_failed` | Authenticated child process failed. | `command_kind`, `duration_ms`, `exit_code`, `org_id`, `project_slug` |
| `cli_skill_installed` | User installed the agent-facing skill. | `skill`, `global`, `reference_count` |
