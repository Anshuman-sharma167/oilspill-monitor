export const browserEnvironmentAllowlist = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
] as const;

export type BrowserEnvironmentName =
  (typeof browserEnvironmentAllowlist)[number];

export function readBrowserConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Partial<Record<BrowserEnvironmentName, string>>> {
  return Object.fromEntries(
    browserEnvironmentAllowlist.flatMap((name) => {
      const value = environment[name];
      return value === undefined || value.length === 0 ? [] : [[name, value]];
    }),
  );
}
