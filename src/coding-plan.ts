import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ZCodeConnection } from "./client.js";
import { workspaceRef, type LaunchSpec } from "./launch.js";
import { record, text } from "./protocol.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const origins = { zai: "https://api.z.ai", bigmodel: "https://bigmodel.cn" };
const accessSchema = z.object({
  type: z.literal("zhipu-account"),
  mode: z.literal("individual-coding-plan"),
  accountType: z.enum(["zai", "bigmodel"]),
});
const providerSchema = z.object({
  providerId: z.string().min(1),
  config: z.object({
    access: accessSchema,
    builtinModelIds: z.array(z.string().min(1)),
  }),
});
const tokenSchema = z.object({
  enable: z.boolean().optional(),
  accessToken: z.string().trim().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().finite().positive(),
  expiresAt: z.number().finite().positive(),
});
type Provider = z.infer<typeof providerSchema>;
type Login = {
  family: "zai" | "bigmodel";
  token: string;
  fingerprint: string;
  zcodeJwt?: string;
};
type Material = { token: string; apiKeyId: string; expires: number };

// Only our own errors may leave this module. API bodies and credential parser
// failures can contain secrets and must never become bb diagnostics.
class AccountError extends Error {}
const failure = (message: string) =>
  new AccountError(`ZCode Coding Plan: ${message}`);
async function readObject(path: string, optional = false) {
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (optional && record(error).code === "ENOENT") return {};
    throw failure(
      "cannot read the desktop configuration. Open ZCode and sign in again.",
    );
  }
}

export interface AccountHost {
  initialize(client: ZCodeConnection): Promise<void>;
  authorize(raw: unknown, sessionId: string): Promise<unknown>;
  authorizeOfficialMcp?(raw: unknown, cwd: string): Promise<unknown>;
  close(): void;
}

/** Implements ZCode's desktop-host contract for individual Coding Plan only. */
export class CodingPlanHost implements AccountHost {
  private controller = new AbortController();
  private provider?: Provider;
  private login?: Login;
  private material?: Material;
  private pending?: Promise<Material>;
  private accountScope = hash(randomUUID());
  private version = "";
  private readonly root: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(
    private launch: LaunchSpec,
    dependencies: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.root = join(
      launch.env.ZCODE_DATA_BASE_DIR || launch.env.HOME || homedir(),
      ".zcode",
      "v2",
    );
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  private async readLogin(): Promise<Login | undefined> {
    const store = await readObject(join(this.root, "credentials.json"), true);
    const get = (key: string) => {
      const value = text(store[key]);
      if (!value.startsWith("enc:v1:")) return value;
      try {
        let username = "unknown";
        try {
          username = userInfo().username;
        } catch {
          /* native fallback */
        }
        const secret =
          this.launch.env.ZCODE_CREDENTIAL_SECRET ||
          `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
        const parts = value.slice(7).split(".");
        if (parts.length !== 3) throw new Error();
        const [iv, tag, ciphertext] = parts.map((p) =>
          Buffer.from(p, "base64url"),
        );
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          createHash("sha256").update(secret).digest(),
          iv,
        );
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw failure(
          "cannot decrypt desktop sign-in. Use the same OS user and credential secret as ZCode.",
        );
      }
    };
    const family = get("oauth:active_provider").trim();
    if (family !== "zai" && family !== "bigmodel") return;
    const settings = await readObject(join(this.root, "setting.json"), true);
    const kind = record(
      record(settings.providerFamilyConnectionSelections)[family],
    ).kind;
    if (kind && kind !== "individual-coding-plan") return;
    const token = get(`oauth:${family}:access_token`)
      .trim()
      .replace(/^Bearer\s+/i, "");
    if (!token) return;
    // Include the saved identity as well as the login generation in the binding.
    const identity = get(`oauth:${family}:user_info`);
    const zcodeJwt = get("zcodejwttoken")
      .trim()
      .replace(/^Bearer\s+/i, "");
    return {
      family,
      token,
      fingerprint: hash(JSON.stringify([family, token, identity, zcodeJwt])),
      zcodeJwt: zcodeJwt || undefined,
    };
  }

  private async assertCurrent() {
    if (this.controller.signal.aborted) throw failure("session closed.");
    const current = await this.readLogin();
    if (!current || current.fingerprint !== this.login?.fingerprint) {
      this.close();
      throw failure("desktop sign-in changed. Start a new bb session.");
    }
    if (this.controller.signal.aborted) throw failure("session closed.");
  }

  private async request(
    path: string,
    authorization: string,
    body?: unknown,
    optionalCode = false,
  ): Promise<unknown> {
    await this.assertCurrent();
    try {
      const response = await this.fetcher(
        `${origins[this.login!.family]}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(15_000),
          ]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(
          `account service returned HTTP ${response.status}. Reconnect Coding Plan in ZCode and retry.`,
        );
      }
      // Bound even chunked responses; never include their contents in errors.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const envelope = record(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (
        envelope.success === false ||
        (!(optionalCode && envelope.code === undefined) &&
          ![0, 200, "0", "200"].includes(envelope.code as number))
      )
        throw new Error();
      await this.assertCurrent();
      return envelope.data;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw failure(
        "account request failed or returned an invalid response. Check ZCode sign-in and network access.",
      );
    }
  }

  private async obtainMaterial(): Promise<Material> {
    const login = this.login!;
    const auth = login.family === "zai" ? `Bearer ${login.token}` : login.token;
    const customer = record(
      await this.request("/api/biz/customer/getCustomerInfo", auth),
    );
    const organizations = (
      Array.isArray(customer.organizations) ? customer.organizations : []
    )
      .map(record)
      .map((org) => ({
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        projects: (Array.isArray(org.projects) ? org.projects : [])
          .map(record)
          .filter(
            (p) => text(p.projectId) && String(p.projectType ?? "") !== "2",
          ),
      }))
      .filter((org) => text(org.organizationId) && org.projects.length);
    const organization =
      organizations.find((org) =>
        text(org.organizationName).includes("默认机构"),
      ) ?? organizations[0];
    const project =
      organization?.projects.find((p) =>
        text(p.projectName).includes("默认项目"),
      ) ?? organization?.projects[0];
    if (!organization || !project)
      throw failure("no personal Coding Plan project is available.");
    const path = `/api/biz/v1/organization/${encodeURIComponent(text(organization.organizationId))}/projects/${encodeURIComponent(text(project.projectId))}/api_keys`;
    const keys = await this.request(path, auth);
    const key = (Array.isArray(keys) ? keys : [])
      .map(record)
      .find((k) => k.name === "zcode-api-key");
    const apiKeyId = text(key?.apiKey).trim();
    if (!apiKeyId)
      throw failure(
        "open Coding Plan in ZCode Desktop once to prepare its project key, then retry.",
      );
    const started = this.now();
    const data = record(
      await this.request(
        `${path}/${encodeURIComponent(apiKeyId)}/access_tokens`,
        `Bearer ${login.token}`,
        {
          clientType: "zcode",
          clientVersion: this.version,
        },
      ),
    );
    const parsed = tokenSchema.safeParse(data);
    if (!parsed.success || parsed.data.enable === false)
      throw failure(
        "short-lived project tokens are unavailable. Update ZCode and reconnect Coding Plan.",
      );
    const token = parsed.data.accessToken;
    const expires = Math.min(
      started + parsed.data.expiresIn * 1000,
      parsed.data.expiresAt * 1000,
    );
    if (!Number.isFinite(expires) || expires <= this.now() + 5000)
      throw failure(
        "short-lived project tokens are unavailable. Update ZCode and reconnect Coding Plan.",
      );
    const subscriptions = await this.request(
      "/api/biz/subscription/list",
      token,
      undefined,
      true,
    );
    if (
      !Array.isArray(subscriptions) ||
      !subscriptions
        .map(record)
        .some(
          (s) =>
            [s.productId, s.productName].some((name) =>
              text(name).toLowerCase().includes("coding"),
            ) &&
            s.status === "VALID" &&
            s.inCurrentPeriod === true,
        )
    )
      throw failure(
        "an active individual Coding Plan subscription could not be verified.",
      );
    await this.assertCurrent();
    return {
      token,
      apiKeyId,
      expires: Math.min(expires - 5000, this.now() + 5 * 60_000),
    };
  }

  private async getMaterial(rejected?: string) {
    await this.assertCurrent();
    if (rejected && this.material && hash(this.material.token) === rejected)
      this.material = undefined;
    if (this.material && this.material.expires > this.now() + 30_000)
      return this.material;
    if (!this.pending) {
      this.pending = this.obtainMaterial()
        .then((material) => (this.material = material))
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  async initialize(client: ZCodeConnection) {
    // A bundled catalog is needed to bind the overlay to exactly the same revision.
    const file = this.launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (!file) return;
    this.login = await this.readLogin();
    if (!this.login) return;
    const builtin = await readObject(file);
    const rules = record(
      record(builtin.config).providerConfigRules,
    ).providerRules;
    this.provider = (Array.isArray(rules) ? rules : [])
      .map((rule) => providerSchema.safeParse(rule))
      .find(
        (parsed) =>
          parsed.success &&
          parsed.data.config.access.accountType === this.login!.family,
      )?.data;
    if (!this.provider) return;
    this.version = this.launch.env.ZCODE_APP_VERSION || "";
    if (!this.version) {
      try {
        const plist = await readFile(
          resolve(dirname(file), "../../../Info.plist"),
          "utf8",
        );
        this.version =
          plist.match(
            /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
          )?.[1] ?? "";
      } catch {
        /* custom bundles may supply ZCODE_APP_VERSION */
      }
    }
    if (!this.version)
      throw failure(
        "cannot determine the desktop version. Set ZCODE_APP_VERSION for a custom bundle.",
      );
    await this.getMaterial();
    const providerId = this.provider.providerId;
    await client.request("provider/updateAccountConfig", {
      revision: `bb-coding-plan:${randomUUID()}`,
      basedOnZCodeBuiltinRevision: `zcode-builtin:${builtin.revision}:${hash(resolve(file))}`,
      providers: {
        [providerId]: {
          access: { type: "zhipu-account", entitled: true },
          builtinModelIds: this.provider.config.builtinModelIds,
        },
      },
      states: {
        [providerId]: {
          availability: "available",
          entitled: true,
          current: true,
        },
      },
    });
  }

  async authorize(raw: unknown, sessionId: string) {
    try {
      const p = record(raw);
      const model = record(p.modelSelection);
      const access = accessSchema.safeParse(p.accountAccess);
      if (
        !this.provider ||
        !access.success ||
        p.sessionId !== sessionId ||
        p.providerId !== this.provider.providerId ||
        model.providerId !== p.providerId ||
        access.data.accountType !== this.login?.family ||
        !this.provider.config.builtinModelIds.includes(text(model.modelId)) ||
        (p.expectedAccountScope !== undefined &&
          p.expectedAccountScope !== this.accountScope) ||
        (p.rejectedProjectTokenFingerprint !== undefined &&
          (p.expectedAccountScope !== this.accountScope ||
            !/^[a-f0-9]{64}$/.test(text(p.rejectedProjectTokenFingerprint))))
      )
        throw failure(
          "unsupported or mismatched account request. Only the current individual Coding Plan is supported.",
        );
      const material = await this.getMaterial(
        text(p.rejectedProjectTokenFingerprint),
      );
      await this.assertCurrent();
      return {
        headersApplied: true,
        requestAuth: {
          apiKey: material.token,
          apiKeyId: material.apiKeyId,
          accountScope: this.accountScope,
        },
      };
    } catch (error) {
      return {
        headersApplied: false,
        errorMessage:
          error instanceof AccountError
            ? error.message
            : "ZCode Coding Plan authentication failed.",
      };
    }
  }

  async authorizeOfficialMcp(raw: unknown, cwd: string) {
    const p = record(raw);
    // Validate the destination before loading any identity material. This is
    // ZCode's official MCP origin, distinct from its model/account API origins.
    try {
      const origin = new URL(text(p.targetOrigin));
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.origin !== "https://zcode.z.ai" ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        return { ok: false, reason: "official_mcp_origin_untrusted" };
    } catch {
      return { ok: false, reason: "official_mcp_origin_untrusted" };
    }
    const workspace = record(p.workspace),
      expected = workspaceRef(cwd);
    if (
      !text(p.requestId) ||
      !text(p.pluginId) ||
      !text(p.mcpKey) ||
      workspace.workspaceKey !== expected.workspaceKey ||
      workspace.workspacePath !== expected.workspacePath
    )
      return { ok: false, reason: "official_auth_unavailable" };
    if (!this.provider)
      return { ok: false, reason: "official_auth_plan_required" };
    try {
      await this.getMaterial();
      await this.assertCurrent();
      if (!this.login?.zcodeJwt)
        return { ok: false, reason: "official_auth_unavailable" };
      return {
        ok: true,
        headers: {
          Authorization: `Bearer ${this.login.zcodeJwt}`,
          "X-Bigmodel-Authorization": `Bearer ${this.login.token}`,
          "Bigmodel-Target-Type": "PERSONAL",
        },
      };
    } catch {
      return { ok: false, reason: "official_auth_unavailable" };
    }
  }

  close() {
    this.controller.abort();
    this.material = undefined;
    this.login = undefined;
  }
}
