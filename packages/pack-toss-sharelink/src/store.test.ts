import { expect, test } from "bun:test";
import { temporarySetup, testAccount, testApp, testStore } from "./fixtures";

test("separate processes sharing a volume cannot own the same account together", async () => {
  const setup = await temporarySetup();
  const script = `${import.meta.dir}/fixtures/account-worker.ts`;
  const first = Bun.spawn(
    [process.execPath, script, setup.env.HOOKA_SHARELINK_DB_PATH, "hold"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = first.stdout.getReader();
    const message = await reader.read();
    expect(new TextDecoder().decode(message.value)).toContain("held");
    reader.releaseLock();
    const second = Bun.spawn(
      [process.execPath, script, setup.env.HOOKA_SHARELINK_DB_PATH, "attempt"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(second.stdout).text()).toContain(
      "sharelink_account_busy",
    );
    expect(await second.exited).toBe(0);
  } finally {
    first.stdin.end();
    await first.exited;
    await setup.cleanup();
  }
});

test("expired owners cannot write after another connection acquires the lease", async () => {
  const setup = await temporarySetup();
  const first = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  const second = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  try {
    await first.withAccount("partner", async () => {
      first.db
        .query("UPDATE sharelink_accounts SET lease_until=0 WHERE id='partner'")
        .run();
      await second.withAccount("partner", async () => {
        second.put("partner", "value", "new", Date.now() + 60000);
        expect(() =>
          first.put("partner", "value", "stale", Date.now() + 60000),
        ).toThrow("lease_lost");
      });
    });
    expect(second.get("partner", "value")?.value).toBe("new");
  } finally {
    first.close();
    second.close();
    await setup.cleanup();
  }
});

test("daily reservations persist across store connections and reject overspend", async () => {
  const setup = await temporarySetup();
  const first = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  try {
    await first.withAccount("partner", async () =>
      first.reserve({ ...testAccount, productBudget: 30 }, 30, 0),
    );
  } finally {
    first.close();
  }
  const second = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  try {
    await second.withAccount("partner", async () => {
      expect(() => second.reserve(testAccount, 1, 0)).toThrow(
        "local_daily_budget",
      );
      expect(() => second.reserve(testAccount, 0, 0)).not.toThrow();
    });
  } finally {
    second.close();
    await setup.cleanup();
  }
});

test("app revision guard rejects changed same-version and older configurations", async () => {
  const setup = await temporarySetup();
  const store = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  try {
    await store.withAccount("partner", async () => {
      store.bindApp(testApp());
      expect(() =>
        store.bindApp({ ...testApp(), subTagId: "different" }),
      ).toThrow("app_revision_conflict");
      store.bindApp({ ...testApp(), revision: 2 });
      expect(() => store.bindApp(testApp())).toThrow("app_revision_conflict");
    });
    expect(() =>
      store.bindAccount({ ...testAccount, accountId: "alias" }, "test-access"),
    ).toThrow();
  } finally {
    store.close();
    await setup.cleanup();
  }
});
