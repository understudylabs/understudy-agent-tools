export function classifyTicket(input: string): "billing" | "technical" {
  return input.toLowerCase().includes("invoice") ? "billing" : "technical";
}
