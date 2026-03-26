import { defineTaskPack } from "@hooka/task-sdk";
import { exportVerifyTask } from "./tasks/exportVerify";
import { wpcliEvalTask } from "./tasks/wpcliEval";

export { exportVerifyInput, exportVerifyTask } from "./tasks/exportVerify";
export { wpcliEvalInput, wpcliEvalTask } from "./tasks/wpcliEval";

export const wordpressTaskPack = defineTaskPack({
  id: "@hooka/pack-wordpress",
  title: "WordPress Pack",
  description: "WordPress automation tasks for wp-cli and export validation.",
  tasks: [wpcliEvalTask, exportVerifyTask],
});
