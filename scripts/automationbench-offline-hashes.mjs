import { fixtureSha256, splitCounts, splitSha256 } from "../dist/automationbench-offline.js";

console.log(JSON.stringify({
  fixtureSha256: fixtureSha256(),
  splitSha256: {
    train: splitSha256("train"),
    dev: splitSha256("dev"),
    holdout: splitSha256("holdout"),
  },
  splitCounts: splitCounts(),
}, null, 2));
