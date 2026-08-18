import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findInvariantViolations,
  makeApp,
  percentile,
  seedAccounts,
  seededRandom,
  withConcurrency,
  type App,
} from './helpers.js';

/**
 * Production-shaped load. The numbers below mirror our peak traffic: a
 * read-heavy mix with a steady stream of writes, ~80 requests in flight.
 *
 * Two service level objectives apply, and both are hard requirements:
 *
 *   SLO-1  The whole run completes within WALL_CLOCK_BUDGET_MS.
 *   SLO-2  99% of read requests complete within READ_P99_BUDGET_MS.
 *
 * ...and correctness is not negotiable under load either: the ledger must still
 * satisfy every invariant when the dust settles.
 *
 * Do not change the constants, the traffic mix, or the assertions in this file.
 */
const ACCOUNTS = 200;
const SHARES_PER_ACCOUNT = 500;
const TOTAL_OPERATIONS = 1_200;
const CONCURRENCY = 80;
const WALL_CLOCK_BUDGET_MS = 3_000;
const READ_P99_BUDGET_MS = 100;

type OpKind = 'balance' | 'ledger' | 'summary' | 'transfer';

interface Op {
  kind: OpKind;
  accountId: string;
  counterpartyId: string;
  shares: number;
  idempotencyKey: string;
}

function buildWorkload(accountIds: string[]): Op[] {
  const random = seededRandom(0xc0ffee);
  const ops: Op[] = [];

  for (let i = 0; i < TOTAL_OPERATIONS; i++) {
    const roll = random();
    const kind: OpKind =
      roll < 0.6 ? 'balance' : roll < 0.75 ? 'ledger' : roll < 0.8 ? 'summary' : 'transfer';

    const fromIndex = Math.floor(random() * accountIds.length);
    let toIndex = Math.floor(random() * accountIds.length);
    if (toIndex === fromIndex) toIndex = (toIndex + 1) % accountIds.length;

    ops.push({
      kind,
      accountId: accountIds[fromIndex]!,
      counterpartyId: accountIds[toIndex]!,
      shares: 1 + Math.floor(random() * 5),
      idempotencyKey: randomUUID(),
    });
  }
  return ops;
}

async function execute(app: App, op: Op) {
  switch (op.kind) {
    case 'balance':
      return app.server.inject({ method: 'GET', url: `/accounts/${op.accountId}/balance` });
    case 'ledger':
      return app.server.inject({ method: 'GET', url: `/accounts/${op.accountId}/ledger?limit=20` });
    case 'summary':
      return app.server.inject({ method: 'GET', url: '/company/summary' });
    case 'transfer':
      return app.server.inject({
        method: 'POST',
        url: '/ledger/transfer',
        payload: {
          fromAccountId: op.accountId,
          toAccountId: op.counterpartyId,
          shares: op.shares,
          idempotencyKey: op.idempotencyKey,
        },
      });
  }
}

describe('load', () => {
  it('sustains peak traffic within budget and without corrupting the ledger', async () => {
    const app = makeApp(10_000_000);
    const accountIds = await seedAccounts(app, ACCOUNTS, SHARES_PER_ACCOUNT);
    const ops = buildWorkload(accountIds);

    const readLatencies: number[] = [];
    const writeLatencies: number[] = [];
    const statusCounts = new Map<number, number>();

    const startedAt = performance.now();
    await withConcurrency(
      ops.map((op) => async () => {
        const t0 = performance.now();
        const res = await execute(app, op);
        const elapsed = performance.now() - t0;
        (op.kind === 'transfer' ? writeLatencies : readLatencies).push(elapsed);
        statusCounts.set(res.statusCode, (statusCounts.get(res.statusCode) ?? 0) + 1);
      }),
      CONCURRENCY,
    );
    const wallClockMs = performance.now() - startedAt;

    const readP99 = percentile(readLatencies, 99);
    const writeP99 = percentile(writeLatencies, 99);
    const serverErrors = [...statusCounts.entries()]
      .filter(([status]) => status >= 500)
      .reduce((sum, [, count]) => sum + count, 0);

    console.log(
      [
        '',
        `  operations      ${ops.length} at concurrency ${CONCURRENCY}`,
        `  wall clock      ${wallClockMs.toFixed(0)} ms   (budget ${WALL_CLOCK_BUDGET_MS} ms)`,
        `  throughput      ${((ops.length / wallClockMs) * 1000).toFixed(0)} ops/sec`,
        `  read  p50/p99   ${percentile(readLatencies, 50).toFixed(1)} / ${readP99.toFixed(1)} ms   (p99 budget ${READ_P99_BUDGET_MS} ms)`,
        `  write p50/p99   ${percentile(writeLatencies, 50).toFixed(1)} / ${writeP99.toFixed(1)} ms`,
        `  statuses        ${JSON.stringify(Object.fromEntries(statusCounts))}`,
        `  store calls     ${app.store.stats.reads} reads / ${app.store.stats.writes} writes`,
        '',
      ].join('\n'),
    );

    expect(serverErrors).toBe(0);

    const violations = await findInvariantViolations(app);
    expect(violations).toEqual([]);

    // SLO-2: reads must stay fast even while writes are in flight.
    expect(readP99).toBeLessThan(READ_P99_BUDGET_MS);

    // SLO-1: the whole run must fit in the budget.
    expect(wallClockMs).toBeLessThan(WALL_CLOCK_BUDGET_MS);
  });
});
