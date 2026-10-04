import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Part9BrokerDatabase,
  validatePart9BrokerConfiguration,
} from "../../services/worker/src/part9-broker-database.js";

const jobId = "job:00000000000000000000000000000001";
const configuration = {
  job_id: jobId,
  broker_url: "https://example.supabase.co/functions/v1/part9-job-broker",
  job_token: "synthetic-job-token-value-longer-than-32-characters",
};

test("broker configuration is HTTPS-only and bound to the selected job", () => {
  assert.deepEqual(
    validatePart9BrokerConfiguration(configuration, jobId),
    configuration,
  );
  assert.throws(
    () =>
      validatePart9BrokerConfiguration(
        { ...configuration, job_id: `${jobId}0` },
        jobId,
      ),
    /INVALID_PART9_BROKER_CONFIGURATION/u,
  );
  assert.throws(
    () =>
      validatePart9BrokerConfiguration(
        { ...configuration, broker_url: "http://example.test/broker" },
        jobId,
      ),
    /INVALID_PART9_BROKER_CONFIGURATION/u,
  );
});

test("broker adapter sends a job-scoped request without database credentials", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ row: null });
  }) as typeof fetch;
  const database = new Part9BrokerDatabase(configuration, fetcher);
  assert.equal(
    await database.claim("worker:test", 300, new Date("2026-10-04T12:00:00Z")),
    null,
  );
  assert.equal(requests[0]?.url, `${configuration.broker_url}/database`);
  assert.equal(requests[0]?.body.job_id, jobId);
  assert.equal(requests[0]?.body.operation, "claim");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    `Bearer ${configuration.job_token}`,
  );
  assert.doesNotMatch(
    JSON.stringify(requests[0]?.body),
    /database|password|service_role/iu,
  );
});

test("broker adapter does not expose a failed response body", async () => {
  const database = new Part9BrokerDatabase(
    configuration,
    (async () =>
      new Response("private database detail", { status: 503 })) as typeof fetch,
  );
  await assert.rejects(
    database.claim("worker:test", 300, new Date("2026-10-04T12:00:00Z")),
    (error: Error) =>
      error.message === "PART9_BROKER_REQUEST_FAILED_503" &&
      !error.message.includes("private database detail"),
  );
});

test("broker verifies GitHub identity and issues only short-lived job config", () => {
  const broker = readFileSync(
    "supabase/functions/part9-job-broker/index.ts",
    "utf8",
  );
  for (const claim of [
    "repository",
    "repository_id",
    "ref",
    "event_name",
    "workflow_ref",
    "runner_environment",
  ])
    assert.match(broker, new RegExp(claim, "u"));
  assert.match(broker, /algorithms: \["RS256"\]/u);
  assert.match(broker, /setExpirationTime\("10m"\)/u);
  assert.match(broker, /PART9_BROKER_PUBLIC_URL/u);
  assert.match(broker, /claim_processing_job_by_id/u);
  assert.match(broker, /jobId: row\.job_id/u);
  assert.match(broker, /claimToken: row\.claim_token/u);
  assert.doesNotMatch(broker, /SUPABASE_SERVICE_ROLE_KEY/u);
});
