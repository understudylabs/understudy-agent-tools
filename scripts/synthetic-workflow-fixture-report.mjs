import {
  fixtureSha256,
  splitCounts,
  splitSha256,
  taskBands,
} from "../dist/synthetic-workflow-offline.js";

const bands = Object.values(taskBands()).reduce((counts, band) => {
  counts[band] = (counts[band] ?? 0) + 6;
  return counts;
}, {});

console.log(JSON.stringify({
  fixture_sha256: fixtureSha256(),
  split_sha256: {
    train: splitSha256("train"),
    dev: splitSha256("dev"),
    holdout: splitSha256("holdout"),
  },
  counts: splitCounts(),
  band_histogram: bands,
}, null, 2));
