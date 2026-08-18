import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAccount,
  findInvariantViolations,
  getBalance,
  issue,
  makeApp,
  transfer,
} from './helpers.js';

describe('idempotency', () => {
  it('applies a retried issue exactly once', async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, 'alice')).body.id;
    const key = randomUUID();

    const first = await issue(app, alice, 250, key);
    const second = await issue(app, alice, 250, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((await getBalance(app, alice)).body.balance).toBe(250);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it('applies a concurrently retried issue exactly once', async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, 'alice')).body.id;
    const key = randomUUID();

    // A flaky client (or a retrying load balancer) fires the same request 15x.
    const results = await Promise.all(
      Array.from({ length: 15 }, () => issue(app, alice, 250, key)),
    );

    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect((await getBalance(app, alice)).body.balance).toBe(250);

    const entries = await app.store.listEntries(alice);
    expect(entries.filter((e) => e.idempotencyKey === key)).toHaveLength(1);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it('applies a concurrently retried transfer exactly once', async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, 'alice')).body.id;
    const bob = (await createAccount(app, 'bob')).body.id;
    await issue(app, alice, 1_000);

    const key = randomUUID();
    await Promise.all(Array.from({ length: 15 }, () => transfer(app, alice, bob, 100, key)));

    expect((await getBalance(app, alice)).body.balance).toBe(900);
    expect((await getBalance(app, bob)).body.balance).toBe(100);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it('returns the original result for a replayed key rather than re-running it', async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, 'alice')).body.id;
    const key = randomUUID();

    const first = await issue(app, alice, 100, key);
    const replay = await issue(app, alice, 100, key);

    expect(replay.body.entryId).toBe(first.body.entryId);
  });

  it('requires an idempotency key on every write', async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, 'alice')).body.id;
    expect((await issue(app, alice, 100, '')).statusCode).toBe(400);
  });
});
