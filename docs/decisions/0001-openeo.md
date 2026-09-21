# ADR 0001: Consider openEO for processing orchestration

- Status: Proposed
- Date: 2026-09-21

## Context

A later workflow may need a provider-neutral way to submit satellite-processing
jobs without embedding provider-specific code throughout the project.

## Initial decision

Evaluate openEO as an orchestration interface in a later part. No provider,
endpoint, account, process graph, or credential has been selected or configured.

## Validation still required

Confirm provider coverage, Sentinel-1 product availability, processing
semantics, quotas, cost, authentication, export controls, and reproducibility
before acceptance. A failed validation may replace this proposal.
