import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeBillingApi } from "./billingApi.ts";

const config = {
  kind: "anthropic" as const,
  url: "https://platform.claude.com",
  enabled: true,
  managementKey: "",
};
const organizations = [
  { uuid: "chat-org", name: "Chat", capabilities: ["chat"] },
  { uuid: "api-org", name: "API account", capabilities: ["api"] },
];

it.effect.each([
  { amount: 12345, exponent: 2, remaining: 123.45, spendStatus: 200, spend: 4.56 },
  { amount: 123450, exponent: 3, remaining: 123.45, spendStatus: 200, spend: 0.456 },
  { amount: 0, exponent: 2, remaining: 0, spendStatus: 401, spend: null },
  { amount: 0, exponent: undefined, remaining: 0, spendStatus: 200, spend: 4.56 },
])("reads Console balance $amount without requiring spend", (test) =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const limits = yield* api.read(config, "console-secret");
    expect(limits.balances).toEqual([{ currency: "USD", remaining: test.remaining }]);
    expect(limits.monthlySpend).toEqual({ currency: "USD", amount: test.spend });
    expect(limits.accountLabel).toBe("API account");
    expect(limits.windows).toEqual([]);
    expect(limits.externalUsage?.url).toBe("https://platform.claude.com/settings/billing");
  }).pipe(
    Effect.provide([
      NodeCrypto.layer,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.method).toBe("GET");
          expect(request.headers.cookie).toBe("sessionKey=console-secret");
          expect(request.headers.authorization).toBeUndefined();
          const path = new URL(request.url).pathname;
          if (path === "/api/organizations") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json(organizations)),
            );
          }
          if (path === "/api/organizations/api-org/prepaid/credits") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  amount: test.amount,
                  currency: "USD",
                  balance: { credits: { exponent: test.exponent } },
                }),
              ),
            );
          }
          expect(path).toBe("/api/organizations/api-org/current_spend");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ amount: 456 }, { status: test.spendStatus }),
            ),
          );
        }),
      ),
    ]),
  ),
);

it.effect(
  "requires an explicit API organization when several exist and scopes deduplication to it",
  () =>
    Effect.gen(function* () {
      const api = yield* makeBillingApi;
      const ambiguous = yield* api.read(config, "session-one").pipe(Effect.result);
      expect(ambiguous._tag).toBe("Failure");
      if (ambiguous._tag === "Failure")
        expect(ambiguous.failure._tag).toBe("ClaudeConsoleReadError");
      const first = yield* api.read({ ...config, organizationId: "api-org" }, "session-one");
      const renewed = yield* api.read({ ...config, organizationId: "api-org" }, "session-two");
      const other = yield* api.read({ ...config, organizationId: "other-org" }, "session-one");
      expect(first.credentialFingerprint).toBe(renewed.credentialFingerprint);
      expect(other.credentialFingerprint).not.toBe(first.credentialFingerprint);
      const chat = yield* api
        .read({ ...config, organizationId: "chat-org" }, "session-one")
        .pipe(Effect.result);
      expect(chat._tag).toBe("Failure");
    }).pipe(
      Effect.provide([
        NodeCrypto.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/api/organizations")
                    ? [
                        ...organizations,
                        { uuid: "other-org", name: "Other API", capabilities: ["api"] },
                      ]
                    : { amount: 100, currency: "USD" },
                ),
              ),
            ),
          ),
        ),
      ]),
    ),
);

it.effect.each([401, 403])("reports Console HTTP %s as an actionable credential error", (status) =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const result = yield* api.read(config, "session").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ClaudeConsoleReadError");
      expect(result.failure.message).toContain(status === 401 ? "expired" : "access");
    }
  }).pipe(
    Effect.provide([
      NodeCrypto.layer,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
        ),
      ),
    ]),
  ),
);

it.effect.each([
  { name: "missing amount", credits: { currency: "USD" } },
  { name: "string amount", credits: { amount: "100", currency: "USD" } },
  { name: "fractional minor units", credits: { amount: 1.2, currency: "USD" } },
  {
    name: "invalid exponent",
    credits: { amount: 100, currency: "USD", balance: { credits: { exponent: 10 } } },
  },
])("rejects $name instead of displaying zero", ({ credits }) =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const result = yield* api.read(config, "console-secret").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }).pipe(
    Effect.provide([
      NodeCrypto.layer,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(request.url.endsWith("/api/organizations") ? organizations : credits),
            ),
          ),
        ),
      ),
    ]),
  ),
);
