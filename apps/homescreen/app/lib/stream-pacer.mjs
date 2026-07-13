// Reading-pace display smoothing for streamed answers.
//
// Incoming chunks remain the source of truth in ChatPane. This module only
// controls how much of the latest answer is visible, so persistence, tool
// evidence, and supervision journals never wait on the display animation.

/** Brisk reading speed in characters per second. */
export const BASE_RATE = 70;
/** Buffer length at which the catch-up multiplier reaches 2x. */
export const CATCHUP_DIVISOR = 400;
/** Catch-up cap, also used after the runtime emits Done. */
export const MAX_MULTIPLIER = 8;
export const SENTENCE_PAUSE_MS = 120;
export const PARAGRAPH_PAUSE_MS = 250;
/** Only show the escape hatch when the hidden backlog is meaningful. */
export const SKIP_HINT_THRESHOLD = 300;
export const TICK_MS = 30;

export function initialDrainState() {
  return { revealed: 0, fractional: 0, holdMs: 0 };
}

export function effectiveRate(bufferLength, done) {
  if (done) return BASE_RATE * MAX_MULTIPLIER;
  const multiplier = Math.min(
    MAX_MULTIPLIER,
    1 + Math.max(0, bufferLength) / CATCHUP_DIVISOR,
  );
  return BASE_RATE * multiplier;
}

export function pauseAfter(text, index) {
  if (index >= text.length - 1) return 0;
  const character = text[index];
  if (character === "\n" && index > 0 && text[index - 1] === "\n") {
    return PARAGRAPH_PAUSE_MS;
  }
  const closesSentence =
    /[.!?]/.test(character) ||
    (/["')\]]/.test(character) && index > 0 && /[.!?]/.test(text[index - 1]));
  if (closesSentence && /\s/.test(text[index + 1])) return SENTENCE_PAUSE_MS;
  return 0;
}

/**
 * Advance one display tick. The full received text is immutable input; only
 * the returned reveal cursor is display state.
 */
export function stepDrain(text, done, state, dtMs) {
  let { revealed, fractional, holdMs } = state;
  let remainingMs = Math.max(0, dtMs);

  if (holdMs > 0) {
    const consumed = Math.min(holdMs, remainingMs);
    holdMs -= consumed;
    remainingMs -= consumed;
    if (remainingMs <= 0) return { revealed, fractional, holdMs };
  }
  if (revealed >= text.length) {
    return { revealed: text.length, fractional: 0, holdMs: 0 };
  }

  const rate = effectiveRate(text.length - revealed, done);
  let budget = fractional + (rate * remainingMs) / 1000;
  while (budget >= 1 && revealed < text.length) {
    budget -= 1;
    revealed += 1;
    const pause = pauseAfter(text, revealed - 1);
    if (pause > 0) {
      return { revealed, fractional: 0, holdMs: pause };
    }
  }
  return {
    revealed,
    fractional: revealed >= text.length ? 0 : budget,
    holdMs: 0,
  };
}

export class StreamPacer {
  #text = "";
  #state = initialDrainState();
  #done = false;
  #skipped = false;
  #timer = null;
  #lastTick = 0;
  #onUpdate;

  constructor(onUpdate) {
    this.#onUpdate = onUpdate;
  }

  get received() {
    return this.#text;
  }

  get revealed() {
    return this.#state.revealed;
  }

  get bufferLength() {
    return this.#text.length - this.#state.revealed;
  }

  get draining() {
    return this.#timer !== null;
  }

  append(chunk) {
    if (!chunk) return;
    this.#text += chunk;
    if (this.#skipped) {
      this.#revealAll();
      return;
    }
    this.#ensureLoop();
  }

  /**
   * Teacher continuation replacement is not an append. Reset the reveal
   * cursor so rejected student text can never survive in the hidden buffer.
   */
  replace(text) {
    this.#teardown();
    this.#text = text;
    this.#done = false;
    this.#state = initialDrainState();
    if (this.#skipped) {
      this.#revealAll();
      return;
    }
    this.#onUpdate(0);
    this.#ensureLoop();
  }

  finish() {
    this.#done = true;
    this.#state.holdMs = 0;
    if (this.#skipped) {
      this.#revealAll();
      return;
    }
    this.#ensureLoop();
  }

  /** Reveal everything received now and keep later chunks immediate. */
  skip() {
    this.#skipped = true;
    this.#done = true;
    this.#teardown();
    this.#revealAll();
  }

  reset() {
    this.#teardown();
    this.#text = "";
    this.#done = false;
    this.#skipped = false;
    this.#state = initialDrainState();
  }

  dispose() {
    this.#teardown();
  }

  #revealAll() {
    this.#state = {
      revealed: this.#text.length,
      fractional: 0,
      holdMs: 0,
    };
    this.#onUpdate(this.#state.revealed);
  }

  #ensureLoop() {
    if (this.#timer !== null || this.#state.revealed >= this.#text.length) return;
    this.#lastTick = performance.now();
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  #tick() {
    const now = performance.now();
    const elapsedMs = Math.min(now - this.#lastTick, 250);
    this.#lastTick = now;
    this.#state = stepDrain(this.#text, this.#done, this.#state, elapsedMs);
    this.#onUpdate(this.#state.revealed);
    if (this.#state.revealed >= this.#text.length) this.#teardown();
  }

  #teardown() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

/** Developer escape hatch; reduced-motion users always get immediate text. */
export function pacingEnabled() {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return window.localStorage.getItem("understudy.pacing") !== "off";
  } catch {
    return true;
  }
}
