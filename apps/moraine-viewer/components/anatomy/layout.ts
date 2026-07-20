import type { EventRow } from "./types";

export const COLORS: Record<string, string> = {
  user_input: "#d97757",
  assistant_response: "#ffffff",
  reasoning: "#a78bfa",
  tool_call: "#9edbd3",
  tool_response: "#9edbd3",
  compaction: "#f2b34c",
  system: "#9b9da3",
  runtime: "#9b9da3",
  unknown: "#9b9da3",
};

// Horizontal lane per event type; spine (user/assistant) sits at x = 0.
const LANES: Record<string, number> = {
  system: -2.6,
  runtime: -2.6,
  unknown: -2.6,
  reasoning: -1.3,
  user_input: 0,
  assistant_response: 0,
  compaction: 0,
  tool_call: 1.4,
  tool_response: 2.7,
};

export const ROW_STEP = 0.34;

export interface LaidOutNode {
  event: EventRow;
  x: number;
  y: number;
  r: number;
  color: string;
  dim: boolean;
  onSpine: boolean;
}

export interface TraceLayout {
  nodes: LaidOutNode[];
  /** polyline along the spine (turn flow) */
  spine: [number, number][];
  /** short edges: branch stubs + tool_call→tool_response pairs, as segment pairs */
  segments: { a: [number, number]; b: [number, number]; color: string; dim: boolean }[];
  /** y position + label for each turn boundary */
  turnMarks: { y: number; turn: number }[];
  height: number;
}

function radiusFor(e: EventRow): number {
  const weight = e.tokens > 0 ? e.tokens : e.text_len / 4;
  const t = Math.min(Math.sqrt(Math.max(weight, 0)) / Math.sqrt(5000), 1);
  return 0.055 + 0.11 * t;
}

export function layoutTrace(events: EventRow[]): TraceLayout {
  const nodes: LaidOutNode[] = [];
  const spine: [number, number][] = [];
  const segments: TraceLayout["segments"] = [];
  const turnMarks: TraceLayout["turnMarks"] = [];
  const openCalls = new Map<string, LaidOutNode>();

  let lastTurn = -1;
  events.forEach((e, i) => {
    const y = -i * ROW_STEP;
    if (e.turn_seq !== lastTurn) {
      turnMarks.push({ y: y + ROW_STEP * 0.5, turn: e.turn_seq });
      lastTurn = e.turn_seq;
    }
    const x = LANES[e.event_type] ?? -2.6;
    const dim = e.event_type === "system" || e.event_type === "runtime" || e.event_type === "unknown";
    const node: LaidOutNode = {
      event: e,
      x,
      y,
      r: radiusFor(e),
      color: COLORS[e.event_type] ?? "#9b9da3",
      dim,
      onSpine: x === 0,
    };
    nodes.push(node);

    if (node.onSpine) {
      spine.push([0, y]);
    } else {
      // branch stub from the spine out to the node
      const stubX = e.event_type === "tool_response" ? LANES.tool_call : 0;
      if (e.event_type !== "tool_response") {
        segments.push({ a: [stubX, y], b: [x - Math.sign(x) * node.r, y], color: node.color, dim: true });
      }
    }

    if (e.event_type === "tool_call" && e.call_id) openCalls.set(e.call_id, node);
    if (e.event_type === "tool_response" && e.call_id) {
      const call = openCalls.get(e.call_id);
      if (call) {
        segments.push({
          a: [call.x + call.r, call.y],
          b: [node.x - node.r, node.y],
          color: "#9edbd3",
          dim: false,
        });
        openCalls.delete(e.call_id);
      } else {
        segments.push({ a: [LANES.tool_call, y], b: [x - node.r, y], color: "#9edbd3", dim: true });
      }
    }
  });

  return { nodes, spine, segments, turnMarks, height: events.length * ROW_STEP };
}
