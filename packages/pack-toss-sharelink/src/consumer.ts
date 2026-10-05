import { snapshotSchema, type Offer, type Snapshot } from "./contracts";

export type SnapshotValidation =
  | { ok: true; snapshot: Snapshot }
  | {
      ok: false;
      code:
        | "invalid-schema"
        | "app-mismatch"
        | "duplicate-subject"
        | "invalid-time"
        | "rule-mismatch";
    };

/** Stateless whole-file validation. Importers persist generation ordering/idempotency themselves. */
export function validateSharelinkSnapshot(
  input: unknown,
  expected: {
    appId: string;
    appRevision: number;
    subjects?: { subjectId: string; ruleRevision: number }[];
  },
  now = Date.now(),
): SnapshotValidation {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid-schema" };
  const snapshot = parsed.data;
  if (
    snapshot.appId !== expected.appId ||
    snapshot.appRevision !== expected.appRevision
  )
    return { ok: false, code: "app-mismatch" };
  if (
    new Set(snapshot.entries.map((entry) => entry.subjectId)).size !==
    snapshot.entries.length
  )
    return { ok: false, code: "duplicate-subject" };
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(snapshot.generatedAt) ||
    snapshot.generatedAt > now ||
    snapshot.entries.some(
      (entry) =>
        entry.offer &&
        (!Number.isSafeInteger(entry.offer.checkedAt) ||
          !Number.isSafeInteger(entry.offer.expiresAt) ||
          entry.offer.checkedAt > snapshot.generatedAt ||
          entry.offer.expiresAt > snapshot.generatedAt + 15 * 60000),
    )
  )
    return { ok: false, code: "invalid-time" };
  if (
    expected.subjects &&
    (new Set(expected.subjects.map((subject) => subject.subjectId)).size !==
      expected.subjects.length ||
      snapshot.entries.length !== expected.subjects.length ||
      snapshot.entries.some(
        (entry) =>
          !expected.subjects?.some(
            (subject) =>
              subject.subjectId === entry.subjectId &&
              subject.ruleRevision === entry.ruleRevision,
          ),
      ))
  )
    return { ok: false, code: "rule-mismatch" };
  return { ok: true, snapshot };
}

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
  const validated = validateSharelinkSnapshot(input, expected, now);
  if (!validated.ok) return null;
  const snapshot = validated.snapshot;
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
