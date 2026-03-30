import { defineTaskPack } from "@hooka/task-sdk";
import { purgeCacheUrlsTask } from "./tasks/purgeCacheUrls";

export {
  purgeCacheUrlsInput,
  purgeCacheUrlsTask,
} from "./tasks/purgeCacheUrls";

export const cloudflareCacheTaskPack = defineTaskPack({
  id: "@hooka/pack-cloudflare-cache",
  title: "Cloudflare Cache Pack",
  description: "Cache purge tasks backed by the Cloudflare HTTP API.",
  tasks: [purgeCacheUrlsTask],
});
