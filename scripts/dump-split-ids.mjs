import {
  TASKS,
  splitSha256,
} from "../dist/automationbench-offline.js";
import {
  v2SplitSha256,
  v2TaskPool,
} from "../dist/automationbench-v2.js";

const V1_HOLDOUT_SHA256 =
  "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701";
const V2_HOLDOUT_SHA256 =
  "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9";

if (splitSha256("holdout") !== V1_HOLDOUT_SHA256) {
  throw new Error("v1 holdout hash does not match the frozen contract");
}
if (v2SplitSha256("holdout") !== V2_HOLDOUT_SHA256) {
  throw new Error("v2 holdout hash does not match the frozen contract");
}

const ids = (tasks) => tasks.map((task) => task.taskId);

console.log(
  JSON.stringify({
    v2_train: ids(v2TaskPool({ split: "train" })),
    v2_dev: ids(v2TaskPool({ split: "dev" })),
    v2_holdout: ids(
      v2TaskPool({ split: "holdout", frozenHoldoutSha256: V2_HOLDOUT_SHA256 }),
    ),
    v1_holdout: ids(TASKS.filter((task) => task.split === "holdout")),
  }),
);
