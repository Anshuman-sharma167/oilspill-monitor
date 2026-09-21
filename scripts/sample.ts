import { normalizeCandidate } from "../packages/schemas/src/index.js";

const candidate = normalizeCandidate({
  candidateId: "synthetic-candidate-001",
  observedAt: "2026-01-01T00:00:00.000Z",
  assessment: "uncertain",
  reviewPriority: "normal",
});

console.log(JSON.stringify(candidate, null, 2));
