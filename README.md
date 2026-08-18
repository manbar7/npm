# Equity Ledger — take-home exercise

**Time budget: 60 minutes from the timestamp on the email that delivered this repo.**

Send back what you have at the 60-minute mark, finished or not. An honest partial
submission with clear reasoning scores better than a rushed complete one. We are
far more interested in *what you noticed and how you decided* than in a green
test suite.

---

## The system

This service is the share register for a private company. It is the system of
record for who owns how much of the company, so it is append-only: every change
is a `LedgerEntry`, and entries are never updated or deleted. An account's
balance is *by definition* the sum of its entries.

```
POST /accounts                    { holderName }
POST /ledger/issue                { accountId, shares, idempotencyKey }
POST /ledger/transfer             { fromAccountId, toAccountId, shares, idempotencyKey }
GET  /accounts/:id/balance
GET  /accounts/:id/ledger?limit=
GET  /company/summary
```

`issue` mints new shares out of treasury. `transfer` moves existing shares
between two shareholders. Every write carries a client-supplied
`idempotencyKey`, because our callers retry aggressively.

### Invariants

These are the rules the business cares about. They must hold at all times, under
any amount of concurrency.

| | Invariant |
|---|---|
| **I1** | An account's balance always equals the sum of its ledger entries. |
| **I2** | No account balance is ever negative. |
| **I3** | Total issued shares never exceed the company's authorized shares. |
| **I4** | Per-account `seq` values are unique and gap-free, starting at 1. |
| **I5** | A given `idempotencyKey` is applied at most once. |
| **I6** | A transfer is atomic: both legs are applied, or neither is. |

### Service level objectives

Peak traffic is a read-heavy mix with ~80 requests in flight. Two SLOs apply,
and they are hard requirements, not aspirations:

- **SLO-1** — the load run in `tests/load.test.ts` completes within its wall-clock budget.
- **SLO-2** — 99% of read requests complete within their latency budget.

Correctness is not negotiable under load either. Being fast and wrong is worse
than being slow and right.

### A stretch goal, if you have time left

SLO-2's 100ms budget has headroom to spare once the read path is fixed. If you
finish everything else, see how much further you can push balance-read
latency. This is optional — it does not gate a strong score, and a clean
submission without it scores fully on its own merits.

### The datastore

`src/store.ts` stands in for a remote key-value store. Every method is a network
round trip, which is why each one has a simulated latency. **Do not remove or
reduce those delays** — they are what makes this code behave the way it does in
production, and we check.

The store has real constraints you must design around:

- **No multi-key transactions.** Each method commits on its own. There is no
  `BEGIN`/`COMMIT`, no row locks, no `SELECT ... FOR UPDATE`.
- The only atomic primitives are the single-key compare-and-set methods
  (`casBalance`, `casCompanyState`) and `claimIdempotency` (insert-if-absent).

You *may* add methods to `Store` — it is a key-value store, and any single-key
read or write is cheap. You may not give it cross-key atomicity that the real
store does not have.

---

## Your task

```bash
npm install
npm test
```

Tests are failing. Some of them describe bugs; one of them describes a
requirement the current design cannot meet.

1. **Make the suite pass.** Fix the defects behind the failing tests.
2. **Meet both SLOs** without breaking any invariant.
3. **Fill in `SOLUTION.md`.** This is not optional paperwork — it is the part we
   read first, and it is what we will talk about in the follow-up.

### Ground rules

- You may restructure `src/` however you see fit — add files, split modules,
  change the internal design. Keep the HTTP contract as it is.
- **Do not modify anything under `tests/`, or `vitest.config.ts`.** They encode
  the requirements. Editing them to go green is an automatic no. If you think a
  test is wrong, say so in `SOLUTION.md` and leave it failing.
- Do not remove the simulated store latency.
- Adding your *own* tests, in new files under `tests/`, is welcome.

### On AI tools

**Use them.** Copilot, Claude Code, Cursor, whatever you normally work with — we
use these tools every day and we would rather see how you work with them than
watch you type with one hand tied behind your back.

Two things we ask:

- Keep a rough record of the prompts that did the heavy lifting and paste it into
  `SOLUTION.md`. We are genuinely curious, and "how they drive the tool" is
  signal we want, not something we penalize.
- Be ready to defend every line. In the follow-up conversation we will pick a
  change and ask why it is correct, what breaks without it, and what you
  considered instead. Code you cannot explain counts against you more than code
  you did not write.

### If you run out of time

You almost certainly will not finish everything. That is deliberate: we want to
see what you go after first. Leave the rest as notes in `SOLUTION.md` — "here is
what I would do next and why" is worth real credit.

---

## Handy commands

```bash
npm test              # everything
npm run test:load     # just the load test
npm run typecheck     # tsc --noEmit
npm start             # run the server on :3000
npm run loadgen       # optional: hammer a running server over real HTTP
```
