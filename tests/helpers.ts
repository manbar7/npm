import { randomUUID } from "node:crypto";
import { buildApp, type App } from "../src/server.js";
import { signedAmount, type LedgerEntry } from "../src/types.js";

export type { App };

export function makeApp(authorizedShares = 10_000_000): App {
  return buildApp({ authorizedShares });
}

export interface Response<T = any> {
  statusCode: number;
  body: T;
}

async function call<T>(
  app: App,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
): Promise<Response<T>> {
  const res = await app.server.inject({ method, url, payload: payload as any });
  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { statusCode: res.statusCode, body };
}

export const createAccount = (app: App, holderName = "holder") =>
  call<{ id: string }>(app, "POST", "/accounts", { holderName });

export const issue = (
  app: App,
  accountId: string,
  shares: number,
  idempotencyKey: string = randomUUID(),
) =>
  call<{ entryId: string; balance: number }>(app, "POST", "/ledger/issue", {
    accountId,
    shares,
    idempotencyKey,
  });

export const transfer = (
  app: App,
  fromAccountId: string,
  toAccountId: string,
  shares: number,
  idempotencyKey: string = randomUUID(),
) =>
  call<{ fromEntryId: string; toEntryId: string }>(
    app,
    "POST",
    "/ledger/transfer",
    {
      fromAccountId,
      toAccountId,
      shares,
      idempotencyKey,
    },
  );

export const getBalance = (app: App, accountId: string) =>
  call<{ balance: number }>(app, "GET", `/accounts/${accountId}/balance`);

export const getLedger = (app: App, accountId: string, limit = 50) =>
  call<{ entries: LedgerEntry[] }>(
    app,
    "GET",
    `/accounts/${accountId}/ledger?limit=${limit}`,
  );

export const getCompanySummary = (app: App) =>
  call<{ issuedShares: number; remainingAuthorized: number }>(
    app,
    "GET",
    "/company/summary",
  );

/** Creates `count` accounts, each pre-loaded with `sharesEach`, writing straight
 *  to the store. Used by the load test so setup cannot itself introduce races. */
export async function seedAccounts(
  app: App,
  count: number,
  sharesEach: number,
): Promise<string[]> {
  const ids: string[] = [];
  const work: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    work.push(
      (async () => {
        await app.store.putAccount({
          id,
          holderName: `holder-${i}`,
          createdAt: Date.now(),
        });
        await app.store.appendEntry({
          id: randomUUID(),
          seq: 1,
          accountId: id,
          type: "ISSUE",
          shares: sharesEach,
          idempotencyKey: `seed-${id}`,
          createdAt: Date.now(),
        });
        await app.store.putBalance(id, sharesEach);
        await app.store.putIdempotency(`seed-${id}`, {
          entryId: "seed",
          accountId: id,
          shares: sharesEach,
          balance: sharesEach,
        });
      })(),
    );
  }
  await Promise.all(work);
  const company = await app.store.getCompanyState();
  await app.store.putCompanyState({
    authorizedShares: company.value.authorizedShares,
    issuedShares: count * sharesEach,
  });
  return ids;
}

export interface Violation {
  kind: string;
  detail: string;
}

/**
 * Re-derives the truth from the append-only ledger and checks it against every
 * invariant in the README. This is the ground-truth oracle: if it returns a
 * non-empty array, the system is corrupt.
 */
export async function findInvariantViolations(app: App): Promise<Violation[]> {
  const violations: Violation[] = [];
  const entries = await app.store.listAllEntries();
  const accounts = await app.store.listAccounts();

  const byAccount = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const list = byAccount.get(entry.accountId) ?? [];
    list.push(entry);
    byAccount.set(entry.accountId, list);
  }

  // I1 / I2: projection matches the ledger, and no balance is negative.
  for (const account of accounts) {
    const accountEntries = byAccount.get(account.id) ?? [];
    const derived = accountEntries.reduce((sum, e) => sum + signedAmount(e), 0);
    const projected = await app.store.getBalance(account.id);

    if (derived !== projected.value) {
      violations.push({
        kind: "I1_PROJECTION_DIVERGED",
        detail: `account ${account.id}: ledger says ${derived}, balance projection says ${projected.value}`,
      });
    }
    if (derived < 0) {
      violations.push({
        kind: "I2_NEGATIVE_BALANCE",
        detail: `account ${account.id}: derived balance is ${derived}`,
      });
    }

    // I4: seq values are 1..n, unique, no gaps.
    const seqs = accountEntries.map((e) => e.seq).sort((a, b) => a - b);
    const expected = seqs.map((_, i) => i + 1);
    if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
      violations.push({
        kind: "I4_BAD_SEQUENCE",
        detail: `account ${account.id}: seq values ${JSON.stringify(seqs)}`,
      });
    }
  }

  // I3: issued never exceeds authorized, and the treasury counter is accurate.
  const company = await app.store.getCompanyState();
  const totalIssued = entries
    .filter((e) => e.type === "ISSUE")
    .reduce((sum, e) => sum + e.shares, 0);
  if (totalIssued > company.value.authorizedShares) {
    violations.push({
      kind: "I3_OVER_AUTHORIZED",
      detail: `issued ${totalIssued} shares against an authorized ceiling of ${company.value.authorizedShares}`,
    });
  }
  if (totalIssued !== company.value.issuedShares) {
    violations.push({
      kind: "I3_TREASURY_DRIFT",
      detail: `ledger shows ${totalIssued} issued, treasury counter says ${company.value.issuedShares}`,
    });
  }

  // I5 / I6: each idempotency key is applied once — an issue writes exactly one
  // entry, a transfer writes exactly one matched pair of legs.
  const byKey = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const list = byKey.get(entry.idempotencyKey) ?? [];
    list.push(entry);
    byKey.set(entry.idempotencyKey, list);
  }
  for (const [key, group] of byKey) {
    const issues = group.filter((e) => e.type === "ISSUE");
    const outs = group.filter((e) => e.type === "TRANSFER_OUT");
    const ins = group.filter((e) => e.type === "TRANSFER_IN");

    if (issues.length > 1) {
      violations.push({
        kind: "I5_DUPLICATE_APPLY",
        detail: `idempotencyKey ${key} produced ${issues.length} ISSUE entries`,
      });
    }
    if (outs.length !== ins.length) {
      violations.push({
        kind: "I6_UNBALANCED_TRANSFER",
        detail: `idempotencyKey ${key}: ${outs.length} out-legs vs ${ins.length} in-legs`,
      });
    }
    if (outs.length > 1) {
      violations.push({
        kind: "I5_DUPLICATE_APPLY",
        detail: `idempotencyKey ${key} produced ${outs.length} transfers`,
      });
    }
  }

  return violations;
}

/** Runs `tasks` with at most `concurrency` in flight at once. */
export async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= tasks.length) return;
        results[index] = await tasks[index]!();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Deterministic PRNG so every run of the load test sees the same workload. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)]!;
}
