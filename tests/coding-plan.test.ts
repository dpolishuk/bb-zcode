import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodingPlanHost } from "../src/coding-plan.js";
import { record } from "../src/protocol.js";

const hosts: CodingPlanHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));
function fixture(family: "zai" | "bigmodel" = "zai", encrypted = false) {
  const root = mkdtempSync(join(tmpdir(), "bb-zcode-account-"));
  const data = join(root, ".zcode", "v2");
  mkdirSync(data, { recursive: true });
  const providerId = `account:${family}-individual-coding-plan`;
  const access = {
    type: "zhipu-account",
    mode: "individual-coding-plan",
    accountType: family,
  };
  const builtin = join(root, "builtin.json");
  writeFileSync(
    builtin,
    JSON.stringify({
      revision: 31,
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId, config: { access, builtinModelIds: ["glm"] } },
          ],
        },
      },
    }),
  );
  const credentials = {
    "oauth:active_provider": family,
    [`oauth:${family}:access_token`]: "private-login-canary",
    [`oauth:${family}:user_info`]: JSON.stringify({
      id: "private-user-canary",
    }),
  };
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update("test-secret").digest(),
      iv,
    );
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
  };
  const save = () =>
    writeFileSync(
      join(data, "credentials.json"),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(credentials).map(([k, v]) => [
            k,
            encrypted ? encrypt(v) : v,
          ]),
        ),
      ),
    );
  save();
  writeFileSync(
    join(data, "setting.json"),
    JSON.stringify({
      providerFamilyConnectionSelections: {
        [family]: { kind: "individual-coding-plan" },
      },
    }),
  );
  let now = 1_800_000_000_000;
  let tokenCount = 0;
  let intercept: ((path: string) => unknown) | undefined;
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const address = new URL(String(url));
      expect(address.origin).toBe(
        family === "zai" ? "https://api.z.ai" : "https://bigmodel.cn",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      const custom = intercept?.(address.pathname);
      if (custom instanceof Response) return custom;
      if (custom instanceof Error) throw custom;
      if (custom) return Response.json(custom);
      let result: unknown;
      if (address.pathname.endsWith("getCustomerInfo")) {
        expect(record(init?.headers).Authorization).toBe(
          family === "zai"
            ? "Bearer private-login-canary"
            : "private-login-canary",
        );
        result = {
          organizations: [
            {
              organizationId: "team-org",
              projects: [{ projectId: "team", projectType: 2 }],
            },
            {
              organizationId: "personal-org",
              projects: [{ projectId: "personal", projectType: 1 }],
            },
          ],
        };
      } else if (address.pathname.endsWith("api_keys")) {
        expect(init?.method).toBe("GET");
        expect(address.pathname).toContain("/personal-org/projects/personal/");
        result = [{ apiKey: "key-id", name: "zcode-api-key" }];
      } else if (address.pathname.endsWith("access_tokens")) {
        expect(init?.method).toBe("POST");
        expect(record(init?.headers).Authorization).toBe(
          "Bearer private-login-canary",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          clientType: "zcode",
          clientVersion: "3.15.1",
        });
        result = {
          accessToken: `private-project-canary-${++tokenCount}`,
          tokenType: "Bearer",
          expiresIn: 3600,
          expiresAt: now / 1000 + 3600,
        };
      } else if (address.pathname.endsWith("subscription/list")) {
        expect(record(init?.headers).Authorization).toBe(
          `private-project-canary-${tokenCount}`,
        );
        result = [
          {
            productName: "GLM Coding Plan",
            status: "VALID",
            inCurrentPeriod: true,
          },
        ];
      } else throw new Error("Unexpected endpoint");
      return Response.json({ code: 200, data: result });
    },
  );
  const host = new CodingPlanHost(
    {
      command: "unused",
      args: [],
      env: {
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_CREDENTIAL_SECRET: "test-secret",
        ZCODE_APP_VERSION: "3.15.1",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      },
    },
    { fetch: fetcher as typeof fetch, now: () => now },
  );
  hosts.push(host);
  const client = { request: vi.fn(async () => ({})), close: async () => {} };
  const request = {
    sessionId: "session",
    providerId,
    accountAccess: access,
    modelSelection: { providerId, modelId: "glm" },
  };
  return {
    host,
    client,
    request,
    fetcher,
    data,
    credentials,
    save,
    providerId,
    builtin,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    advance: () => {
      now += 3600_000;
    },
  };
}

it.each(["zai", "bigmodel"] as const)(
  "loads %s Coding Plan models with a secret-free overlay and scoped short-lived auth",
  async (family) => {
    const f = fixture(family, true);
    await f.host.initialize(f.client);
    expect(f.client.request).toHaveBeenCalledOnce();
    const [method, payload] = f.client.request.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("provider/updateAccountConfig");
    expect(payload.basedOnZCodeBuiltinRevision).toBe(
      `zcode-builtin:31:${createHash("sha256").update(f.builtin).digest("hex")}`,
    );
    expect(JSON.stringify(payload)).not.toContain("private-");
    expect(record(record(payload.providers)[f.providerId]).access).toEqual({
      type: "zhipu-account",
      entitled: true,
    });
    const result = record(await f.host.authorize(f.request, "session"));
    expect(result.headersApplied).toBe(true);
    expect(record(result.requestAuth).accountScope).toMatch(/^[a-f0-9]{64}$/);
    expect(record(result.requestAuth).apiKey).toBe("private-project-canary-1");
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    f.advance();
    expect(
      record(record(await f.host.authorize(f.request, "session")).requestAuth)
        .apiKey,
    ).toBe("private-project-canary-2");
  },
);

it.each(["session", "provider", "model", "scope", "mode", "unscoped-retry"])(
  "denies mismatched %s without releasing credentials",
  async (mismatch) => {
    const f = fixture();
    await f.host.initialize(f.client);
    const request = structuredClone(f.request) as Record<string, unknown>;
    if (mismatch === "session") request.sessionId = "other";
    if (mismatch === "provider") request.providerId = "other";
    if (mismatch === "model") record(request.modelSelection).modelId = "other";
    if (mismatch === "scope") request.expectedAccountScope = "other";
    if (mismatch === "mode")
      record(request.accountAccess).mode = "team-coding-plan";
    if (mismatch === "unscoped-retry")
      request.rejectedProjectTokenFingerprint = "a".repeat(64);
    const result = await f.host.authorize(request, "session");
    expect(record(result).headersApplied).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  },
);

it("refreshes a rejected token only within the same account scope", async () => {
  const f = fixture();
  await f.host.initialize(f.client);
  const auth = record(
    record(await f.host.authorize(f.request, "session")).requestAuth,
  );
  const result = record(
    await f.host.authorize(
      {
        ...f.request,
        expectedAccountScope: auth.accountScope,
        rejectedProjectTokenFingerprint: createHash("sha256")
          .update(String(auth.apiKey))
          .digest("hex"),
      },
      "session",
    ),
  );
  expect(record(result.requestAuth).apiKey).toBe("private-project-canary-2");
});

it.each(["logout", "switch", "close"])(
  "invalidates credentials after %s",
  async (action) => {
    const f = fixture();
    await f.host.initialize(f.client);
    if (action === "close") f.host.close();
    else {
      f.credentials["oauth:zai:access_token"] =
        action === "logout" ? "" : "changed";
      f.save();
    }
    const result = await f.host.authorize(f.request, "session");
    expect(record(result).headersApplied).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-");
  },
);

it.each([
  "missing-key",
  "disabled-token",
  "expired-token",
  "no-subscription",
  "network",
  "redirect",
  "oversized",
  "logout-during-request",
])("fails closed on %s with safe diagnostics", async (scenario) => {
  const f = fixture();
  f.intercept((path) => {
    if (scenario === "network") return new Error("private-response-canary");
    if (scenario === "redirect")
      return new Response("private-response-canary", {
        status: 302,
        headers: { Location: "https://untrusted.invalid" },
      });
    if (scenario === "oversized")
      return new Response("private-response-canary".repeat(100_000));
    if (scenario === "missing-key" && path.endsWith("api_keys"))
      return { code: 200, data: [] };
    if (scenario === "disabled-token" && path.endsWith("access_tokens"))
      return { code: 200, data: { enable: false } };
    if (scenario === "expired-token" && path.endsWith("access_tokens"))
      return {
        code: 200,
        data: {
          accessToken: "private-response-canary",
          tokenType: "Bearer",
          expiresIn: -1,
          expiresAt: 1,
        },
      };
    if (scenario === "no-subscription" && path.endsWith("subscription/list"))
      return {
        code: 200,
        data: [
          {
            productName: "Coding Plan",
            status: "EXPIRED",
            inCurrentPeriod: false,
          },
        ],
      };
    if (scenario === "logout-during-request") {
      f.credentials["oauth:zai:access_token"] = "";
      f.save();
    }
  });
  await expect(f.host.initialize(f.client)).rejects.toThrow(
    /^ZCode Coding Plan:/,
  );
  expect(f.client.request).not.toHaveBeenCalled();
  const result = await f.host.authorize(f.request, "session");
  expect(record(result).headersApplied).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private-");
});

it("leaves personal providers alone when no desktop account is signed in", async () => {
  const f = fixture();
  f.credentials["oauth:zai:access_token"] = "";
  f.save();
  await f.host.initialize(f.client);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.client.request).not.toHaveBeenCalled();
});

it("aborts in-flight account HTTP requests when the session closes", async () => {
  const f = fixture();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.fetcher.mockImplementationOnce(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("private-abort-canary")),
          { once: true },
        );
        ready();
      }),
  );
  const result = expect(f.host.initialize(f.client)).rejects.toThrow(
    /^ZCode Coding Plan:/,
  );
  await started;
  f.host.close();
  await result;
  expect(f.client.request).not.toHaveBeenCalled();
});

it("coalesces simultaneous token refreshes", async () => {
  const f = fixture();
  await f.host.initialize(f.client);
  f.advance();
  const results = await Promise.all([
    f.host.authorize(f.request, "session"),
    f.host.authorize(f.request, "session"),
  ]);
  expect(results.map((r) => record(record(r).requestAuth).apiKey)).toEqual([
    "private-project-canary-2",
    "private-project-canary-2",
  ]);
  expect(f.fetcher).toHaveBeenCalledTimes(8);
});
