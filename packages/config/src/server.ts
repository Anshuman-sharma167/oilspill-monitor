export const serverOnlyEnvironmentNames = [
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
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
    throw new Error(
      `Missing required server configuration: ${missing.join(", ")}`,
    );
  }

  return Object.fromEntries(
    names.map((name) => [name, environment[name]]),
  ) as Record<Names[number], string>;
}
