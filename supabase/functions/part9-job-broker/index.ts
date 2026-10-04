import "@supabase/functions-js/edge-runtime.d.ts";
import { Pool, type PoolClient } from "@db/postgres";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const githubIssuer = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);
const jobIdPattern = /^job:[0-9a-f]{32}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const workerPattern = /^[a-z0-9][a-z0-9._:-]{2,127}$/u;
const brokerIssuer = "urn:oilspill-monitor:part9-broker";
const brokerAudience = "urn:oilspill-monitor:part9-job";

const requiredEnvironment = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
};

const sessionSecret = new TextEncoder().encode(
  requiredEnvironment("PART9_JOB_SESSION_SECRET"),
);
if (sessionSecret.byteLength < 32)
  throw new Error("PART9_JOB_SESSION_SECRET_TOO_SHORT");

const pool = new Pool(requiredEnvironment("SUPABASE_DB_URL"), 1, true);

const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

const bearer = (request: Request): string => {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ") || value.length > 8192)
    throw new Error("MISSING_AUTHORIZATION");
  return value.slice(7);
};

const parseBody = async (
  request: Request,
): Promise<Record<string, unknown>> => {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 16_384)
    throw new Error("REQUEST_TOO_LARGE");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST_BODY");
  return value as Record<string, unknown>;
};

const stringField = (
  body: Readonly<Record<string, unknown>>,
  name: string,
  pattern?: RegExp,
): string => {
  const value = body[name];
  if (typeof value !== "string" || (pattern && !pattern.test(value)))
    throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
};

const integerField = (
  body: Readonly<Record<string, unknown>>,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const value = body[name];
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error(`INVALID_${name.toUpperCase()}`);
  return Number(value);
};

const isoDateField = (
  body: Readonly<Record<string, unknown>>,
  name: string,
): string => {
  const value = stringField(body, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value))
    throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
};

const errorDetailField = (body: Readonly<Record<string, unknown>>): string => {
  const value = stringField(body, "error_detail");
  if (
    value.length === 0 ||
    value.length > 500 ||
    /[\r\n\t]/u.test(value) ||
    /(token|secret|password|authorization|cookie|signed[ _-]?url|coordinates?)/iu.test(
      value,
    )
  )
    throw new Error("INVALID_ERROR_DETAIL");
  return value;
};

const timestamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  throw new Error("BROKER_DATABASE_FAILURE");
};

const assertGithubIdentity = (claims: JWTPayload): void => {
  const expected = {
    repository: requiredEnvironment("PART9_ALLOWED_REPOSITORY"),
    repository_id: requiredEnvironment("PART9_ALLOWED_REPOSITORY_ID"),
    ref: requiredEnvironment("PART9_ALLOWED_REF"),
    event_name: "workflow_dispatch",
    workflow_ref: requiredEnvironment("PART9_ALLOWED_WORKFLOW_REF"),
    runner_environment: "github-hosted",
  } as const;
  for (const [name, value] of Object.entries(expected))
    if (claims[name] !== value) throw new Error("GITHUB_IDENTITY_REJECTED");
};

const configuration = async (request: Request) => {
  const audience = requiredEnvironment("PART9_OIDC_AUDIENCE");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(bearer(request), githubKeys, {
      issuer: githubIssuer,
      audience,
      algorithms: ["RS256"],
      clockTolerance: 5,
    }));
  } catch {
    throw new Error("AUTHORIZATION_FAILED");
  }
  assertGithubIdentity(payload);
  const body = await parseBody(request);
  const jobId = stringField(body, "job_id", jobIdPattern);
  const token = await new SignJWT({ scope: "part9:job", job_id: jobId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(brokerIssuer)
    .setAudience(brokerAudience)
    .setSubject(jobId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(sessionSecret);
  const url = new URL(requiredEnvironment("PART9_BROKER_PUBLIC_URL"));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_BROKER_PUBLIC_URL");
  return json(200, {
    job_id: jobId,
    broker_url: url.toString().replace(/\/$/u, ""),
    job_token: token,
  });
};

const withDatabase = async <T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
};

const database = async (request: Request) => {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(bearer(request), sessionSecret, {
      issuer: brokerIssuer,
      audience: brokerAudience,
      algorithms: ["HS256"],
      clockTolerance: 5,
    }));
  } catch {
    throw new Error("INVALID_JOB_SESSION");
  }
  if (payload.scope !== "part9:job" || typeof payload.job_id !== "string")
    throw new Error("INVALID_JOB_SESSION");
  const body = await parseBody(request);
  const jobId = stringField(body, "job_id", jobIdPattern);
  if (payload.sub !== jobId || payload.job_id !== jobId)
    throw new Error("JOB_SCOPE_MISMATCH");
  const operation = stringField(body, "operation");

  return withDatabase(async (client) => {
    if (operation === "claim") {
      const workerId = stringField(body, "worker_id", workerPattern);
      const leaseSeconds = integerField(body, "lease_seconds", 60, 3600);
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{
        job_id: string;
        state: "preprocessing";
        attempt_count: number;
        max_attempts: number;
        claim_token: string;
        lease_expires_at: Date | string;
        provider_job_id: string | null;
      }>(
        "select * from app_private.claim_processing_job_by_id($1, $2, $3, $4)",
        [jobId, workerId, leaseSeconds, now],
      );
      const row = result.rows[0];
      return json(200, {
        row: row
          ? {
              jobId: row.job_id,
              state: row.state,
              attemptCount: row.attempt_count,
              maxAttempts: row.max_attempts,
              claimToken: row.claim_token,
              leaseExpiresAt: timestamp(row.lease_expires_at),
              providerJobId: row.provider_job_id,
            }
          : null,
      });
    }
    if (operation === "renew") {
      const claimToken = stringField(body, "claim_token", uuidPattern);
      const seconds = integerField(body, "lease_seconds", 60, 3600);
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{ renewed: boolean }>(
        "select app_private.renew_processing_job_lease($1, $2, $3, $4) as renewed",
        [jobId, claimToken, seconds, now],
      );
      return json(200, { renewed: result.rows[0]?.renewed === true });
    }
    if (operation === "checkpoint") {
      const claimToken = stringField(body, "claim_token", uuidPattern);
      const stage = stringField(
        body,
        "stage",
        /^(preprocessing|inferencing|asset_upload)$/u,
      );
      const version = stringField(body, "stage_version", /^\d+\.\d+\.\d+$/u);
      const checksum = stringField(body, "checksum", /^[0-9a-f]{64}$/u);
      const now = isoDateField(body, "now");
      const metadata = body.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        throw new Error("INVALID_METADATA");
      const existing = await client.queryObject(
        `select 1 from app_private.processing_stage_checkpoints
         where job_id = $1 and stage_name = $2 and stage_version = $3`,
        [jobId, stage, version],
      );
      await client.queryObject(
        "select app_private.complete_processing_stage($1, $2, $3, $4, $5, $6::jsonb, $7)",
        [
          jobId,
          claimToken,
          stage,
          version,
          checksum,
          JSON.stringify(metadata),
          now,
        ],
      );
      return json(200, { reused: existing.rows.length === 1 });
    }
    if (operation === "advance") {
      const claimToken = stringField(body, "claim_token", uuidPattern);
      const target = stringField(
        body,
        "target",
        /^(inferencing|ready_for_review)$/u,
      );
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{ advanced: boolean }>(
        "select app_private.advance_processing_job($1, $2, $3, $4) as advanced",
        [jobId, claimToken, target, now],
      );
      return json(200, { advanced: result.rows[0]?.advanced === true });
    }
    if (operation === "fail") {
      const claimToken = stringField(body, "claim_token", uuidPattern);
      const errorCode = stringField(body, "error_code", /^[A-Z_]{3,64}$/u);
      const detail = errorDetailField(body);
      if (typeof body.retryable !== "boolean")
        throw new Error("INVALID_RETRYABLE");
      const delay = integerField(body, "retry_delay_seconds", 1, 3600);
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{ state: string }>(
        "select app_private.fail_processing_job($1, $2, $3, $4, $5, $6, $7)::text as state",
        [jobId, claimToken, errorCode, detail, body.retryable, delay, now],
      );
      return json(200, { state: result.rows[0]?.state ?? null });
    }
    if (operation === "expired") {
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{
        job_id: string;
        claim_token: string;
        attempt_count: number;
        provider_job_id: string | null;
      }>(
        `select job_id, claim_token::text, attempt_count, provider_job_id
         from app_private.processing_jobs
         where job_id = $1 and state in ('preprocessing', 'inferencing')
           and lease_expires_at <= $2`,
        [jobId, now],
      );
      return json(200, {
        rows: result.rows.map((row) => ({
          jobId: row.job_id,
          claimToken: row.claim_token,
          attemptCount: row.attempt_count,
          providerJobId: row.provider_job_id,
        })),
      });
    }
    if (operation === "recover") {
      const claimToken = stringField(body, "claim_token", uuidPattern);
      const status = stringField(
        body,
        "status",
        /^(not_submitted|queued|running|finished|error|canceled|unavailable|ambiguous)$/u,
      );
      const delay = integerField(body, "retry_delay_seconds", 1, 3600);
      const now = isoDateField(body, "now");
      const result = await client.queryObject<{ state: string }>(
        "select app_private.recover_expired_processing_job($1, $2, $3, $4, $5)::text as state",
        [jobId, claimToken, status, delay, now],
      );
      return json(200, { state: result.rows[0]?.state ?? null });
    }
    throw new Error("UNKNOWN_OPERATION");
  });
};

Deno.serve(async (request) => {
  if (request.method !== "POST")
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  const pathname = new URL(request.url).pathname.replace(/\/$/u, "");
  try {
    if (pathname.endsWith("/database")) return await database(request);
    if (pathname.endsWith("/config") || pathname.endsWith("/part9-job-broker"))
      return await configuration(request);
    return json(404, { error: "NOT_FOUND" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "BROKER_FAILURE";
    if (
      /^(MISSING_AUTHORIZATION|INVALID_JOB_SESSION|JOB_SCOPE_MISMATCH|GITHUB_IDENTITY_REJECTED)$/u.test(
        code,
      )
    )
      return json(403, { error: code });
    if (code === "AUTHORIZATION_FAILED")
      return json(401, { error: "AUTHORIZATION_FAILED" });
    if (/^(INVALID_|REQUEST_TOO_LARGE|UNKNOWN_OPERATION)/u.test(code))
      return json(400, { error: code });
    return json(500, { error: "BROKER_FAILURE" });
  }
});
