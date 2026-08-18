# Solution notes

## 1. What was broken

- **Transfer projection race:** A transfer appended its outgoing entry and balance before committing the incoming leg, exposing an intermediate state.
- **Read race:** Balance and ledger endpoints read independently while transfers were writing, so their observations could disagree during one request window.
- **Concurrent issue race:** Concurrent issues could read identical balance, sequence, and idempotency state before either request wrote.
- **Transfer sequence race:** Opposite or same-pair transfers could calculate duplicate sequence numbers without shared account serialization.
- **Authorization race:** Concurrent issues could pass the authorized-share check using the same stale company total.
- **Cross-operation key collision:** The same idempotency key could be used by unrelated accounts or operation types without fingerprint validation.
- **Read latency regression:** Locking reads behind multi-write transfers caused read p99 latency to reach multiple seconds.
- **Summary bottleneck:** Company summaries scanned every account ledger, causing unnecessary fan-out under read-heavy load.

## 2. How concurrency safety works

- **Account serialization:** A `KeyedMutex` serializes all writes that affect one account.
- **Transfer locking:** Transfers acquire both account locks in sorted order, preventing deadlocks for reverse-direction transfers.
- **Independent accounts:** Operations touching different accounts do not share account locks, except issues briefly contend on the company lock.
- **Company serialization:** A dedicated company lock serializes the authorized-share check and issued-share projection update.
- **Idempotency:** A global key lock and atomic datastore claim serialize same-key requests before account mutations.
- **Fingerprint validation:** Reusing a completed key for different accounts, amounts, or operation types returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Failed operations:** Failed claims are deleted so clients can retry after normal validation or business-rule failures.
- **Crash recovery:** Pending idempotency claims carry a 30-second lease and expired pending claims can be reclaimed atomically.
- **Issue reservation recovery:** If an issue fails after reserving treasury shares, the reservation is released under the company lock.
- **Projection write recovery:** Balance projection writes are retried because repeating the same value is safe after an append-only ledger write.
- **Read snapshots:** Reads use account snapshots instead of waiting behind transfer writes.
- **Snapshot publication:** Pre-operation snapshots cover cold reads; post-operation snapshots publish only after all operation writes finish.
- **Defensive copies:** Read paths copy entry arrays so callers cannot mutate process-local snapshot state.
- **Write ordering:** Store writes remain sequential because `Promise.all` cannot provide rollback or multi-key atomicity.

## 3. Meeting the SLOs

- **Initial bottleneck:** Balance and ledger reads queued behind account locks held across four simulated store writes.
- **Read fix:** Account snapshots removed transfer-lock waits from the normal read path.
- **Cold-read fix:** Complete pre-operation snapshots are installed before transfer or issue writes begin.
- **Summary fix:** Summaries now use the maintained company projection instead of scanning all account ledgers.
- **Summary parallelism:** Account count and company state are fetched concurrently.
- **Correctness preserved:** Readers see the prior complete snapshot or the next complete snapshot, never a planned partial snapshot.

## 4. What was deliberately not done

- **No `Promise.all` for writes:** Concurrent store calls would still permit partial visibility and would not roll back successful calls after one failure.
- **No store latency changes:** The simulated datastore delays remain unchanged as required.
- **Existing tests unchanged:** The original tests and constants remain untouched; a new collision test covers cross-account reuse.
- **No distributed lock:** The mutex only protects requests sharing one service instance.
- **Lease limitation:** A crash can delay retry until the lease expires; durable reconciliation is still required if the operation committed partially.
- **Persistent write limitation:** A permanently unavailable balance store can still leave an appended entry without its projection; this requires durable reconciliation.
- **Combined snapshot endpoint:** Added `GET /accounts/:id/state`, returning balance, ledger entries, and a version from one completed snapshot.
- **Cross-request behavior:** Existing separate balance and ledger requests can still observe different completed versions; clients needing one view should use the combined endpoint.

## 5. Production traffic and multi-instance behavior

- **What breaks:** Separate instances have independent mutexes and account snapshots, so concurrent writes can race across instances.
- **What also breaks:** One instance can serve a stale process-local snapshot after another instance commits a write.
- **Production replacement:** Replace process-local mutexes with shared datastore leases or distributed locks keyed by account and transfer operation.
- **Shared projections:** Store account balance and ledger-read versions in a shared versioned projection, updated through conditional writes or a change stream.
- **Transaction boundary:** Use a datastore transaction for the transfer's two accounts and four related records; leases alone do not provide atomic commits.
- **Lease recovery:** Give distributed locks expirations and ownership tokens so crashed instances cannot hold accounts indefinitely.
- **Transfer atomicity:** A real multi-key transaction or durable transfer state machine is required for atomic two-account commits.
- **Exercise limitation:** Full transfer atomicity cannot be implemented under the stated store contract; four independent commits always leave observable failure windows.
- **Single-instance behavior:** Sorted account locks and completed snapshots prevent this service instance's HTTP reads from observing those windows.
- **What would fix it:** The datastore would need a real multi-key transaction, or transfers would need to become a durable state machine with recovery and versioned reads.
- **Snapshot replacement:** Use a shared versioned read model, change feed, or cache invalidation mechanism rather than an in-memory map.
- **Idempotency replacement:** Persist claim status and operation fingerprint in the shared datastore, with durable completion and retry/recovery handling.
- **Lease semantics:** Completed idempotency records never expire; only records without results can be reclaimed after their lease deadline.

## 6. AI tooling

- Used Copilot to inspect service, store, mutex, server, and concurrency tests.
- Prompt: `help me fix logic where a request is fired when account's balance is not equals to ledger entries`
- Prompt: `about the limitation, can u wait for both calls to resolve so you can write safely ?`
- Prompt: `what about combining all in the same Promise ?`
- Prompt: `apply the one you think is the best`
- Prompt: `almost perfect: AssertionError: expected 113.91719999999998 to be less than 100`
- Prompt: `do it`
- Prompt: `the result is the same, it didnt fix it`
- Prompt: `can we address this? The idempotency explanation is slightly too broad: per-account locking protects retries for the same account or transfer pair, but a reused key across unrelated operations would need datastore-level idempotency enforcement.`
- Prompt: `you can now do it`
- Prompt: `write to solution.md all the changes we made in bullets, each change is explained in max 30 words`

## 7. Anything we got wrong

- Terminal output was unavailable through the editor tools, so test numbers are not asserted here.
- Process-local snapshots are an SLO optimization for this single-instance exercise, not a complete distributed consistency solution.
- A claimed operation can remain pending after a process crash; a production datastore needs durable status and recovery semantics.
