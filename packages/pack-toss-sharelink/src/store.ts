import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Account, App, ResultEntry } from "./contracts";
import { resultEntrySchema } from "./contracts";
import { failure } from "./errors";

export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const nextKstDay = (now = Date.now()): number =>
  Math.floor((now + 9 * 3600000) / 86400000 + 1) * 86400000 - 9 * 3600000;
const LEASE_MS = 60000;

/** Dedicated domain store. Never point this at Hooka's run DB or a consumer DB. */
export class SharelinkStore {
  private leaseGuard: (() => void) | undefined;
  private constructor(readonly db: Database) {}

  private mutate<T>(action: () => T): T {
    return this.db
      .transaction(() => {
        if (!this.leaseGuard) throw failure("lease_required");
        this.leaseGuard();
        return action();
      })
      .immediate();
  }

  static async open(path: string): Promise<SharelinkStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path, { create: true, strict: true });
    try {
      await chmod(path, 0o600);
      db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );
      db.transaction(() => {
        const version = db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version;
        if (version !== 0 && version !== 1)
          throw failure("unsupported_store_version");
        db.exec(`
          CREATE TABLE IF NOT EXISTS sharelink_accounts (
            id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE,
            lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
            next_call INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS sharelink_cache (
            account_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
            expires_at INTEGER NOT NULL, PRIMARY KEY (account_id, key)
          );
          CREATE TABLE IF NOT EXISTS sharelink_budget (
            account_id TEXT NOT NULL, day_end INTEGER NOT NULL,
            products INTEGER NOT NULL DEFAULT 0, links INTEGER NOT NULL DEFAULT 0,
            product_limit INTEGER NOT NULL, link_limit INTEGER NOT NULL,
            PRIMARY KEY (account_id, day_end)
          );
          CREATE TABLE IF NOT EXISTS sharelink_apps (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sharelink_results (
            app_id TEXT NOT NULL, subject_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            value TEXT NOT NULL, PRIMARY KEY (app_id, subject_id)
          );
          PRAGMA user_version = 1;
        `);
      }).immediate();
      return new SharelinkStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  bindAccount(account: Account, accessKey: string): void {
    const identity = digest(accessKey);
    this.db
      .query(
        "INSERT INTO sharelink_accounts(id,identity) VALUES (?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(account.accountId, identity);
    const row = this.db
      .query<{ identity: string }, [string]>(
        "SELECT identity FROM sharelink_accounts WHERE id=?",
      )
      .get(account.accountId);
    if (row?.identity !== identity) throw failure("account_identity_changed");
  }

  /** Serializes provider/cache/budget access across all sidecars on this host. */
  async withAccount<T>(
    accountId: string,
    action: (guard: () => void) => Promise<T>,
  ): Promise<T> {
    const owner = randomUUID();
    const acquired = this.db
      .query(
        "UPDATE sharelink_accounts SET lease_owner=?,lease_until=? WHERE id=? AND lease_until<=?",
      )
      .run(owner, Date.now() + LEASE_MS, accountId, Date.now());
    if (acquired.changes !== 1) throw failure("account_busy", true);
    let lost = false;
    const guard = () => {
      const row = this.db
        .query<{ lease_owner: string; lease_until: number }, [string]>(
          "SELECT lease_owner,lease_until FROM sharelink_accounts WHERE id=?",
        )
        .get(accountId);
      if (lost || row?.lease_owner !== owner || row.lease_until <= Date.now())
        throw failure("lease_lost", true);
    };
    const timer = setInterval(() => {
      try {
        const changed = this.db
          .query(
            "UPDATE sharelink_accounts SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?",
          )
          .run(Date.now() + LEASE_MS, accountId, owner, Date.now());
        if (changed.changes !== 1) lost = true;
      } catch {
        lost = true;
      }
    }, 10000);
    this.leaseGuard = guard;
    try {
      return await action(guard);
    } finally {
      clearInterval(timer);
      this.leaseGuard = undefined;
      this.db
        .query(
          "UPDATE sharelink_accounts SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?",
        )
        .run(accountId, owner);
    }
  }

  bindApp(app: App): void {
    this.mutate(() => {
      this.db
        .transaction(() => {
          const fingerprint = digest(app);
          const row = this.db
            .query<
              { account_id: string; revision: number; fingerprint: string },
              [string]
            >(
              "SELECT account_id,revision,fingerprint FROM sharelink_apps WHERE id=?",
            )
            .get(app.appId);
          if (
            row &&
            (row.account_id !== app.accountId ||
              row.revision > app.revision ||
              (row.revision === app.revision &&
                row.fingerprint !== fingerprint))
          )
            throw failure("app_revision_conflict");
          this.db
            .query(
              "INSERT INTO sharelink_apps VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint",
            )
            .run(app.appId, app.accountId, app.revision, fingerprint);
          const keep = new Set(
            app.subjects.map((subject) => subject.subjectId),
          );
          const stored = this.db
            .query<{ subject_id: string }, [string]>(
              "SELECT subject_id FROM sharelink_results WHERE app_id=?",
            )
            .all(app.appId);
          for (const row of stored)
            if (!keep.has(row.subject_id)) {
              this.db
                .query(
                  "DELETE FROM sharelink_results WHERE app_id=? AND subject_id=?",
                )
                .run(app.appId, row.subject_id);
            }
        })
        .immediate();
    });
  }

  async pace(accountId: string, guard: () => void): Promise<void> {
    guard();
    const row = this.db
      .query<{ next_call: number; blocked_until: number }, [string]>(
        "SELECT next_call,blocked_until FROM sharelink_accounts WHERE id=?",
      )
      .get(accountId);
    if (!row) throw failure("unknown_account");
    if (row.blocked_until > Date.now()) throw failure("account_cooldown");
    await Bun.sleep(Math.max(0, row.next_call - Date.now()));
    guard();
    this.mutate(() =>
      this.db
        .query("UPDATE sharelink_accounts SET next_call=? WHERE id=?")
        .run(Date.now() + 300, accountId),
    );
  }

  block(accountId: string, until: number): void {
    this.mutate(() => {
      this.db
        .query(
          "UPDATE sharelink_accounts SET blocked_until=MAX(blocked_until,?) WHERE id=?",
        )
        .run(until, accountId);
    });
  }

  reserve(account: Account, products: number, links: number): void {
    this.mutate(() => {
      if (products === 0 && links === 0) return;
      const end = nextKstDay();
      this.db
        .transaction(() => {
          this.db
            .query(`INSERT INTO sharelink_budget(account_id,day_end,product_limit,link_limit) VALUES (?,?,?,?)
        ON CONFLICT(account_id,day_end) DO UPDATE SET product_limit=MIN(product_limit,excluded.product_limit),link_limit=MIN(link_limit,excluded.link_limit)`)
            .run(
              account.accountId,
              end,
              account.productBudget,
              account.linkBudget,
            );
          const updated = this.db
            .query(`UPDATE sharelink_budget SET products=products+?,links=links+?
        WHERE account_id=? AND day_end=? AND products+?<=product_limit AND links+?<=link_limit`)
            .run(products, links, account.accountId, end, products, links);
          if (updated.changes !== 1) throw failure("local_daily_budget");
        })
        .immediate();
    });
  }

  get<T>(
    accountId: string,
    key: string,
  ): { value: T; expiresAt: number } | null {
    const row = this.db
      .query<{ value: string; expires_at: number }, [string, string, number]>(
        "SELECT value,expires_at FROM sharelink_cache WHERE account_id=? AND key=? AND expires_at>?",
      )
      .get(accountId, key, Date.now());
    return row
      ? { value: JSON.parse(row.value) as T, expiresAt: row.expires_at }
      : null;
  }

  put(accountId: string, key: string, value: unknown, expiresAt: number): void {
    this.mutate(() => {
      this.db
        .query(
          "INSERT INTO sharelink_cache VALUES (?,?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
        )
        .run(accountId, key, JSON.stringify(value), expiresAt);
    });
  }

  result(
    appId: string,
    subjectId: string,
    fingerprint: string,
  ): ResultEntry | null {
    const row = this.db
      .query<{ value: string }, [string, string, string]>(
        "SELECT value FROM sharelink_results WHERE app_id=? AND subject_id=? AND fingerprint=?",
      )
      .get(appId, subjectId, fingerprint);
    return row ? resultEntrySchema.parse(JSON.parse(row.value)) : null;
  }

  saveResult(appId: string, entry: ResultEntry, fingerprint: string): void {
    this.mutate(() => {
      this.db
        .query(
          "INSERT INTO sharelink_results VALUES (?,?,?,?) ON CONFLICT(app_id,subject_id) DO UPDATE SET fingerprint=excluded.fingerprint,value=excluded.value",
        )
        .run(appId, entry.subjectId, fingerprint, JSON.stringify(entry));
    });
  }

  prune(): void {
    this.mutate(() => {
      this.db
        .query("DELETE FROM sharelink_cache WHERE expires_at<=?")
        .run(Date.now());
      this.db
        .query("DELETE FROM sharelink_budget WHERE day_end<=?")
        .run(Date.now() - 7 * 86400000);
      this.db.exec(
        "DELETE FROM sharelink_results WHERE app_id NOT IN (SELECT id FROM sharelink_apps)",
      );
    });
  }

  close(): void {
    this.db.close();
  }
}
