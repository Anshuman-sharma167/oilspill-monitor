import { createPrivateKey, sign } from "node:crypto";

export interface GitHubDispatchConfig {
  owner: string;
  repository: string;
  workflow: string;
  ref: string;
  appId: string;
  installationId: string;
  privateKey: string;
  enabled: boolean;
}

const encoded = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const githubAppJwt = (
  appId: string,
  privateKey: string,
  nowSeconds: number,
): string => {
  if (!/^[0-9]{1,20}$/u.test(appId)) throw new Error("INVALID_GITHUB_APP_ID");
  const header = encoded({ alg: "RS256", typ: "JWT" });
  const body = encoded({
    iat: nowSeconds - 30,
    exp: nowSeconds + 540,
    iss: appId,
  });
  const content = `${header}.${body}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(content),
    createPrivateKey(privateKey),
  );
  return `${content}.${signature.toString("base64url")}`;
};

const request = async (
  fetcher: typeof fetch,
  url: string,
  token: string,
  init: RequestInit,
): Promise<Response> => {
  const response = await fetcher(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`);
  return response;
};

export class GitHubJobDispatcher {
  constructor(
    private readonly config: GitHubDispatchConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly nowSeconds: () => number = () =>
      Math.floor(Date.now() / 1000),
    private readonly createAppJwt: typeof githubAppJwt = githubAppJwt,
  ) {}

  async dispatch(jobId: string): Promise<void> {
    if (!this.config.enabled) throw new Error("PART9_DISPATCH_DISABLED");
    if (!/^job:[0-9a-f]{32}$/u.test(jobId)) throw new Error("INVALID_JOB_ID");
    for (const value of [
      this.config.owner,
      this.config.repository,
      this.config.workflow,
      this.config.ref,
      this.config.installationId,
    ])
      if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(value))
        throw new Error("INVALID_GITHUB_DISPATCH_CONFIG");

    const appJwt = this.createAppJwt(
      this.config.appId,
      this.config.privateKey,
      this.nowSeconds(),
    );
    const tokenResponse = await request(
      this.fetcher,
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      appJwt,
      {
        method: "POST",
        body: JSON.stringify({ permissions: { actions: "write" } }),
      },
    );
    const tokenBody = (await tokenResponse.json()) as { token?: unknown };
    if (typeof tokenBody.token !== "string" || tokenBody.token.length < 20)
      throw new Error("INVALID_GITHUB_INSTALLATION_TOKEN");
    await request(
      this.fetcher,
      `https://api.github.com/repos/${this.config.owner}/${this.config.repository}/actions/workflows/${this.config.workflow}/dispatches`,
      tokenBody.token,
      {
        method: "POST",
        body: JSON.stringify({
          ref: this.config.ref,
          inputs: { job_id: jobId },
        }),
      },
    );
  }
}
