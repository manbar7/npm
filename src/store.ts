import type { Account, CompanyState, LedgerEntry } from "./types.js";

/**
 * Simulated latency of the backing datastore. Every method below is a *network
 * round trip* to a remote store — treat it as such. Do not remove these delays:
 * they are what makes this store behave like the real one in production.
 */
const READ_LATENCY_MS = 2;
const WRITE_LATENCY_MS = 3;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Versioned<T> {
  value: T;
  version: number;
}

/**
 * The datastore.
 *
 * Constraints of the real store this class stands in for — these are not
 * negotiable and you should not change them:
 *
 *   - There are NO multi-key transactions. Each method commits on its own.
 *   - There is no `BEGIN`/`COMMIT`, no row locks, no `SELECT ... FOR UPDATE`.
 *   - The only atomic primitives available are the single-key
 *     compare-and-set methods (`casBalance`, `casCompanyState`), which commit
 *     only if the record's version is unchanged.
 *
 * You may ADD methods to this class (e.g. new projections/indexes) — the real
 * store is a key-value store and any single-key read or write is cheap. You may
 * not add cross-key atomicity that the real store does not have.
 */
export class Store {
  private accounts = new Map<string, Account>();
  private entries: LedgerEntry[] = [];
  private entriesByAccount = new Map<string, LedgerEntry[]>();
  private balances = new Map<string, Versioned<number>>();
  private companyState: Versioned<CompanyState> = {
    value: { authorizedShares: 0, issuedShares: 0 },
    version: 0,
  };
  private idempotency = new Map<string, unknown>();

  /** Instrumentation, for your own use. Not asserted on by any test. */
  readonly stats = { reads: 0, writes: 0 };

  private async read<T>(value: T): Promise<T> {
    this.stats.reads++;
    await sleep(READ_LATENCY_MS);
    return value;
  }

  private async write(fn: () => void): Promise<void> {
    this.stats.writes++;
    await sleep(WRITE_LATENCY_MS);
    fn();
  }

  // --- accounts -----------------------------------------------------------

  async getAccount(id: string): Promise<Account | undefined> {
    return this.read(this.accounts.get(id));
  }

  async putAccount(account: Account): Promise<void> {
    await this.write(() => {
      this.accounts.set(account.id, account);
    });
  }

  async listAccounts(): Promise<Account[]> {
    return this.read([...this.accounts.values()]);
  }

  async countAccounts(): Promise<number> {
    return this.read(this.accounts.size);
  }

  // --- ledger entries -----------------------------------------------------

  async appendEntry(entry: LedgerEntry): Promise<void> {
    await this.write(() => {
      this.entries.push(entry);
      const accountEntries = this.entriesByAccount.get(entry.accountId) ?? [];
      accountEntries.push(entry);
      this.entriesByAccount.set(entry.accountId, accountEntries);
    });
  }

  /** Scans the log. Cost grows with the total number of entries in the system. */
  async listEntries(accountId: string): Promise<LedgerEntry[]> {
    return this.read([...(this.entriesByAccount.get(accountId) ?? [])]);
  }

  /** Full log scan. Used by tests to verify invariants. Never call this on a request path. */
  async listAllEntries(): Promise<LedgerEntry[]> {
    return this.read([...this.entries]);
  }

  // --- balance projection -------------------------------------------------

  async getBalance(accountId: string): Promise<Versioned<number>> {
    return this.read(this.balances.get(accountId) ?? { value: 0, version: 0 });
  }

  async putBalance(accountId: string, value: number): Promise<void> {
    await this.write(() => {
      const current = this.balances.get(accountId);
      this.balances.set(accountId, {
        value,
        version: (current?.version ?? 0) + 1,
      });
    });
  }

  /**
   * Atomic compare-and-set. Writes `value` only if the stored version still
   * equals `expectedVersion`. Returns false if another writer got there first.
   */
  async casBalance(
    accountId: string,
    expectedVersion: number,
    value: number,
  ): Promise<boolean> {
    let ok = false;
    await this.write(() => {
      const current = this.balances.get(accountId) ?? { value: 0, version: 0 };
      if (current.version !== expectedVersion) return;
      this.balances.set(accountId, { value, version: current.version + 1 });
      ok = true;
    });
    return ok;
  }

  // --- company / treasury state ------------------------------------------

  async getCompanyState(): Promise<Versioned<CompanyState>> {
    return this.read({
      value: { ...this.companyState.value },
      version: this.companyState.version,
    });
  }

  async putCompanyState(value: CompanyState): Promise<void> {
    await this.write(() => {
      this.companyState = {
        value: { ...value },
        version: this.companyState.version + 1,
      };
    });
  }

  /** Atomic compare-and-set on the company record. */
  async casCompanyState(
    expectedVersion: number,
    value: CompanyState,
  ): Promise<boolean> {
    let ok = false;
    await this.write(() => {
      if (this.companyState.version !== expectedVersion) return;
      this.companyState = {
        value: { ...value },
        version: this.companyState.version + 1,
      };
      ok = true;
    });
    return ok;
  }

  // --- idempotency --------------------------------------------------------

  async getIdempotency(key: string): Promise<unknown | undefined> {
    return this.read(this.idempotency.get(key));
  }

  async putIdempotency(key: string, result: unknown): Promise<void> {
    await this.write(() => {
      this.idempotency.set(key, result);
    });
  }

  async deleteIdempotency(key: string): Promise<void> {
    await this.write(() => {
      this.idempotency.delete(key);
    });
  }

  /**
   * Atomic "insert if absent". Returns true if this caller claimed the key,
   * false if it was already present.
   */
  async claimIdempotency(key: string, result: unknown): Promise<boolean> {
    let ok = false;
    await this.write(() => {
      const existing = this.idempotency.get(key) as
        | { result?: unknown; leaseUntil?: number }
        | undefined;
      const expiredPending =
        existing &&
        existing.result === undefined &&
        (existing.leaseUntil ?? 0) <= Date.now();
      if (existing && !expiredPending) return;
      this.idempotency.set(key, result);
      ok = true;
    });
    return ok;
  }

  // --- test/bootstrap helpers --------------------------------------------

  /** Synchronous bootstrap. Only used at startup and by tests. */
  seedCompany(authorizedShares: number): void {
    this.companyState = {
      value: { authorizedShares, issuedShares: 0 },
      version: 0,
    };
  }
}
