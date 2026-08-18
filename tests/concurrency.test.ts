import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAccount,
  findInvariantViolations,
  getBalance,
  issue,
  makeApp,
  transfer,
  type App,
} from "./helpers.js";

async function account(app: App, name: string): Promise<string> {
  const res = await createAccount(app, name);
  expect(res.statusCode).toBe(201);
  return res.body.id;
}

describe("concurrency", () => {
  it("never lets an account transfer out more shares than it holds", async () => {
    const app = makeApp(1_000_000);
    const alice = await account(app, "alice");
    const bob = await account(app, "bob");

    await issue(app, alice, 100);

    // 40 clients each try to move 10 shares out of a 100-share account at the
    // same instant. Exactly 10 of them can legitimately succeed.
    const attempts = Array.from({ length: 40 }, () =>
      transfer(app, alice, bob, 10),
    );
    const results = await Promise.all(attempts);

    const accepted = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter((r) => r.statusCode === 409).length;

    expect(accepted)?.toBe(10);
    expect(rejected)?.toBe(30);
    expect((await getBalance(app, alice)).body.balance).toBe(0);
    expect((await getBalance(app, bob)).body.balance).toBe(100);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it("never issues more shares than the board authorized", async () => {
    const app = makeApp(1_000);
    const alice = await account(app, "alice");

    // 20 concurrent issues of 100 shares against a 1,000 share ceiling.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => issue(app, alice, 100)),
    );

    expect(results.filter((r) => r.statusCode === 201).length).toBe(10);
    expect(results.filter((r) => r.statusCode === 409).length).toBe(10);
    expect((await getBalance(app, alice)).body.balance).toBe(1_000);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it("assigns each account a unique, gap-free sequence number", async () => {
    const app = makeApp(1_000_000);
    const alice = await account(app, "alice");

    await Promise.all(Array.from({ length: 30 }, () => issue(app, alice, 1)));

    const entries = await app.store.listEntries(alice);
    const seqs = entries.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("keeps the balance projection in agreement with the ledger under mixed load", async () => {
    const app = makeApp(1_000_000);
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => account(app, `holder-${i}`)),
    );

    for (const id of ids) await issue(app, id, 1_000);

    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const from = ids[i % ids.length]!;
      const to = ids[(i + 1) % ids.length]!;
      operations.push(transfer(app, from, to, 25));
      if (i % 5 === 0) operations.push(issue(app, from, 10));
    }
    await Promise.all(operations);

    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it("conserves total shares across concurrent transfers in both directions", async () => {
    const app = makeApp(1_000_000);
    const alice = await account(app, "alice");
    const bob = await account(app, "bob");

    await issue(app, alice, 5_000);
    await issue(app, bob, 5_000);

    // Symmetric cross-traffic: A->B and B->A hammering each other at once.
    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      operations.push(transfer(app, alice, bob, 20));
      operations.push(transfer(app, bob, alice, 20));
    }
    await Promise.all(operations);

    const total =
      (await getBalance(app, alice)).body.balance +
      (await getBalance(app, bob)).body.balance;
    expect(total).toBe(10_000);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it("does not lose a transfer leg when the same pair is hit concurrently", async () => {
    const app = makeApp(1_000_000);
    const alice = await account(app, "alice");
    const bob = await account(app, "bob");
    await issue(app, alice, 2_000);

    const keys = Array.from({ length: 25 }, () => randomUUID());
    await Promise.all(keys.map((key) => transfer(app, alice, bob, 4, key)));

    const entries = await app.store.listAllEntries();
    for (const key of keys) {
      const legs = entries.filter((e) => e.idempotencyKey === key);
      if (legs.length === 0) continue; // rejected outright is fine
      expect(legs.filter((e) => e.type === "TRANSFER_OUT")).toHaveLength(1);
      expect(legs.filter((e) => e.type === "TRANSFER_IN")).toHaveLength(1);
    }
    expect(await findInvariantViolations(app)).toEqual([]);
  });
});
