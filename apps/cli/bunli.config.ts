import { defineConfig } from "@bunli/core";

export default defineConfig({
  name: "hooka",
  version: "1.0.0",
  description:
    "Composable task, capability, and preset control plane for Hooka.",
  commands: {
    entry: "./src/index.ts",
  },
});
