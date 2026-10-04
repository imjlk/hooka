import { testAccount } from "../fixtures";
import { SharelinkStore } from "../store";
import { isTaskExecutionError } from "@hooka/task-sdk";

const [path, mode] = Bun.argv.slice(2);
if (!path) throw new Error("Missing test store path");
const store = await SharelinkStore.open(path);
store.bindAccount(testAccount, "test-access");
try {
  await store.withAccount(testAccount.accountId, async () => {
    console.log("held");
    if (mode === "hold") await Bun.stdin.text();
  });
} catch (error) {
  if (!isTaskExecutionError(error)) throw error;
  console.log(error.code);
} finally {
  store.close();
}
