import { describe, expect, it } from "vitest";
import {
  createAccount,
  findInvariantViolations,
  getBalance,
  issue,
  makeApp,
} from "./helpers.js";

describe("idempotency key scope", () => {
  it("rejects the same key when concurrent requests describe different accounts", async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, "alice")).body.id;
    const bob = (await createAccount(app, "bob")).body.id;
    const key = "shared-key";

    const results = await Promise.all([
      issue(app, alice, 100, key),
      issue(app, bob, 200, key),
    ]);

    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.statusCode === 409)).toHaveLength(
      1,
    );
    const totalBalance =
      (await getBalance(app, alice)).body.balance +
      (await getBalance(app, bob)).body.balance;
    expect([100, 200]).toContain(totalBalance);
    expect(await findInvariantViolations(app)).toEqual([]);
  });

  it("returns a conflict when a completed key is reused for another operation", async () => {
    const app = makeApp(1_000_000);
    const alice = (await createAccount(app, "alice")).body.id;
    const bob = (await createAccount(app, "bob")).body.id;
    const key = "reused-key";

    expect((await issue(app, alice, 100, key)).statusCode).toBe(201);
    const replay = (await issue(app, bob, 100, key)) as {
      statusCode: number;
      body: { code?: string };
    };

    expect(replay.statusCode).toBe(409);
    expect(replay.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await findInvariantViolations(app)).toEqual([]);
  });
});
