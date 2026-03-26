import { expect, test } from "bun:test";
import { loadInstalledCapabilities } from "./index";

test("loadInstalledCapabilities honors HOOKA_INSTALLED_CAPABILITIES override", async () => {
  const previousCapabilities = Bun.env.HOOKA_INSTALLED_CAPABILITIES;
  const previousRole = Bun.env.HOOKA_RUNTIME_ROLE;

  Bun.env.HOOKA_INSTALLED_CAPABILITIES = "wrangler,wpcli,php-cli";
  Bun.env.HOOKA_RUNTIME_ROLE = "worker:wp-wrangler";

  try {
    const manifest = await loadInstalledCapabilities("/definitely/missing.json");

    expect(manifest.installed).toEqual(["wrangler", "wpcli", "php-cli"]);
    expect(manifest.image).toBe("worker:wp-wrangler");
  } finally {
    if (previousCapabilities === undefined) {
      delete Bun.env.HOOKA_INSTALLED_CAPABILITIES;
    } else {
      Bun.env.HOOKA_INSTALLED_CAPABILITIES = previousCapabilities;
    }

    if (previousRole === undefined) {
      delete Bun.env.HOOKA_RUNTIME_ROLE;
    } else {
      Bun.env.HOOKA_RUNTIME_ROLE = previousRole;
    }
  }
});
