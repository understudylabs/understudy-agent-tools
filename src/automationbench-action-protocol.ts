export const ACTION_PROTOCOL_SYSTEM_PROMPT = [
  "You operate business apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

export const ACTION_PROTOCOL_ID = "automationbench-v2-json-action-v1";
export const ACTION_PROTOCOL_MAX_MODEL_TURNS = 14;

export type ParsedAction =
  | { finish: true }
  | { action: { name: "api_search" | "api_fetch"; arguments: Record<string, unknown> } }
  | { error: string };

/** Parse one model response using the benchmark's strict text-tool protocol. */
export function parseAction(text: unknown): ParsedAction {
  const visible = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*<\/think>/, "")
    .replace(/<\|(?:im_end|endoftext)\|>/g, "");
  const trimmed = visible
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return { error: "no JSON object in reply" };
  let decoded: any;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
  if (typeof name !== "string") return { error: "reply has no tool name" };
  if (name === "finish") return { finish: true };
  if (name !== "api_search" && name !== "api_fetch") return { error: `unknown tool: ${name}` };
  let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: "arguments are not valid JSON" };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: "arguments must be an object" };
  }
  return { action: { name, arguments: args as Record<string, unknown> } };
}
