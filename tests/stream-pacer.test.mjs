import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RATE,
  CATCHUP_DIVISOR,
  MAX_MULTIPLIER,
  PARAGRAPH_PAUSE_MS,
  SENTENCE_PAUSE_MS,
  StreamPacer,
  effectiveRate,
  initialDrainState,
  pauseAfter,
  stepDrain,
} from "../apps/homescreen/app/lib/stream-pacer.mjs";

const filler = (length) => "x".repeat(length);

test("the catch-up curve is bounded and Done drains at 8x", () => {
  assert.equal(effectiveRate(0, false), BASE_RATE);
  assert.equal(effectiveRate(CATCHUP_DIVISOR, false), BASE_RATE * 2);
  assert.equal(effectiveRate(1_000_000, false), BASE_RATE * MAX_MULTIPLIER);
  assert.equal(effectiveRate(1, true), BASE_RATE * MAX_MULTIPLIER);
});

test("sentence and paragraph pauses apply only before more text", () => {
  assert.equal(pauseAfter("Done. Next", 4), SENTENCE_PAUSE_MS);
  assert.equal(pauseAfter("one\n\ntwo", 4), PARAGRAPH_PAUSE_MS);
  assert.equal(pauseAfter("The end.", 7), 0);
  assert.equal(pauseAfter("3.14", 1), 0);
});

test("drain math carries fractions, pauses, and never passes the buffer", () => {
  const text = filler(1_000);
  let ticked = initialDrainState();
  for (let index = 0; index < 10; index += 1) {
    ticked = stepDrain(text, false, ticked, 30);
  }
  const oneShot = stepDrain(text, false, initialDrainState(), 300);
  assert.ok(Math.abs(ticked.revealed - oneShot.revealed) <= 2);

  const sentence = stepDrain(`Hi. ${filler(200)}`, false, initialDrainState(), 1_000);
  assert.equal(sentence.revealed, 3);
  assert.equal(sentence.holdMs, SENTENCE_PAUSE_MS);

  const complete = stepDrain(filler(10), true, initialDrainState(), 60_000);
  assert.deepEqual(complete, { revealed: 10, fractional: 0, holdMs: 0 });
});

function simulateStream({ total, sourceCharsPerSecond, sourceDurationMs }) {
  const tickMs = 30;
  let received = 0;
  let state = initialDrainState();
  let maxLag = 0;
  for (let elapsed = tickMs; elapsed <= sourceDurationMs; elapsed += tickMs) {
    received = Math.min(total, Math.floor((sourceCharsPerSecond * elapsed) / 1_000));
    state = stepDrain(filler(received), false, state, tickMs);
    maxLag = Math.max(maxLag, received - state.revealed);
  }
  let catchupMs = 0;
  while (state.revealed < total && catchupMs < 10_000) {
    state = stepDrain(filler(total), true, state, tickMs);
    catchupMs += tickMs;
  }
  return { maxLag, catchupMs, revealed: state.revealed };
}

test("a slow provider remains effectively live instead of feeling throttled", () => {
  const result = simulateStream({
    total: 100,
    sourceCharsPerSecond: 20,
    sourceDurationMs: 5_000,
  });
  assert.ok(result.maxLag <= 2, `slow-stream lag was ${result.maxLag} characters`);
  assert.equal(result.revealed, 100);
  assert.ok(result.catchupMs <= 30);
});

test("a 1,000-character local burst catches up within two seconds after Done", () => {
  const result = simulateStream({
    total: 1_000,
    sourceCharsPerSecond: 1_000,
    sourceDurationMs: 1_000,
  });
  assert.ok(result.maxLag > 300, "the fast source should exercise the escape hatch");
  assert.equal(result.revealed, 1_000);
  assert.ok(result.catchupMs <= 2_000, `catch-up took ${result.catchupMs}ms`);
});

test("teacher replacement drops the rejected text and skip stays immediate", () => {
  const updates = [];
  const pacer = new StreamPacer((revealed) => updates.push(revealed));
  pacer.append("rejected student answer");
  pacer.replace("teacher correction");
  assert.equal(pacer.received, "teacher correction");
  assert.equal(pacer.revealed, 0);
  assert.equal(updates.at(-1), 0);

  pacer.skip();
  assert.equal(pacer.revealed, "teacher correction".length);
  pacer.append(" continues");
  assert.equal(pacer.revealed, "teacher correction continues".length);
  pacer.replace("final teacher answer");
  assert.equal(pacer.received, "final teacher answer");
  assert.equal(pacer.revealed, "final teacher answer".length);
  pacer.dispose();
});
