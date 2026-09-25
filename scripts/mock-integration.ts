import assert from "node:assert/strict";

import { normalizeCandidate } from "../packages/schemas/src/index.js";

const result = normalizeCandidate({
  candidateId: "synthetic-mock-integration",
  observedAt: "2026-01-01T00:00:00.000Z",
  assessment: "uncertain",
  reviewPriority: "normal",
});

assert.equal(result.reviewStatus, "pending_manual_review");
assert.equal(result.coordinatesIncluded, false);
assert.equal(result.assessment, "uncertain");
console.log(JSON.stringify(result));
