import { snapshotSchema, type Offer } from "./contracts";

/** Validate at each read/click; never extend an offer's expiry on the consumer. */
export function selectSharelinkOffer(
  input: unknown,
  expected: {
    appId: string;
    appRevision: number;
    subjectId: string;
    ruleRevision: number;
  },
  now = Date.now(),
): Offer | null {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return null;
  const snapshot = parsed.data;
  if (
    snapshot.appId !== expected.appId ||
    snapshot.appRevision !== expected.appRevision ||
    snapshot.generatedAt > now ||
    new Set(snapshot.entries.map((entry) => entry.subjectId)).size !==
      snapshot.entries.length
  )
    return null;
  const entry = snapshot.entries.find(
    (item) => item.subjectId === expected.subjectId,
  );
  if (
    entry?.ruleRevision !== expected.ruleRevision ||
    entry.status !== "ready" ||
    !entry.offer
  )
    return null;
  if (entry.offer.checkedAt > now || entry.offer.expiresAt <= now) return null;
  return entry.offer;
}
