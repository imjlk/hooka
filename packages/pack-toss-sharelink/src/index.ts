import { defineTask, defineTaskPack } from "@hooka/task-sdk";
import {
  exportInput,
  refreshInput,
  performanceInput,
  settlementInput,
} from "./contracts";
import { runSharelink } from "./service";

export {
  configSchema,
  refreshInput,
  exportInput,
  snapshotSchema,
  offerSchema,
  isIssuedLink,
  performanceInput,
  settlementInput,
  reportSchema,
} from "./contracts";
export type { Snapshot, Offer, ResultEntry } from "./contracts";

export const refreshSharelinkTask = defineTask({
  id: "toss-sharelink.refresh",
  title: "Refresh Toss Sharelink matches",
  description:
    "Match reviewed subjects to available products and atomically publish per-app snapshots.",
  input: refreshInput,
  requires: ["toss-sharelink"],
  tags: ["shopping", "affiliate", "toss-sharelink"],
  executor: {
    kind: "internal",
    run: ({ input, env, dryRun }) =>
      runSharelink(input, env, dryRun, "refresh"),
  },
});
export const exportSharelinkTask = defineTask({
  id: "toss-sharelink.export",
  title: "Export current Toss Sharelink offers",
  description:
    "Publish current non-expired offers without calling Toss; withdraw changed or disabled rules.",
  input: exportInput,
  requires: ["toss-sharelink"],
  tags: ["shopping", "affiliate", "toss-sharelink"],
  executor: {
    kind: "internal",
    run: ({ input, env, dryRun }) => runSharelink(input, env, dryRun, "export"),
  },
});
export const ensureSubTagTask = defineTask({
  id: "toss-sharelink.subtag.ensure",
  title: "Register configured Toss Sharelink subTag",
  description:
    "Explicitly create or restore the configured app channel; never delete or rename channels.",
  input: exportInput,
  requires: ["toss-sharelink"],
  tags: ["shopping", "affiliate", "channel"],
  executor: {
    kind: "internal",
    run: ({ input, env, dryRun }) =>
      runSharelink(input, env, dryRun, "subtags"),
  },
});
export const performanceTask = defineTask({
  id: "toss-sharelink.performance.sync",
  title: "Collect Toss Sharelink performance",
  description:
    "Collect a complete app subTag report for up to 31 days; provisional metrics remain private.",
  input: performanceInput,
  requires: ["toss-sharelink"],
  tags: ["shopping", "affiliate", "report"],
  executor: {
    kind: "internal",
    run: ({ input, env, dryRun }) =>
      runSharelink(input, env, dryRun, "performance"),
  },
});
export const settlementTask = defineTask({
  id: "toss-sharelink.settlement.sync",
  title: "Collect Toss Sharelink settlement performance",
  description:
    "Collect confirmed monthly commission performance, not actual payout or tax status.",
  input: settlementInput,
  requires: ["toss-sharelink"],
  tags: ["shopping", "affiliate", "report"],
  executor: {
    kind: "internal",
    run: ({ input, env, dryRun }) =>
      runSharelink(input, env, dryRun, "settlement"),
  },
});

export const tossSharelinkTaskPack = defineTaskPack({
  id: "@hooka/pack-toss-sharelink",
  title: "Toss Sharelink Pack",
  description:
    "Shared-account product matching with app-scoped, versioned snapshot delivery.",
  tasks: [
    refreshSharelinkTask,
    exportSharelinkTask,
    ensureSubTagTask,
    performanceTask,
    settlementTask,
  ],
});
