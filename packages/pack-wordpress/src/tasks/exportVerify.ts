import { defineTask } from "@hooka/task-sdk";
import { stat } from "node:fs/promises";
import { z } from "zod";

export const exportVerifyInput = z.object({
  exportDir: z.string().default("/shared-source/simply-static"),
  pattern: z.string().default("**/*.html"),
});

export const exportVerifyTask = defineTask({
  id: "wordpress.export.verify",
  title: "Verify Simply Static export output",
  description: "Count generated files in the export directory before deploy.",
  input: exportVerifyInput,
  requires: [],
  executor: {
    kind: "internal",
    run: async ({ input, dryRun }) => {
      if (dryRun) {
        return {
          exportDir: input.exportDir,
          htmlFiles: 0,
          dryRun: true,
        };
      }

      let directoryStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        directoryStat = await stat(input.exportDir);
      } catch {
        // Keep the null sentinel so we can produce a clearer not-found error below.
      }

      if (!directoryStat?.isDirectory()) {
        throw new Error(`Export directory not found: ${input.exportDir}`);
      }

      let htmlFiles = 0;
      for await (const _match of new Bun.Glob(input.pattern).scan({
        cwd: input.exportDir,
        absolute: false,
      })) {
        htmlFiles += 1;
      }

      return {
        exportDir: input.exportDir,
        htmlFiles,
      };
    },
    summarize: ({ data }) => {
      const payload = data as { exportDir: string; htmlFiles: number };
      return `Verified ${payload.htmlFiles} exported HTML files in ${payload.exportDir}.`;
    },
  },
  tags: ["wordpress", "export"],
});
