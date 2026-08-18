import { randomUUID } from 'node:crypto';
import { Mutex } from './mutex.js';
import type { Store } from './store.js';
import {
  AppError,
  type Account,
  type CompanySummary,
  type IssueCommand,
  type IssueResult,
  type LedgerEntry,
  type TransferCommand,
  type TransferResult,
} from './types.js';

function assertValidShares(shares: unknown): void {
  if (typeof shares !== 'number' || !Number.isInteger(shares) || shares <= 0) {
    throw new AppError(400, 'INVALID_SHARES', 'shares must be a positive whole number');
  }
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
  private readonly mutex = new Mutex();

  constructor(private readonly store: Store) {}

  async createAccount(holderName: string): Promise<Account> {
    const account: Account = {
      id: randomUUID(),
      holderName,
      createdAt: Date.now(),
    };
    await this.store.putAccount(account);
    return account;
  }

  /** Issues new shares out of treasury into an account. */
  async issueShares(cmd: IssueCommand): Promise<IssueResult> {
    if (!cmd.idempotencyKey) {
      throw new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
    }
    assertValidShares(cmd.shares);

    const previous = await this.store.getIdempotency(cmd.idempotencyKey);
    if (previous) return previous as IssueResult;

    const account = await this.store.getAccount(cmd.accountId);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `no such account: ${cmd.accountId}`);
    }

    const company = await this.store.getCompanyState();
    if (company.value.issuedShares + cmd.shares > company.value.authorizedShares) {
      throw new AppError(
        409,
        'AUTHORIZED_SHARES_EXCEEDED',
        `cannot issue ${cmd.shares}: only ${
          company.value.authorizedShares - company.value.issuedShares
        } shares remain authorized`,
      );
    }

    const balance = await this.store.getBalance(cmd.accountId);

    const entry = await this.mutex.run(async () => {
      const existing = await this.store.listEntries(cmd.accountId);
      const record: LedgerEntry = {
        id: randomUUID(),
        seq: existing.length + 1,
        accountId: cmd.accountId,
        type: 'ISSUE',
        shares: cmd.shares,
        idempotencyKey: cmd.idempotencyKey,
        createdAt: Date.now(),
      };
      await this.store.appendEntry(record);
      await this.store.putBalance(cmd.accountId, balance.value + cmd.shares);
      return record;
    });

    await this.store.putCompanyState({
      authorizedShares: company.value.authorizedShares,
      issuedShares: company.value.issuedShares + cmd.shares,
    });

    const result: IssueResult = {
      entryId: entry.id,
      accountId: cmd.accountId,
      shares: cmd.shares,
      balance: balance.value + cmd.shares,
    };
    await this.store.putIdempotency(cmd.idempotencyKey, result);
    return result;
  }

  /** Moves shares between two accounts. */
  async transferShares(cmd: TransferCommand): Promise<TransferResult> {
    if (!cmd.idempotencyKey) {
      throw new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
    }
    assertValidShares(cmd.shares);
    if (cmd.fromAccountId === cmd.toAccountId) {
      throw new AppError(400, 'SELF_TRANSFER', 'cannot transfer shares to the same account');
    }

    const previous = await this.store.getIdempotency(cmd.idempotencyKey);
    if (previous) return previous as TransferResult;

    const from = await this.store.getAccount(cmd.fromAccountId);
    if (!from) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `no such account: ${cmd.fromAccountId}`);
    }
    const to = await this.store.getAccount(cmd.toAccountId);
    if (!to) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `no such account: ${cmd.toAccountId}`);
    }

    const fromBalance = await this.store.getBalance(cmd.fromAccountId);
    if (fromBalance.value < cmd.shares) {
      throw new AppError(
        409,
        'INSUFFICIENT_SHARES',
        `account ${cmd.fromAccountId} holds ${fromBalance.value}, cannot transfer ${cmd.shares}`,
      );
    }
    const toBalance = await this.store.getBalance(cmd.toAccountId);

    const fromEntries = await this.store.listEntries(cmd.fromAccountId);
    const outEntry: LedgerEntry = {
      id: randomUUID(),
      seq: fromEntries.length + 1,
      accountId: cmd.fromAccountId,
      type: 'TRANSFER_OUT',
      shares: cmd.shares,
      counterpartyId: cmd.toAccountId,
      idempotencyKey: cmd.idempotencyKey,
      createdAt: Date.now(),
    };
    await this.store.appendEntry(outEntry);
    await this.store.putBalance(cmd.fromAccountId, fromBalance.value - cmd.shares);

    const toEntries = await this.store.listEntries(cmd.toAccountId);
    const inEntry: LedgerEntry = {
      id: randomUUID(),
      seq: toEntries.length + 1,
      accountId: cmd.toAccountId,
      type: 'TRANSFER_IN',
      shares: cmd.shares,
      counterpartyId: cmd.fromAccountId,
      idempotencyKey: cmd.idempotencyKey,
      createdAt: Date.now(),
    };
    await this.store.appendEntry(inEntry);
    await this.store.putBalance(cmd.toAccountId, toBalance.value + cmd.shares);

    const result: TransferResult = {
      fromEntryId: outEntry.id,
      toEntryId: inEntry.id,
      fromBalance: fromBalance.value - cmd.shares,
      toBalance: toBalance.value + cmd.shares,
      shares: cmd.shares,
    };
    await this.store.putIdempotency(cmd.idempotencyKey, result);
    return result;
  }

  // --- read paths ---------------------------------------------------------

  async getBalance(accountId: string): Promise<number> {
    const account = await this.store.getAccount(accountId);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `no such account: ${accountId}`);
    }
    const balance = await this.store.getBalance(accountId);
    return balance.value;
  }

  async getLedger(accountId: string, limit = 50): Promise<LedgerEntry[]> {
    const entries = await this.store.listEntries(accountId);
    return entries.sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  async getCompanySummary(): Promise<CompanySummary> {
    const accounts = await this.store.listAccounts();

    let issuedShares = 0;
    for (const account of accounts) {
      const entries = await this.store.listEntries(account.id);
      for (const entry of entries) {
        if (entry.type === 'ISSUE') issuedShares += entry.shares;
      }
    }

    const company = await this.store.getCompanyState();
    return {
      authorizedShares: company.value.authorizedShares,
      issuedShares,
      remainingAuthorized: company.value.authorizedShares - issuedShares,
      accountCount: accounts.length,
    };
  }
}
