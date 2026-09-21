# ADR 0003: Consider Cloudflare R2 for private object storage

- Status: Proposed
- Date: 2026-09-21

## Context

Large private artifacts should remain outside Git. A later workflow may require
access-controlled object storage with explicit retention rules.

## Initial decision

Evaluate Cloudflare R2 in a later part. No account, bucket, binding, lifecycle
rule, public URL, signed URL, credential, or deployment is configured.

## Validation still required

Validate access control, data location, cost, retention and deletion behavior,
audit logs, encryption needs, egress behavior, and recovery procedures. Public
bucket access must not be assumed.
