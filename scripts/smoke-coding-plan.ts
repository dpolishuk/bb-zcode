import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createBridge } from "../src/bridge.js";
import { CodingPlanHost } from "../src/coding-plan.js";
import { record } from "../src/protocol.js";

async function transportFixture(root: string, upstream: string, token: string) {
  const keyFile = join(root, "tls-key.pem");
  const certFile = join(root, "tls-cert.pem");
  const certConfig = join(root, "tls.cnf");
  writeFileSync(
    certConfig,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-config",
      certConfig,
    ],
    { stdio: "ignore" },
  );
  const checks = { signingHandshakes: 0, authenticatedModelRequests: 0 };
  const server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certFile) },
    async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url === "/api/paas/c1f3a7e2/v2/client") {
          checks.signingHandshakes++;
          // Native signing-service-unavailable fallback; production signatures
          // are intentionally outside this synthetic auth-delivery check.
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: 503 }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401);
          response.end();
          return;
        }
        checks.authenticatedModelRequests++;
        const result = await fetch(`${upstream}${request.url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        });
        response.writeHead(result.status, {
          "content-type": "text/event-stream",
        });
        for await (const chunk of result.body!) response.write(chunk);
        response.end();
      } catch {
        response.destroy();
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No account fixture listener");
  return {
    url: `https://127.0.0.1:${address.port}`,
    certFile,
    checks,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Real ZCode child, synthetic account service and loopback inference. The
// production host has no endpoint override; dependency injection stays here.
export async function smokeCodingPlan(
  sourceBuiltin: string,
  parentEnv: NodeJS.ProcessEnv,
) {
  const root = mkdtempSync(join(tmpdir(), "bb-zcode-coding-plan-"));
  const data = join(root, ".zcode", "v2");
  mkdirSync(data, { recursive: true });
  const builtin = JSON.parse(readFileSync(sourceBuiltin, "utf8"));
  const providerId = "account:zai-individual-coding-plan";
  const template = builtin.config.providerConfigRules.templateRules[0];
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "synthetic-key" })}.synthetic`;
  const transport = await transportFixture(
    root,
    template.config.api.baseUrl,
    token,
  );
  try {
    builtin.config.providerConfigRules.providerRules = [
      {
        providerId,
        providerName: "Synthetic Coding Plan",
        config: {
          ...template.config,
          group: "zai-family",
          api: { ...template.config.api, baseUrl: transport.url },
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
          },
        },
      },
    ];
    builtin.config.modelConfigRules.builtinProviderModelRules =
      builtin.config.modelConfigRules.templateModelRules.map(
        ({ templateId: _templateId, ...rule }: Record<string, unknown>) => ({
          ...rule,
          providerId,
        }),
      );
    const file = join(root, "builtin.json");
    writeFileSync(file, JSON.stringify(builtin));
    const personal = join(root, "personal.json");
    writeFileSync(
      personal,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: {
            providerModelRules: [],
            manualProviderModelRules: [],
          },
          defaultModelSelection: { providerId, modelId: "fixture" },
        },
      }),
    );
    writeFileSync(
      join(data, "credentials.json"),
      JSON.stringify({
        "oauth:active_provider": "zai",
        "oauth:zai:access_token": "synthetic-desktop-login",
        "oauth:zai:user_info": JSON.stringify({ id: "synthetic-user" }),
      }),
    );
    writeFileSync(
      join(data, "setting.json"),
      JSON.stringify({
        providerFamilyConnectionSelections: {
          zai: { kind: "individual-coding-plan" },
        },
      }),
    );
    let authorizations = 0;
    const fakeFetch: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      let data: unknown;
      if (path.endsWith("getCustomerInfo"))
        data = {
          organizations: [
            {
              organizationId: "o",
              projects: [{ projectId: "p", projectType: 1 }],
            },
          ],
        };
      else if (path.endsWith("api_keys"))
        data = [{ apiKey: "synthetic-key", name: "zcode-api-key" }];
      else if (path.endsWith("access_tokens"))
        data = {
          accessToken: token,
          tokenType: "Bearer",
          expiresIn: 3600,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      else if (path.endsWith("subscription/list"))
        data = [
          {
            productName: "Coding Plan",
            status: "VALID",
            inCurrentPeriod: true,
          },
        ];
      else throw new Error("Unexpected fixture endpoint");
      return Response.json({ code: 200, data });
    };
    const messages: Record<string, unknown>[] = [];
    const bridge = createBridge({
      env: {
        ...parentEnv,
        HOME: root,
        ZCODE_HOME: join(root, ".zcode", "cli"),
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: file,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_APP_VERSION: "3.15.1",
        NODE_EXTRA_CA_CERTS: transport.certFile,
      },
      accountFactory(launch) {
        const account = new CodingPlanHost(launch, { fetch: fakeFetch });
        return {
          initialize: (client) => account.initialize(client),
          close: () => account.close(),
          async authorize(raw, sessionId) {
            const result = await account.authorize(raw, sessionId);
            if (record(result).headersApplied) authorizations++;
            return result;
          },
        };
      },
      write: (message) => messages.push(message),
    });
    let nextId = 0;
    const wait = async (ready: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!ready()) {
        if (Date.now() > deadline)
          throw new Error("Coding Plan smoke timed out.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const rpc = async (method: string, params: unknown) => {
      const id = ++nextId;
      bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await wait(() => messages.some((m) => m.id === id && !m.method));
      const reply = messages.find((m) => m.id === id && !m.method)!;
      if (reply.error)
        throw new Error(
          `Coding Plan ${method} failed: ${JSON.stringify(reply.error)}`,
        );
      return record(reply.result);
    };
    try {
      const catalog = await rpc("model/list", { cwd: root });
      const models = catalog.models as Array<Record<string, unknown>>;
      const model = models.find((m) => m.model === `${providerId}/fixture`);
      if (
        !model ||
        !(
          model.supportedReasoningEfforts as Array<Record<string, unknown>>
        ).some((l) => l.reasoningEffort === "high")
      )
        throw new Error("Coding Plan catalog did not expose native efforts.");
      const options = {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        model: `${providerId}/fixture`,
        reasoningLevel: "high",
      };
      const started = await rpc("thread/start", {
        threadId: "account-smoke",
        cwd: root,
        options,
        instructionMode: "append",
      });
      await rpc("turn/start", {
        threadId: "account-smoke",
        providerThreadId: started.providerThreadId,
        options,
        clientRequestId: "creq_abcdefghij",
        input: [
          { type: "text", text: "Say hello. Do not use tools.", mentions: [] },
        ],
      });
      const deltas = () =>
        messages
          .filter((m) => m.method === "thread/delta")
          .flatMap(
            (m) => record(m.params).deltas as Array<Record<string, unknown>>,
          );
      await wait(() => deltas().some((d) => d.kind === "turn.boundary"));
      if (
        deltas().find((d) => d.kind === "turn.boundary")?.status !==
          "completed" ||
        !authorizations
      )
        throw new Error(
          `Coding Plan runtime authentication failed: ${JSON.stringify(deltas())}`,
        );
      if (JSON.stringify(messages).includes(token))
        throw new Error("Credential leaked to bb.");
      if (
        transport.checks.authenticatedModelRequests !== 1 ||
        !transport.checks.signingHandshakes
      )
        throw new Error(
          "Native Coding Plan transport did not deliver authentication.",
        );
      return {
        codingPlanRuntimeVerified: true,
        authorizations,
        ...transport.checks,
        signingService: "synthetic 503; native unsigned fallback",
        evidence: root,
      };
    } finally {
      await bridge.close();
    }
  } finally {
    await transport.close();
  }
}
