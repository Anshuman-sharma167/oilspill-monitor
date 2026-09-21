# ADR 0005: Require human approval

- Status: Accepted as an initial safety constraint
- Date: 2026-09-21

## Context

Synthetic-aperture radar dark features have multiple causes. Model output alone
cannot establish an oil spill, official ground truth, vessel attribution, or a
legal conclusion.

## Decision

Every generated item remains an oil-like slick candidate pending manual review.
The system may assign a review priority, but it must not make an automatic final
decision or issue an external alert without explicit human approval.
`uncertain`, `likely slick`, and `look-alike` are review labels whose evidence
and provenance must be preserved privately.

## Consequences

Later interfaces must record review state, prevent unapproved publication,
preserve an audit trail, and present uncertainty and source limitations.
Automation may assist triage but may not bypass approval.
