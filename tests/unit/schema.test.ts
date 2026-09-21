import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCandidate } from "../../packages/schemas/src/index.js";

test("normalizes a synthetic candidate and requires manual review", () => {
  const result = normalizeCandidate({
    candidateId: "  synthetic-candidate-test  ",
    observedAt: "2026-01-01T00:00:00.000Z",
    assessment: "uncertain",
    reviewPriority: "low",
  });

  assert.deepEqual(result, {
    schemaVersion: "0.1.0",
    candidateId: "synthetic-candidate-test",
    observedAt: "2026-01-01T00:00:00.000Z",
    source: "synthetic-example",
    assessment: "uncertain",
    reviewPriority: "low",
    reviewStatus: "pending_manual_review",
    coordinatesIncluded: false,
  });
});

test("rejects a non-canonical observation timestamp", () => {
  assert.throws(
    () =>
      normalizeCandidate({
        candidateId: "synthetic-candidate-test",
        observedAt: "2026-01-01",
        assessment: "uncertain",
        reviewPriority: "normal",
      }),
    /ISO 8601 UTC timestamp/u,
  );
});
