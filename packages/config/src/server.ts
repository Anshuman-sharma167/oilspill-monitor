export const serverOnlyEnvironmentNames = [
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
  "CDSE_COLLECTION_ID",
  "CDSE_VV_BAND",
  "CDSE_VH_BAND",
  "CDSE_TOKEN_SAFETY_MS",
  "CDSE_USAGE_CACHE_MS",
  "CDSE_FREE_CREDIT_REFERENCE",
  "CDSE_DISPATCH_ENABLED",
  "PART8_DISCOVERY_ENABLED",
  "PART8_POLL_OVERLAP_MINUTES",
  "PART8_STAC_PAGE_SIZE",
  "PART8_MAX_PAGES",
  "PART8_MAX_ITEMS",
  "PART8_REQUEST_TIMEOUT_MS",
  "PART8_RETRY_ATTEMPTS",
  "PART8_INITIAL_RETRY_DELAY_MS",
  "PART8_MAX_RETRY_DELAY_MS",
  "PART8_PREPROCESSING_VERSION",
  "PART8_MODEL_VERSION",
  "PART8_CRON_SECRET",
  "PART9_WORKER_ID",
  "PART9_LEASE_SECONDS",
  "PART9_RETRY_BASE_SECONDS",
  "PART9_RETRY_MAX_SECONDS",
  "PART9_STAGE_VERSION",
  "PART9_DISPATCH_ENABLED",
  "PART9_GITHUB_APP_ID",
  "PART9_GITHUB_APP_INSTALLATION_ID",
  "PART9_GITHUB_APP_PRIVATE_KEY",
  "PART9_GITHUB_OWNER",
  "PART9_GITHUB_REPOSITORY",
  "PART9_GITHUB_WORKFLOW",
  "PART9_GITHUB_REF",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
] as const;

export type ServerEnvironmentName = (typeof serverOnlyEnvironmentNames)[number];

export class MissingServerConfigError extends Error {
  override name = "MissingServerConfigError";
}

export function requireServerConfig<
  const Names extends ServerEnvironmentName[],
>(
  names: Names,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<Names[number], string>> {
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new MissingServerConfigError(
      `Missing required server configuration: ${missing.join(", ")}`,
    );
  }

  return Object.fromEntries(
    names.map((name) => [name, environment[name]]),
  ) as Record<Names[number], string>;
}
