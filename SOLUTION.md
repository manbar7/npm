# Solution notes

Keep this terse — bullet points are fine. We read this before we read your diff.

## 1. What was broken

For each defect you found: where it was, and what specifically goes wrong. Be
concrete about the interleaving — "two requests both read the balance before
either writes" tells us more than "there was a race condition".

| # | Where | What goes wrong |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |

Anything you spotted but did not have time to fix:

## 2. How you made it concurrency-safe

What is your unit of serialization, and why that one? What can now run in
parallel that could not before, and what still cannot?

If two operations touch two different accounts, do they contend? If two
operations touch the *same* account, what orders them?

## 3. Meeting the SLOs

The load test was failing on more than one axis. What was the actual bottleneck,
and what did you change to remove it?

If you concluded that the existing design could not meet the SLOs no matter how
carefully it was patched — say that explicitly, and describe the change you made
instead.

## 4. What you deliberately did not do

Shortcuts, trade-offs, things you would not ship as-is. This section scoring well
is not a consolation prize; knowing where the edges are is the job.

## 5. If this had to survive real production traffic

Assume this becomes multi-instance behind a load balancer tomorrow. Which part of
your solution stops working, and what would you replace it with?

If you added any caching or other process-local state beyond the lock (for
example, chasing the read-latency stretch goal) — what happens to it across
those instances tonight?

## 6. AI tooling

Which tools you used, and the prompts that did the real work. Paste them raw —
we are not grading prose.

<details>
<summary>prompts</summary>

```
```

</details>

## 7. Anything we got wrong

If a test encodes a bad assumption, or the exercise is unfair somewhere, tell us.
