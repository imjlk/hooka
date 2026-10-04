import { selectSharelinkOffer } from "../../packages/pack-toss-sharelink/src/consumer";

/** Backend example: mount only this app's snapshot directory read-only. Expected
 * identities/revisions must come from the consumer's trusted catalog, never the
 * snapshot being validated. Re-run on click as well as initial display. */
export async function readOffer(
  path: string,
  expected: Parameters<typeof selectSharelinkOffer>[1],
) {
  try {
    const file = Bun.file(path);
    if (file.size > 8388608) return null;
    return selectSharelinkOffer(await file.json(), expected);
  } catch {
    return null;
  }
}
