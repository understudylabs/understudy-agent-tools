import { ACTION_PROTOCOL_SYSTEM_PROMPT } from "./automationbench-rl-service.js";
import { PLAYBOOK } from "./event-categorizer-offline.js";

export const GROUP_A_PROTOCOL_SYSTEM_PROMPT = ACTION_PROTOCOL_SYSTEM_PROMPT;

const ALLOWED_REPLY_SKELETON = `Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

Reply with exactly ONE JSON object and nothing else.`;

const AUTOMATION_SURFACE = `api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).`;

const WORKFLOW_SURFACE = `api_search is read-only workflow endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /conversations (GET), /conversations/{id} (GET), /documents (GET), /documents/{id} (GET, PATCH, POST), /records (GET), /records/{id} (GET, PATCH), /drafts (GET, POST), /meetings (GET, POST), /agent-state/{id} (GET, PATCH), /summaries (GET, POST), /analysis (GET, POST).`;

const SHARED_TURN_INSTRUCTION = "Each tool result is returned to you as JSON. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.";

export const GROUP_C_PROTOCOL_SYSTEM_PROMPT = [
  "You operate workflow apps by calling tools. Reply with exactly ONE JSON object and nothing else.",
  ALLOWED_REPLY_SKELETON,
  WORKFLOW_SURFACE,
  SHARED_TURN_INSTRUCTION,
].join("\n\n");

export const GROUP_B_PROTOCOL_SYSTEM_PROMPT = [
  PLAYBOOK.trimEnd(),
  "",
  "You operate the account lookup tool before answering when an event contains an account_id.",
  ALLOWED_REPLY_SKELETON,
  "api_search and api_fetch are read-only account lookup tools. Use the account_id argument when looking up an account.",
  "Each tool result is returned to you as JSON. After any needed lookup, reply with the final answer schema from the playbook and no prose:",
  '{"category":"...","priority":"...","account_ref":"acct id or null","reasoning":"one short sentence"}',
].join("\n");

export type TransferPromptGroup = "A" | "B" | "C";

export function transferProtocolSystemPrompt(group: TransferPromptGroup): string {
  if (group === "A") return GROUP_A_PROTOCOL_SYSTEM_PROMPT;
  if (group === "B") return GROUP_B_PROTOCOL_SYSTEM_PROMPT;
  return GROUP_C_PROTOCOL_SYSTEM_PROMPT;
}

export function transferPromptArtifact(): Record<TransferPromptGroup, { system: string; user: string }> {
  return {
    A: {
      system: GROUP_A_PROTOCOL_SYSTEM_PROMPT,
      user: "Ada Lovelace signed the contract. Record the deal as won on that CRM contact.",
    },
    B: {
      system: GROUP_B_PROTOCOL_SYSTEM_PROMPT,
      user: "A synthetic event task question; see the task row for the exact user message.",
    },
    C: {
      system: GROUP_C_PROTOCOL_SYSTEM_PROMPT,
      user: "A synthetic workflow task prompt; see the task row for the exact user message.",
    },
  };
}
