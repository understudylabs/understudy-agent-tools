import { z } from "zod";

export const SERVING_CONTRACT_SCHEMA = "understudy.serving_contract.v1" as const;
export const SERVING_PARITY_SCHEMA = "understudy.serving_parity.v1" as const;
export const EVAL_RESULT_SCHEMA = "understudy.eval_result.v1" as const;

export const ServingLaneSchema = z.enum(["tinker", "vllm", "fireworks"]);
export const SamplingSchema = z.object({
  temperature: z.number().min(0),
  top_p: z.number().gt(0).lte(1).nullable(),
  max_tokens: z.number().int().positive().nullable(),
  seed: z.number().int().nullable(),
});
export const RendererSchema = z.object({
  id: z.string().min(1),
  template_source: z.string().min(1),
  stop_sequences: z.array(z.string()),
  application: z.enum(["client-rendered-completion", "server-side-chat-template"]),
  stop_sequences_pinned: z.boolean(),
});
export const ToolProtocolSchema = z.object({
  id: z.enum(["nemotron-text", "openai-native", "json-text"]),
  advertisement: z.enum(["text-instructions", "native-tools", "json-instructions"]),
  parser: z.string().min(1),
});
const LaneConfigurationSchema = z.object({
  renderer: z.string().min(1),
  renderer_application: RendererSchema.shape.application,
  requirements: z.array(z.string()),
  deviations: z.array(z.object({
    field: z.string().min(1),
    detail: z.string().min(1),
  })),
});
export const ServingContractSchema = z.object({
  schema_version: z.literal(SERVING_CONTRACT_SCHEMA),
  base_id: z.string().min(1),
  display_name: z.string().min(1),
  renderer: RendererSchema,
  tool_protocol: ToolProtocolSchema,
  sampling: SamplingSchema,
  lanes: z.record(ServingLaneSchema, LaneConfigurationSchema),
  notes: z.array(z.string()),
});

export type ServingContract = z.infer<typeof ServingContractSchema>;
export type ServingLane = z.infer<typeof ServingLaneSchema>;
export type Sampling = z.infer<typeof SamplingSchema>;
export type ChatMessage = {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
};
export type ToolCall = {
  id: string | null;
  type: "function";
  function: { name: string; arguments: string };
};
export type ParsedAssistant = {
  role: "assistant";
  content: string;
  tool_calls: ToolCall[];
  malformed?: boolean;
};

const NEMOTRON_CONTRACT: ServingContract = {
  schema_version: SERVING_CONTRACT_SCHEMA,
  base_id: "nemotron3",
  display_name: "Nemotron-3-Nano",
  renderer: {
    id: "nemotron3",
    template_source: "tinker_cookbook.renderers.nemotron3",
    stop_sequences: [],
    application: "client-rendered-completion",
    stop_sequences_pinned: false,
  },
  tool_protocol: {
    id: "nemotron-text",
    advertisement: "text-instructions",
    parser: "parseNemotronTextMessage",
  },
  sampling: {
    temperature: 0,
    top_p: null,
    max_tokens: 512,
    seed: null,
  },
  lanes: {
    tinker: {
      renderer: "nemotron3",
      renderer_application: "client-rendered-completion",
      requirements: [
        "tinker-cookbook renderer_name=nemotron3",
        "collect renderer.build_generation_prompt output",
        "apply renderer.get_stop_sequences() and configure the canonical stop set",
      ],
      deviations: [],
    },
    vllm: {
      renderer: "server-side-chat-template",
      renderer_application: "server-side-chat-template",
      requirements: [
        "--reasoning-parser nano_v3",
        "--enable-auto-tool-choice",
        "--tool-call-parser qwen3_coder",
        "collect an observed rendered prompt if the server exposes one",
      ],
      deviations: [{
        field: "renderer.application/tool_protocol",
        detail: "documented vLLM path uses server-side chat template and native tool envelopes",
      }],
    },
    fireworks: {
      renderer: "nemotron3",
      renderer_application: "client-rendered-completion",
      requirements: [
        "client-render the canonical prompt",
        "tool_choice=none",
        "send canonical sampling explicitly rather than relying on provider defaults",
      ],
      deviations: [],
    },
  },
  notes: [
    "The canonical sampling is the comparison target; provider defaults are not evidence of conformance.",
    "The vLLM configuration records a provider-forced server/native deviation that must be acknowledged explicitly.",
    "Stop sequences remain unpinned because the inspected Tinker renderer supplies them dynamically.",
  ],
};

const CONTRACTS: Record<string, ServingContract> = {
  [NEMOTRON_CONTRACT.base_id]: NEMOTRON_CONTRACT,
};

export function getServingContract(baseId: string): ServingContract | null {
  return CONTRACTS[baseId] ?? null;
}

export function requireServingContract(baseId: string): ServingContract {
  const contract = getServingContract(baseId);
  if (!contract) throw new Error(`no serving contract for base '${baseId}'`);
  return contract;
}
