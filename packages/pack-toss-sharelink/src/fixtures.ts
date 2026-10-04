import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type App, type Account } from "./contracts";
import { SharelinkStore } from "./store";

export const testAccount: Account = {
  accountId: "partner",
  publisherId: "00000000-0000-4000-8000-000000000001",
  accessKeyEnv: "TEST_ACCESS",
  secretKeyEnv: "TEST_SECRET",
  productBudget: 9000,
  linkBudget: 9000,
};
export const testProduct = (
  id = 123,
  overrides: Record<string, unknown> = {},
) => ({
  tacaItemId: id,
  displayName: "편안한 베개",
  categoryIds: [10, 11],
  isSoldOut: false,
  ...overrides,
});
export const testApp = (): App => {
  const app = configSchema.parse({
    schemaVersion: 1,
    accounts: [testAccount],
    apps: [
      {
        appId: "app-one",
        accountId: "partner",
        revision: 1,
        subTagId: "app-one-web",
        subjects: [
          {
            subjectId: "pillow",
            revision: 1,
            categoryId: "10",
            keywords: ["베개"],
            excludedKeywords: ["커버"],
          },
        ],
      },
    ],
  }).apps[0];
  if (!app) throw new Error("Missing app fixture");
  return app;
};

export async function temporarySetup(apps: App[] = [testApp()]) {
  const directory = await mkdtemp(join(tmpdir(), "hooka-sharelink-"));
  const env = {
    HOOKA_SHARELINK_CONFIG_PATH: join(directory, "config.json"),
    HOOKA_SHARELINK_DB_PATH: join(directory, "private", "store.sqlite"),
    HOOKA_SHARELINK_RESULTS_PATH: join(directory, "results"),
    TEST_ACCESS: "test-access",
    TEST_SECRET: "test-secret",
  };
  const writeConfig = (nextApps = apps) =>
    Bun.write(
      env.HOOKA_SHARELINK_CONFIG_PATH,
      JSON.stringify({
        schemaVersion: 1,
        accounts: [testAccount],
        apps: nextApps,
      }),
    );
  await writeConfig();
  return {
    directory,
    env,
    writeConfig,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function testStore(path: string) {
  const store = await SharelinkStore.open(path);
  store.bindAccount(testAccount, "test-access");
  return store;
}
export const success = (body: unknown) =>
  Response.json({ resultType: "SUCCESS", success: body });
