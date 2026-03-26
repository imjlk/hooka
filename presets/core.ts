import { definePreset } from "@hooka/task-sdk";

export const corePreset = definePreset({
  id: "core",
  title: "Core",
  description: "Minimal Hooka runtime without extra operational tooling.",
  imageTag: "core",
  capabilities: [],
  taskPacks: [],
  notes: ["Useful for custom builds or registry-only environments."],
});
