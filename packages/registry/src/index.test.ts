import { expect, test } from "bun:test";
import {
  getPresetPlan,
  recommendPresetForTasks,
  validateRegistry,
} from "./index";

test("registry validates without duplicate definitions", () => {
  expect(validateRegistry()).toEqual({
    ok: true,
    errors: [],
  });
});

test("wp-wrangler preset covers the wordpress/cloudflare deploy bridge", () => {
  const plan = getPresetPlan("wp-wrangler");

  expect(plan?.coveredTasks).toContain("wordpress.deploy.simply-static");
  expect(plan?.missingCapabilitiesByTask).toEqual({});
  expect(
    recommendPresetForTasks(["wordpress.deploy.simply-static"])?.id,
  ).toBe("wp-wrangler");
});
