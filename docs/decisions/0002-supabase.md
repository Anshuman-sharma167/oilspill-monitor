# ADR 0002: Consider Supabase for application metadata

- Status: Proposed
- Date: 2026-09-21

## Context

A later application may need authenticated storage for candidate metadata and
human-review state while keeping operational data private.

## Initial decision

Evaluate Supabase for application metadata in a later part. No project, database
schema, migration, authentication flow, storage bucket, function, policy, key,
or remote connection is configured.

## Validation still required

Define the data model and threat model, then validate regional availability,
cost, backup and deletion needs, row-level authorization, auditability, and
private-data handling. Human-review evidence must not become public through an
API or fixture.
