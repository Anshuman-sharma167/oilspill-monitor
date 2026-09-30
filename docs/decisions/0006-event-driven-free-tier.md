# ADR 0006: Event-driven free-tier architecture

- Status: Accepted
- Date: 2026-09-25

## Context

Version 1 periodically discovers scenes, preprocesses imagery, runs inference,
stores private candidate assets, waits for human review, and sends an approved
alert. The workload is intermittent. Free tiers impose execution-time, compute,
storage, and egress limits, so idle infrastructure would consume budget without
advancing a job.

## Decision

Version 1 is a set of event-driven stages joined by persisted contracts:

1. A scheduler invokes discovery.
2. Discovery idempotently upserts scenes and creates one immutable processing
   job per scene, AOI, preprocessing version, and model version.
3. A queue or scheduled dispatcher invokes an ephemeral worker.
4. The worker records each state transition, writes versioned private assets,
   and finishes at `ready_for_review`, `deferred_quota`, or `failed`.
5. A human review event is persisted before alert delivery is requested.
6. Alert delivery uses its own idempotency key and retry state.

Postgres stores metadata and idempotency constraints. Object storage holds
versioned assets. Every stage can stop after persisting its result and can be
retried without creating another logical scene, job, candidate, or delivery.

There is no always-on API or virtual machine in version 1. No current workflow
step needs a continuously listening process: scheduled discovery, queued work,
review actions, and alert retries are discrete events. Avoiding an idle API and
VM reduces free-tier compute use, patching and monitoring work, and the exposed
network surface. A later part may add an API only after a user-facing access
pattern, authentication model, and sustained latency requirement exist.

## Consequences

- State must be durable before an event handler acknowledges completion.
- Delivery is at least once; idempotency is enforced in code and by database
  uniqueness constraints.
- Workers must tolerate interruption and must validate stored output before
  moving a job to `ready_for_review`.
- Review remains mandatory. An inference result never sends an alert directly.
- Free-tier quota exhaustion is a normal `deferred_quota` state, not data loss.
- Version 1 has no public database tables, network API, permanent worker, or VM.

## Rejected alternatives

- An always-on REST API adds idle cost and an authentication surface without a
  version 1 caller that requires it.
- A long-running worker makes interruption recovery and quota control harder
  than short, retryable jobs.
- Passing unversioned objects directly between scripts would couple stages and
  make replay unsafe.
