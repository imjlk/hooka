// Child process for the run-store concurrency tests. It opens its own store
// connection on a shared database file, waits for a common start time so all
// processes collide, and then either only opens the store (`open`) or loops
// requeue + claim like a worker would (`claim`), printing the claimed run ids.
import { createRunStore } from "../index";

const [dbPath, mode, workerId, startAtText] = process.argv.slice(2);

if (!dbPath || !mode || !workerId || !startAtText) {
  throw new Error("Usage: concurrent-store-process <db> <mode> <worker> <at>");
}

const startAt = Number(startAtText);
while (Date.now() < startAt) {
  // Busy-wait so every process leaves the barrier at the same moment.
}

const store = await createRunStore({ dbPath });
const claimed: string[] = [];

if (mode === "claim") {
  let idlePolls = 0;
  while (idlePolls < 20) {
    store.requeueExpiredRuns();
    const run = store.claimNextQueuedRun(workerId, 600_000);

    if (run) {
      claimed.push(run.id);
      idlePolls = 0;
    } else {
      idlePolls += 1;
      await Bun.sleep(1);
    }
  }
}

store.close();
console.log(JSON.stringify({ claimed }));
