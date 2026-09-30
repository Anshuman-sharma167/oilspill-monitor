# Part 5 event sequences

These diagrams describe contract behavior, not deployed services. `DB` means the
private metadata schema and `Store` means private object storage.

## Success

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant D as Discovery
    participant DB as Private DB
    participant Q as Event queue
    participant W as Ephemeral worker
    participant O as openEO
    participant ST as Store
    participant R as Reviewer
    participant A as Alert handler
    participant T as Telegram
    S->>D: discovery event
    D->>DB: upsert scene and immutable job
    DB-->>D: existing or new IDs
    D->>Q: enqueue job_id
    Q->>W: invoke worker
    W->>DB: queued then preprocessing
    W->>O: request preprocessing
    O-->>W: projected processing result
    W->>DB: inferencing
    W->>ST: publish validated versioned assets
    W->>DB: ready_for_review
    R->>DB: persist approved review
    DB->>A: approval event
    A->>DB: create-or-return delivery
    A->>T: send Telegram message
    T-->>A: accepted
    A->>DB: mark delivered
```

## Quota deferral

```mermaid
sequenceDiagram
    participant Q as Event queue
    participant W as Ephemeral worker
    participant O as openEO
    participant DB as Private DB
    Q->>W: invoke job
    W->>O: check or request quota-bound work
    O-->>W: quota unavailable
    W->>DB: state=deferred_quota and deferred_quota_at
    Note over DB: Same job identity is retained
    DB-->>Q: schedule a later retry
```

## openEO timeout

```mermaid
sequenceDiagram
    participant Q as Event queue
    participant W as Ephemeral worker
    participant O as openEO
    participant DB as Private DB
    Q->>W: invoke job
    W->>DB: state=preprocessing
    W->>O: preprocessing request
    O--xW: timeout
    W->>DB: failed_at plus OPENEO_TIMEOUT
    Note over DB: failure.retryable=true
```

## Worker interruption

```mermaid
sequenceDiagram
    participant Q as Event queue
    participant W1 as Worker attempt 1
    participant DB as Private DB
    participant W2 as Worker attempt 2
    Q->>W1: invoke job
    W1->>DB: persist preprocessing transition
    W1--xW1: interrupted
    Q->>W2: redeliver same job event
    W2->>DB: create-or-return immutable job
    DB-->>W2: existing job and last durable state
    W2->>DB: resume or record WORKER_INTERRUPTED
```

## Corrupted output

```mermaid
sequenceDiagram
    participant W as Ephemeral worker
    participant ST as Store
    participant DB as Private DB
    W->>ST: write temporary versioned asset
    W->>ST: read metadata and checksum
    ST-->>W: mismatch or invalid layout
    W->>ST: discard temporary object
    W->>DB: failed_at plus CORRUPTED_OUTPUT
    Note over DB: Job never reaches ready_for_review
```

## Review conflict

```mermaid
sequenceDiagram
    participant R1 as Reviewer 1
    participant R2 as Reviewer 2
    participant DB as Private DB
    R1->>DB: submit revision 2 from revision 1
    DB-->>R1: review saved
    R2->>DB: submit revision 2 from revision 1
    DB-->>R2: conflict; current revision is 2
    R2->>DB: reload candidate and review history
    Note over DB: No alert event for rejected conflict
```

## Telegram retry

```mermaid
sequenceDiagram
    participant DB as Private DB
    participant A as Alert handler
    participant T as Telegram
    DB->>A: approved review event
    A->>DB: create-or-return delivery
    A->>T: send attempt 1
    T--xA: retryable failure
    A->>DB: state=retryable_failure, attempt_count=1
    DB->>A: retry same delivery_id
    A->>T: send attempt 2
    T-->>A: accepted
    A->>DB: state=delivered, attempt_count=2, delivered_at
```
