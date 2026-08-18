export interface Account {
  id: string;
  holderName: string;
  createdAt: number;
}

export type EntryType = 'ISSUE' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'CANCEL';

/**
 * A single immutable ledger entry. Entries are append-only: once written they are
 * never updated or deleted. An account's share balance is, by definition, the sum
 * of the signed amounts of its entries.
 */
export interface LedgerEntry {
  id: string;
  /** Per-account sequence number. Starts at 1, strictly increasing, no gaps, no duplicates. */
  seq: number;
  accountId: string;
  type: EntryType;
  /** Always a positive whole number of shares. The sign is implied by `type`. */
  shares: number;
  counterpartyId?: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface CompanyState {
  /** Board-authorized ceiling. Total issued shares must never exceed this. */
  authorizedShares: number;
  /** Total shares issued out of treasury so far. */
  issuedShares: number;
}

export interface IssueCommand {
  accountId: string;
  shares: number;
  idempotencyKey: string;
}

export interface TransferCommand {
  fromAccountId: string;
  toAccountId: string;
  shares: number;
  idempotencyKey: string;
}

export interface IssueResult {
  entryId: string;
  accountId: string;
  shares: number;
  balance: number;
}

export interface TransferResult {
  fromEntryId: string;
  toEntryId: string;
  fromBalance: number;
  toBalance: number;
  shares: number;
}

export interface CompanySummary {
  authorizedShares: number;
  issuedShares: number;
  remainingAuthorized: number;
  accountCount: number;
}

export function signedAmount(entry: LedgerEntry): number {
  switch (entry.type) {
    case 'ISSUE':
    case 'TRANSFER_IN':
      return entry.shares;
    case 'TRANSFER_OUT':
    case 'CANCEL':
      return -entry.shares;
  }
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
