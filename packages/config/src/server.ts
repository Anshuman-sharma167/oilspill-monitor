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
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "GITHUB_DISPATCH_TOKEN",
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
