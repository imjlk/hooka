import { expect, test } from "bun:test";
import { createRunStore } from "./index";

test("coalescing reuses active jobs across event buckets, but not terminal jobs or other tasks", async () => {
  const store = await createRunStore({ dbPath: ":memory:" });
  const input = {
    taskId: "task-one",
    input: {},
    source: "test",
    capabilitySnapshot: [],
    coalesceKey: "app-batch",
  };
  try {
    const first = store.enqueueRun({ ...input, sourceEventId: "bucket-one" });
    const second = store.enqueueRun({ ...input, sourceEventId: "bucket-two" });
    expect(second.created).toBe(false);
    expect(second.response.runId).toBe(first.response.runId);
    expect(store.enqueueRun({ ...input, taskId: "task-two" }).created).toBe(
      true,
    );
    store.finishRun(first.response.runId, {
      taskId: input.taskId,
      ok: true,
      status: "succeeded",
      durationMs: 1,
    });
    expect(
      store.enqueueRun({ ...input, sourceEventId: "bucket-one" }).created,
    ).toBe(false);
    expect(
      store.enqueueRun({ ...input, sourceEventId: "bucket-two" }).created,
    ).toBe(true);
  } finally {
    store.close();
  }
});
