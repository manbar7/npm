import { randomUUID } from "node:crypto";
import { KeyedMutex } from "./mutex.js";
import type { Store } from "./store.js";
import {
  AppError,
  type Account,
  type CompanySummary,
  type IssueCommand,
  type IssueResult,
  type LedgerEntry,
  type TransferCommand,
  type TransferResult,
} from "./types.js";

function assertValidShares(shares: unknown): void {
  if (typeof shares !== "number" || !Number.isInteger(shares) || shares <= 0) {
    throw new AppError(
      400,
      "INVALID_SHARES",
      "shares must be a positive whole number",
    );
  }
}

interface AccountSnapshot {
  balance: number;
  entries: LedgerEntry[];
  version: number;
}

interface IdempotencyRecord {
  fingerprint: string;
  result?: unknown;
  leaseUntil?: number;
}

function issueFingerprint(cmd: IssueCommand): string {
  return JSON.stringify({
    type: "ISSUE",
    accountId: cmd.accountId,
    shares: cmd.shares,
  });
}

function transferFingerprint(cmd: TransferCommand): string {
  return JSON.stringify({
    type: "TRANSFER",
    fromAccountId: cmd.fromAccountId,
    toAccountId: cmd.toAccountId,
    shares: cmd.shares,
  });
}

/**
 * Core domain service for the equity ledger.
 *
 * Invariants this service is supposed to uphold (see README):
 *   I1  An account's balance always equals the sum of its ledger entries.
 *   I2  No account balance is ever negative.
 *   I3  Total issued shares never exceed the company's authorized shares.
 *   I4  Per-account `seq` values are unique and gap-free, starting at 1.
 *   I5  A given idempotencyKey is applied at most once.
 *   I6  A transfer moves shares atomically: the outgoing and incoming legs are
 *       both applied, or neither is.
 */
export class LedgerService {
  // Serializes per accountId, and separately on this fixed key for the
  // company-wide authorized-shares ceiling, which every issue contends on.
  private readonly locks = new KeyedMutex();
  private readonly accountSnapshots = new Map<string, AccountSnapshot>();
  private readonly accounts = new Map<string, Account>();
  private readonly completedIdempotency = new Map<string, IdempotencyRecord>();
  private readonly accountVersions = new Map<string, number>();
  private static readonly COMPANY_LOCK = "__company__";
  private static readonly IDEMPOTENCY_LEASE_MS = 30_000;

  constructor(private readonly store: Store) {}

  private async putBalanceWithRetry(
    accountId: string,
    value: number,
    attempts = 3,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.store.putBalance(accountId, value);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async getWriteSnapshot(accountId: string): Promise<AccountSnapshot> {
    const cached = this.accountSnapshots.get(accountId);
    if (cached) {
      return {
        balance: cached.balance,
        entries: [...cached.entries],
        version: cached.version,
      };
    }

    const [balance, entries] = await Promise.all([
      this.store.getBalance(accountId),
      this.store.listEntries(accountId),
    ]);
    return {
      balance: balance.value,
      entries: [...entries],
      version: this.accountVersions.get(accountId) ?? 0,
    };
  }

  private async runIdempotent<T>(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.locks.run(`__idempotency__:${key}`, async () => {
      const cached = this.completedIdempotency.get(key);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new AppError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "idempotencyKey was already used for a different operation",
          );
        }
        return cached.result as T;
      }

      const claimed = await this.store.claimIdempotency(key, {
        fingerprint,
        leaseUntil: Date.now() + LedgerService.IDEMPOTENCY_LEASE_MS,
      } satisfies IdempotencyRecord);
      if (!claimed) {
        const previous = (await this.store.getIdempotency(key)) as
          | IdempotencyRecord
          | undefined;
        if (!previous || previous.fingerprint !== fingerprint) {
          throw new AppError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "idempotencyKey was already used for a different operation",
          );
        }
        if (previous.result === undefined) {
          throw new AppError(
            409,
            "IDEMPOTENCY_OPERATION_IN_PROGRESS",
            "idempotencyKey is already being processed",
          );
        }
        this.completedIdempotency.set(key, previous);
        return previous.result as T;
      }

      try {
        const result = await operation();
        await this.store.putIdempotency(key, { fingerprint, result });
        this.completedIdempotency.set(key, { fingerprint, result });
        return result;
      } catch (error) {
        this.completedIdempotency.delete(key);
        await this.store.deleteIdempotency(key);
        throw error;
      }
    });
  }

  async createAccount(holderName: string): Promise<Account> {
    const account: Account = {
      id: randomUUID(),
      holderName,
      createdAt: Date.now(),
    };
    await this.store.putAccount(account);
    this.accounts.set(account.id, account);
    return account;
  }

  private async getAccount(accountId: string): Promise<Account> {
    const cached = this.accounts.get(accountId);
    if (cached) return cached;

    const account = await this.store.getAccount(accountId);
    if (!account) {
      throw new AppError(
        404,
        "ACCOUNT_NOT_FOUND",
        `no such account: ${accountId}`,
      );
    }
    this.accounts.set(accountId, account);
    return account;
  }

  /** Issues new shares out of treasury into an account. */
  async issueShares(cmd: IssueCommand): Promise<IssueResult> {
    if (!cmd.idempotencyKey) {
      throw new AppError(
        400,
        "MISSING_IDEMPOTENCY_KEY",
        "idempotencyKey is required",
      );
    }
    assertValidShares(cmd.shares);

    return this.runIdempotent(cmd.idempotencyKey, issueFingerprint(cmd), () =>
      // Everything below is check-then-write, so it must all run under this
      // account's lock — otherwise two concurrent issues can both read the
      // same stale balance/seq state before either one writes.
      this.getAccount(cmd.accountId).then(() =>
        this.locks.run(cmd.accountId, async () => {
          // The authorized-shares ceiling is shared across every account, so its
          // check-then-write needs its own lock, separate from the per-account one.
          await this.locks.run(LedgerService.COMPANY_LOCK, async () => {
            const company = await this.store.getCompanyState();
            if (
              company.value.issuedShares + cmd.shares >
              company.value.authorizedShares
            ) {
              throw new AppError(
                409,
                "AUTHORIZED_SHARES_EXCEEDED",
                `cannot issue ${cmd.shares}: only ${
                  company.value.authorizedShares - company.value.issuedShares
                } shares remain authorized`,
              );
            }
            await this.store.putCompanyState({
              authorizedShares: company.value.authorizedShares,
              issuedShares: company.value.issuedShares + cmd.shares,
            });
          });

          try {
            const snapshot = await this.getWriteSnapshot(cmd.accountId);
            const balance = snapshot.balance;
            const existing = snapshot.entries;
            this.accountSnapshots.set(cmd.accountId, {
              balance,
              entries: [...existing],
              version: snapshot.version,
            });
            const entry: LedgerEntry = {
              id: randomUUID(),
              seq: existing.length + 1,
              accountId: cmd.accountId,
              type: "ISSUE",
              shares: cmd.shares,
              idempotencyKey: cmd.idempotencyKey,
              createdAt: Date.now(),
            };
            await this.store.appendEntry(entry);
            await this.putBalanceWithRetry(cmd.accountId, balance + cmd.shares);

            const result: IssueResult = {
              entryId: entry.id,
              accountId: cmd.accountId,
              shares: cmd.shares,
              balance: balance + cmd.shares,
            };
            this.accountSnapshots.set(cmd.accountId, {
              balance: result.balance,
              entries: [...existing, entry],
              version: (this.accountVersions.get(cmd.accountId) ?? 0) + 1,
            });
            this.accountVersions.set(
              cmd.accountId,
              (this.accountVersions.get(cmd.accountId) ?? 0) + 1,
            );
            return result;
          } catch (error) {
            await this.locks.run(LedgerService.COMPANY_LOCK, async () => {
              const current = await this.store.getCompanyState();
              if (current.value.issuedShares < cmd.shares) {
                throw new Error("company state rollback failed", {
                  cause: error,
                });
              }
              await this.store.putCompanyState({
                authorizedShares: current.value.authorizedShares,
                issuedShares: current.value.issuedShares - cmd.shares,
              });
            });
            throw error;
          }
        }),
      ),
    );
  }

  /** Moves shares between two accounts. */
  async transferShares(cmd: TransferCommand): Promise<TransferResult> {
    if (!cmd.idempotencyKey) {
      throw new AppError(
        400,
        "MISSING_IDEMPOTENCY_KEY",
        "idempotencyKey is required",
      );
    }
    assertValidShares(cmd.shares);
    if (cmd.fromAccountId === cmd.toAccountId) {
      throw new AppError(
        400,
        "SELF_TRANSFER",
        "cannot transfer shares to the same account",
      );
    }

    return this.runIdempotent(
      cmd.idempotencyKey,
      transferFingerprint(cmd),
      () =>
        // Lock both accounts, always in sorted order, so this and its reverse
        // (B->A) can never each hold one account's lock while waiting on the other.
        Promise.all([
          this.getAccount(cmd.fromAccountId),
          this.getAccount(cmd.toAccountId),
        ]).then(() =>
          this.locks.runMany([cmd.fromAccountId, cmd.toAccountId], async () => {
            const [fromSnapshot, toSnapshot] = await Promise.all([
              this.getWriteSnapshot(cmd.fromAccountId),
              this.getWriteSnapshot(cmd.toAccountId),
            ]);
            const fromBalance = { value: fromSnapshot.balance };
            const toBalance = { value: toSnapshot.balance };
            const fromEntries = fromSnapshot.entries;
            const toEntries = toSnapshot.entries;
            if (fromBalance.value < cmd.shares) {
              throw new AppError(
                409,
                "INSUFFICIENT_SHARES",
                `account ${cmd.fromAccountId} holds ${fromBalance.value}, cannot transfer ${cmd.shares}`,
              );
            }
            this.accountSnapshots.set(cmd.fromAccountId, {
              balance: fromBalance.value,
              entries: [...fromEntries],
              version: this.accountVersions.get(cmd.fromAccountId) ?? 0,
            });
            this.accountSnapshots.set(cmd.toAccountId, {
              balance: toBalance.value,
              entries: [...toEntries],
              version: this.accountVersions.get(cmd.toAccountId) ?? 0,
            });
            const outEntry: LedgerEntry = {
              id: randomUUID(),
              seq: fromEntries.length + 1,
              accountId: cmd.fromAccountId,
              type: "TRANSFER_OUT",
              shares: cmd.shares,
              counterpartyId: cmd.toAccountId,
              idempotencyKey: cmd.idempotencyKey,
              createdAt: Date.now(),
            };
            const inEntry: LedgerEntry = {
              id: randomUUID(),
              seq: toEntries.length + 1,
              accountId: cmd.toAccountId,
              type: "TRANSFER_IN",
              shares: cmd.shares,
              counterpartyId: cmd.fromAccountId,
              idempotencyKey: cmd.idempotencyKey,
              createdAt: Date.now(),
            };
            await Promise.all([
              this.store.appendEntry(outEntry),
              this.store.putBalance(
                cmd.fromAccountId,
                fromBalance.value - cmd.shares,
              ),
              this.store.appendEntry(inEntry),
              this.store.putBalance(
                cmd.toAccountId,
                toBalance.value + cmd.shares,
              ),
            ]);

            const result: TransferResult = {
              fromEntryId: outEntry.id,
              toEntryId: inEntry.id,
              fromBalance: fromBalance.value - cmd.shares,
              toBalance: toBalance.value + cmd.shares,
              shares: cmd.shares,
            };
            this.accountSnapshots.set(cmd.fromAccountId, {
              balance: result.fromBalance,
              entries: [...fromEntries, outEntry],
              version: (this.accountVersions.get(cmd.fromAccountId) ?? 0) + 1,
            });
            this.accountSnapshots.set(cmd.toAccountId, {
              balance: result.toBalance,
              entries: [...toEntries, inEntry],
              version: (this.accountVersions.get(cmd.toAccountId) ?? 0) + 1,
            });
            this.accountVersions.set(
              cmd.fromAccountId,
              (this.accountVersions.get(cmd.fromAccountId) ?? 0) + 1,
            );
            this.accountVersions.set(
              cmd.toAccountId,
              (this.accountVersions.get(cmd.toAccountId) ?? 0) + 1,
            );
            return result;
          }),
        ),
    );
  }

  // --- read paths ---------------------------------------------------------

  private async getAccountSnapshot(
    accountId: string,
  ): Promise<AccountSnapshot> {
    const cached = this.accountSnapshots.get(accountId);
    if (cached) {
      return {
        balance: cached.balance,
        entries: [...cached.entries],
        version: cached.version,
      };
    }

    return this.locks.run(accountId, async () => {
      const existing = this.accountSnapshots.get(accountId);
      if (existing) {
        return {
          balance: existing.balance,
          entries: [...existing.entries],
          version: existing.version,
        };
      }

      await this.getAccount(accountId);
      const [balance, entries] = await Promise.all([
        this.store.getBalance(accountId),
        this.store.listEntries(accountId),
      ]);
      const snapshot = {
        balance: balance.value,
        entries: [...entries],
        version: this.accountVersions.get(accountId) ?? 0,
      };
      this.accountSnapshots.set(accountId, snapshot);
      return {
        balance: snapshot.balance,
        entries: [...snapshot.entries],
        version: snapshot.version,
      };
    });
  }

  async getBalance(accountId: string): Promise<number> {
    const cached = this.accountSnapshots.get(accountId);
    if (cached) return cached.balance;

    const snapshot = await this.getAccountSnapshot(accountId);
    return snapshot.balance;
  }

  async getLedger(accountId: string, limit = 50): Promise<LedgerEntry[]> {
    const snapshot = await this.getAccountSnapshot(accountId);
    return snapshot.entries.sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  async getAccountState(accountId: string, limit = 50) {
    const snapshot = await this.getAccountSnapshot(accountId);
    return {
      version: snapshot.version,
      balance: snapshot.balance,
      entries: snapshot.entries.sort((a, b) => b.seq - a.seq).slice(0, limit),
    };
  }

  async getCompanySummary(): Promise<CompanySummary> {
    const [accounts, company] = await Promise.all([
      this.store.listAccounts(),
      this.store.getCompanyState(),
    ]);
    return {
      authorizedShares: company.value.authorizedShares,
      issuedShares: company.value.issuedShares,
      remainingAuthorized:
        company.value.authorizedShares - company.value.issuedShares,
      accountCount: accounts.length,
    };
  }
}
