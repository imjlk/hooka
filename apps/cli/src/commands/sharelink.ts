import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  readSharelinkConfig,
  readSharelinkAccounts,
  readSharelinkSnapshot,
  planSharelinkRefresh,
  summarizeSharelinkApp,
  matchProducts,
  type Product,
  type Category,
} from "@hooka/pack-toss-sharelink";
import { createRunStore } from "@hooka/run-store";
import { defineCommand, defineGroup, option } from "../lib/command";
import { booleanFlag, type CliDefaults } from "../lib/shared";

/** Administrative tools read local operator-owned files; all output is JSON. */
export function createSharelinkCommandGroup(defaults: CliDefaults) {
  const config = option(
    z
      .string()
      .min(1)
      .default(Bun.env["HOOKA_SHARELINK_CONFIG_PATH"] ?? ""),
    {
      description:
        "Operator config JSON path (or HOOKA_SHARELINK_CONFIG_PATH).",
    },
  );
  const domain = option(
    z
      .string()
      .min(1)
      .default(Bun.env["HOOKA_SHARELINK_DB_PATH"] ?? ""),
    { description: "Private Sharelink SQLite path." },
  );
  const results = option(
    z
      .string()
      .min(1)
      .default(Bun.env["HOOKA_SHARELINK_RESULTS_PATH"] ?? ""),
    { description: "Consumer snapshot directory." },
  );
  const app = option(z.string().optional(), {
    description: "Limit work to one configured app.",
  });
  const scheduleOptions = {
    config,
    domain,
    app,
    "batch-size": option(z.coerce.number().int().min(1).max(100).default(25), {
      description: "Subjects per job (1..100).",
    }),
    "period-minutes": option(z.coerce.number().int().min(1).max(5).default(5), {
      description: "Idempotency bucket length (1..5 minutes).",
    }),
  };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  return defineGroup({
    name: "sharelink",
    description: "Validate, inspect and schedule shared product operations.",
    commands: [
      defineCommand({
        name: "validate",
        description:
          "Validate config offline without reading credentials or creating a database.",
        options: { config },
        handler: async ({ flags }) => {
          const data = await readSharelinkConfig(flags.config);
          print({
            ok: true,
            schemaVersion: 1,
            accounts: data.accounts.length,
            apps: data.apps.map((item) => ({
              appId: item.appId,
              subjects: item.subjects.length,
            })),
            warnings: data.accounts.flatMap((account) => {
              const enabled = data.apps
                .filter((item) => item.accountId === account.accountId)
                .flatMap((item) => item.subjects)
                .filter((subject) => subject.enabled && !subject.manual).length;
              return enabled * 144 > account.productBudget
                ? [
                    `${account.accountId}: ${enabled} automatic subjects may exceed the daily budget with ten-minute detail renewal; scope the active catalog.`,
                  ]
                : [];
            }),
          });
        },
      }),
      defineCommand({
        name: "status",
        description:
          "Read app freshness and account budgets without exposing cached secrets.",
        options: {
          config,
          domain,
          results,
          db: option(z.string().default(defaults.dbPath), {
            description: "Queue DB for recent failure codes (read-only).",
          }),
        },
        handler: async ({ flags }) => {
          const data = await readSharelinkConfig(flags.config);
          const accounts = (await Bun.file(flags.domain).exists())
            ? readSharelinkAccounts(flags.domain, data)
            : [];
          const apps = await Promise.all(
            data.apps.map(async (item) =>
              summarizeSharelinkApp(
                item,
                await readSharelinkSnapshot(flags.results, item.appId),
              ),
            ),
          );
          let recentFailures: unknown[] = [];
          if (await Bun.file(flags.db).exists()) {
            const queue = new Database(flags.db, {
              readonly: true,
              strict: true,
            });
            try {
              recentFailures = queue
                .query<
                  {
                    runId: string;
                    taskId: string;
                    appId: string;
                    status: string;
                    errorCode: string | null;
                  },
                  []
                >(
                  "SELECT id AS runId,task_id AS taskId,json_extract(payload_json,'$.appId') AS appId,status,last_error_code AS errorCode FROM runs WHERE task_id LIKE 'toss-sharelink.%' AND status IN ('failed','dead-lettered') ORDER BY created_at DESC LIMIT 100",
                )
                .all()
                .filter((item) =>
                  data.apps.some(
                    (configured) => configured.appId === item.appId,
                  ),
                );
            } finally {
              queue.close();
            }
          }
          print({
            schemaVersion: 1,
            initialized: accounts.length > 0,
            accounts,
            apps,
            recentFailures,
          });
        },
      }),
      defineCommand({
        name: "preview",
        description:
          "Preview lexical matching against an offline fixture, without issuing links.",
        options: {
          config,
          app: option(z.string().min(1), { description: "App ID." }),
          fixture: option(z.string().min(1), {
            description: "JSON with normalized categories and products.",
          }),
        },
        handler: async ({ flags }) => {
          const data = await readSharelinkConfig(flags.config);
          const selected = data.apps.find((item) => item.appId === flags.app);
          if (!selected) throw new Error("Unknown app.");
          const file = Bun.file(flags.fixture);
          if (file.size > 1048576) throw new Error("Fixture exceeds 1 MiB.");
          const category: z.ZodType<Category> = z.lazy(() =>
            z.object({ id: z.string(), children: z.array(category) }),
          );
          const product: z.ZodType<Product> = z.object({
            id: z.string(),
            title: z.string().max(180),
            categoryIds: z.array(z.string()),
            soldOut: z.boolean(),
            endAt: z.number().optional(),
          });
          const fixture = z
            .object({
              categories: z.array(category),
              products: z.array(product).max(1000),
            })
            .parse(await file.json());
          print({
            appId: selected.appId,
            subjects: selected.subjects.map((subject) => ({
              subjectId: subject.subjectId,
              enabled: subject.enabled,
              candidates: subject.enabled
                ? matchProducts(
                    fixture.products,
                    fixture.categories,
                    subject,
                  ).map((item) => ({ productId: item.id, title: item.title }))
                : [],
            })),
          });
        },
      }),
      defineCommand({
        name: "plan",
        description:
          "Print bounded, deterministic refresh jobs without queuing or provider calls.",
        options: scheduleOptions,
        handler: async ({ flags }) => {
          const data = await readSharelinkConfig(flags.config);
          const accounts = (await Bun.file(flags.domain).exists())
            ? readSharelinkAccounts(flags.domain, data)
            : [];
          print(
            planSharelinkRefresh(data, accounts, {
              appId: flags.app,
              batchSize: flags["batch-size"],
              periodMinutes: flags["period-minutes"],
            }),
          );
        },
      }),
      defineCommand({
        name: "tick",
        description:
          "Enqueue one refresh cycle; invoke periodically from an external scheduler.",
        options: {
          ...scheduleOptions,
          db: option(z.string().default(defaults.dbPath), {
            description: "This stack's Hooka queue DB.",
          }),
          "dry-run": booleanFlag({
            description: "Print the plan without creating a queue.",
          }),
        },
        handler: async ({ flags }) => {
          if (resolve(flags.db) === resolve(flags.domain))
            throw new Error("Queue and product store must be separate files.");
          const data = await readSharelinkConfig(flags.config);
          const accounts = (await Bun.file(flags.domain).exists())
            ? readSharelinkAccounts(flags.domain, data)
            : [];
          const plan = planSharelinkRefresh(data, accounts, {
            appId: flags.app,
            batchSize: flags["batch-size"],
            periodMinutes: flags["period-minutes"],
          });
          if (flags["dry-run"]) {
            print(plan);
            return;
          }
          const store = await createRunStore({ dbPath: flags.db });
          try {
            const runs = plan.jobs.map((job) => {
              const queued = store.enqueueRun({
                taskId: job.taskId,
                input: job.input,
                sourceEventId: job.sourceEventId,
                source: "sharelink.scheduler",
                coalesceKey: createHash("sha256")
                  .update(JSON.stringify([job.taskId, job.input]))
                  .digest("hex"),
                capabilitySnapshot: ["toss-sharelink"],
                maxAttempts: 5,
              });
              return {
                appId: job.appId,
                runId: queued.response.runId,
                created: queued.created,
              };
            });
            print({ schemaVersion: 1, runs, skipped: plan.skipped });
          } finally {
            store.close();
          }
        },
      }),
    ],
  });
}
