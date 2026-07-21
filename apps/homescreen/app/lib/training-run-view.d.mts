export type LossPoint = { step: number; value: number };

export function accumulateLossPoints(
  existing: LossPoint[],
  incoming: LossPoint[] | null | undefined,
): LossPoint[];

export function detectPlateau(
  points: LossPoint[],
  options?: { window?: number; tolerance?: number },
): number | null;

export function formatEta(seconds: number | null | undefined): string | null;

export function formatWait(seconds: number | null | undefined): string | null;

export type RunHeadlineEvent = {
  phase?: string;
  message?: string;
  progress?: {
    completed?: number;
    total?: number;
    unit?: string;
    epoch?: number;
    total_epochs?: number;
    percent?: number;
    step?: number;
  };
  details?: {
    queue_seconds?: number;
    estimated_remaining_seconds?: number;
    elapsed_seconds?: number;
    estimated_spend_usd?: number;
  } & Record<string, string | number | boolean | undefined>;
};

export function progressHeadline(
  event: RunHeadlineEvent | null | undefined,
): { title: string; detail: string | null };

export type NarrationEvent = {
  sequence?: number;
  type?: string;
  occurred_at?: string;
  message?: string;
  details?: Record<string, string | number | boolean | undefined>;
};

export function baselineScorePercent(events: NarrationEvent[]): number | null;

export function narrationFeed(
  events: NarrationEvent[],
  limit?: number,
): Array<{ key: string; time: string | null; text: string; kind: "narration" | "baseline" }>;

export function lossSparklineGeometry(
  points: LossPoint[],
  options?: { width?: number; height?: number; pad?: number },
): {
  width: number;
  height: number;
  line: string;
  area: string;
  latest: { x: number; y: number; step: number; value: number };
  at: (index: number) => { x: number; y: number } | null;
} | null;
