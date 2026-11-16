import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeBillingApi } from "./billingApi.ts";

const config = (kind: UsageLimitSourceConfig["kind"], url: string): UsageLimitSourceConfig => ({
  kind,
  url,
  managementKey: "",
  enabled: true,
});
const zai = config("zai-coding", "https://api.z.ai");
const zaiPrepaid = config("zai-api", "https://api.z.ai");
const abliteration = config("abliteration", "https://api.abliteration.ai");
const deepseek = config("deepseek", "https://api.deepseek.com");
const reset = Date.parse("2026-11-20T12:00:00Z");

it.effect.each([
  { availableBalance: "7.125", remaining: 7.125 },
  { availableBalance: 0, remaining: 0 },
])("reads GLM prepaid available balance $availableBalance", ({ availableBalance, remaining }) =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const limits = yield* api.read(zaiPrepaid, "prepaid-key");
    expect(limits.balances).toEqual([{ currency: "USD", remaining }]);
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.externalUsage?.url).toBe("https://z.ai/manage-apikey/billing");
  }).pipe(
    Effect.provide([
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.method).toBe("GET");
          expect(request.url).toBe(
            "https://api.z.ai/api/biz/account/query-customer-account-report",
          );
          expect(request.headers.authorization).toBe("Bearer prepaid-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                success: true,
                code: 200,
                data: { availableBalance, balance: 15, frozenBalance: 5, totalSpendAmount: 85 },
              }),
            ),
          );
        }),
      ),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("maps GLM credit and legacy token windows without inventing resets", () => {
  const response = {
    success: true,
    code: 200,
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 5, percentage: 0 },
        {
          type: "CREDIT_LIMIT",
          unit: 6,
          number: 1,
          usage: 10000,
          remaining: 1000,
          percentage: 90,
          nextResetTime: reset,
        },
        { type: "TOKENS_LIMIT", percentage: 40 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 25 },
        { type: "FUTURE_LIMIT", percentage: 10 },
      ],
    },
  };
  return Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const limits = yield* api.read(zai, "key");
    expect(limits.windows).toEqual([
      { id: "CREDIT_LIMIT:3:5", kind: "session", label: "5-hour quota", usedPercent: 0.25 },
      {
        id: "CREDIT_LIMIT:6:1",
        kind: "weekly",
        label: "1-week quota",
        usedPercent: 90,
        resetsAt: "2026-11-20T12:00:00.000Z",
      },
      {
        id: "TOKENS_LIMIT:unknown:unknown",
        kind: "other",
        label: "Reported quota",
        usedPercent: 40,
      },
      { id: "TIME_LIMIT:5:1", kind: "monthly", label: "1-month tool quota", usedPercent: 25 },
    ]);
  }).pipe(
    Effect.provide([
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
          expect(request.headers.authorization).toBe("key");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
        }),
      ),
      NodeCrypto.layer,
    ]),
  );
});

it.effect(
  "uses Abliteration's available credit field without subtracting finalized usage twice",
  () =>
    Effect.gen(function* () {
      const api = yield* makeBillingApi;
      const first = yield* api.read(abliteration, "key");
      const same = yield* api.read(abliteration, "key");
      const other = yield* api.read(abliteration, "different-key");
      expect(first.balances).toEqual([{ currency: "USD", remaining: 7.125 }]);
      expect(first.credentialFingerprint).toBe(same.credentialFingerprint);
      expect(first.credentialFingerprint).not.toBe(other.credentialFingerprint);
    }).pipe(
      Effect.provide([
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://api.abliteration.ai/v1/credits");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ data: { total_credits: 7.125, total_usage: 12.875 } }),
              ),
            );
          }),
        ),
        NodeCrypto.layer,
      ]),
    ),
);

it.effect.each([
  { name: "HTTP auth failure", source: deepseek, status: 401, payload: {} },
  {
    name: "GLM prepaid failure envelope",
    source: zaiPrepaid,
    status: 200,
    payload: { success: false, code: 1000, data: { availableBalance: 0 } },
  },
  {
    name: "GLM prepaid error code",
    source: zaiPrepaid,
    status: 200,
    payload: { success: true, code: 500, data: { availableBalance: 0 } },
  },
  {
    name: "missing GLM prepaid available balance",
    source: zaiPrepaid,
    status: 200,
    payload: { success: true, code: 200, data: { balance: 10 } },
  },
  {
    name: "empty GLM prepaid available balance",
    source: zaiPrepaid,
    status: 200,
    payload: { success: true, code: 200, data: { availableBalance: "" } },
  },
  {
    name: "GLM failure envelope",
    source: zai,
    status: 200,
    payload: { success: false, data: { limits: [] } },
  },
  {
    name: "GLM error code",
    source: zai,
    status: 200,
    payload: { code: 401, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 0 }] } },
  },
  {
    name: "missing GLM percentage",
    source: zai,
    status: 200,
    payload: { data: { limits: [{ type: "TOKENS_LIMIT" }] } },
  },
  {
    name: "empty balance",
    source: deepseek,
    status: 200,
    payload: { is_available: false, balance_infos: [{ currency: "USD", total_balance: "" }] },
  },
  {
    name: "nonfinite balance",
    source: deepseek,
    status: 200,
    payload: {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "Infinity" }],
    },
  },
  {
    name: "empty accounts",
    source: deepseek,
    status: 200,
    payload: { is_available: false, balance_infos: [] },
  },
])("rejects $name instead of reporting a zero balance", ({ source, status, payload }) =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const result = yield* api.read(source, "key").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }).pipe(
    Effect.provide([
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload, { status }))),
        ),
      ),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("never sends billing credentials to another host", () =>
  Effect.gen(function* () {
    const api = yield* makeBillingApi;
    const wrongHost = yield* api
      .read({ ...deepseek, url: "https://other.test" }, "secret")
      .pipe(Effect.result);
    expect(wrongHost._tag).toBe("Failure");
    const prepaid = yield* api
      .read({ ...zaiPrepaid, url: "https://other.test" }, "secret")
      .pipe(Effect.result);
    expect(prepaid._tag).toBe("Failure");
  }).pipe(
    Effect.provide([
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
  ),
);
