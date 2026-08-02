#!/usr/bin/env node
/**
 * Print the pinned hashes and shape of the aop-selection synthetic slice.
 * The holdout hash printed here is what `AOP_FROZEN_HOLDOUT_SHA256` must equal
 * and what a holdout run has to pass back; any fixture edit changes it and the
 * pool refuses to load until the pin is deliberately re-frozen.
 */
import {
  AOP_TASKS,
  aopFixtureSha256,
  aopSplitCounts,
  aopSplitSha256,
  aopTaskBands,
} from "../dist/aop-selection-offline.js";

const bands = AOP_TASKS.reduce((counts, task) => {
  counts[task.band] = (counts[task.band] ?? 0) + 1;
  return counts;
}, {});

console.log(JSON.stringify({
  fixture_id: "aop-selection-offline-v1",
  fixture_sha256: aopFixtureSha256(),
  split_sha256: {
    train: aopSplitSha256("train"),
    dev: aopSplitSha256("dev"),
    holdout: aopSplitSha256("holdout"),
  },
  counts: aopSplitCounts(),
  families: aopTaskBands(),
  band_histogram: bands,
}, null, 2));
