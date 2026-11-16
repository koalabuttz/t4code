import {
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { makeClaudeConsole } from "./claudeConsole.ts";

const Numeric = Schema.Union([Schema.Number, Schema.String]);
const DeepSeekBalance = Schema.Struct({
  is_available: Schema.Boolean,
  balance_infos: Schema.Array(Schema.Struct({ currency: Schema.String, total_balance: Numeric })),
});
const AbliterationBalance = Schema.Struct({
  data: Schema.Struct({ total_credits: Numeric, total_usage: Numeric }),
});
const ZaiBalance = Schema.Struct({
  success: Schema.Boolean,
  code: Numeric,
  data: Schema.Struct({ availableBalance: Numeric }),
});
const ZaiQuota = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  code: Schema.optional(Numeric),
  data: Schema.Struct({
    limits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        unit: Schema.optional(Numeric),
        number: Schema.optional(Numeric),
        percentage: Schema.optional(Numeric),
        usage: Schema.optional(Numeric),
        currentValue: Schema.optional(Numeric),
        remaining: Schema.optional(Numeric),
        nextResetTime: Schema.optional(Schema.NullOr(Numeric)),
      }),
    ),
  }),
});

const decodeDeepSeekBalance = Schema.decodeUnknownEffect(DeepSeekBalance);
const decodeAbliterationBalance = Schema.decodeUnknownEffect(AbliterationBalance);
const decodeZaiBalance = Schema.decodeUnknownEffect(ZaiBalance);
const decodeZaiQuota = Schema.decodeUnknownEffect(ZaiQuota);

class BillingReadError extends Schema.TaggedError<BillingReadError>()("BillingReadError", {
  reason: Schema.Literals(["payload", "endpoint"]),
}) {}

function numeric(value: string | number | null | undefined) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim()))
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quotaWindow(
  limit: (typeof ZaiQuota.Type.data.limits)[number],
): ServerProviderUsageWindow | undefined {
  if (!["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(limit.type)) return undefined;
  const total = numeric(limit.usage);
  const used = numeric(limit.currentValue);
  const remaining = numeric(limit.remaining);
  const percent =
    total !== undefined && total > 0 && (used !== undefined || remaining !== undefined)
      ? ((used ?? total - remaining!) / total) * 100
      : numeric(limit.percentage);
  if (percent === undefined) return undefined;
  const unit = numeric(limit.unit);
  const count = numeric(limit.number);
  const suffix =
    unit === 3
      ? "hour"
      : unit === 4
        ? "day"
        : unit === 5
          ? "month"
          : unit === 6
            ? "week"
            : undefined;
  const period = suffix && count && count > 0 ? `${count}-${suffix}` : "Reported";
  const reset = numeric(limit.nextResetTime);
  const validReset = reset !== undefined && reset > 0 && reset <= 8.64e15;
  return {
    id: `${limit.type}:${unit ?? "unknown"}:${count ?? "unknown"}`,
    kind: unit === 6 ? "weekly" : unit === 5 ? "monthly" : unit === 3 ? "session" : "other",
    label: `${period} ${limit.type === "TIME_LIMIT" ? "tool quota" : "quota"}`,
    usedPercent: Math.max(0, Math.min(100, percent)),
    ...(validReset ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)) } : {}),
  };
}

export const makeBillingApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const claudeConsole = yield* makeClaudeConsole;
  const read = Effect.fn("BillingApi.read")(
    function* (config: UsageLimitSourceConfig, key: string) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const expectedOrigin =
        config.kind === "deepseek"
          ? "https://api.deepseek.com"
          : config.kind === "abliteration"
            ? "https://api.abliteration.ai"
            : config.kind === "anthropic"
              ? "https://platform.claude.com"
              : "https://api.z.ai";
      const url = URL.parse(config.url);
      if (
        !url ||
        url.origin !== expectedOrigin ||
        url.username ||
        url.password ||
        config.kind === "cliproxy"
      ) {
        return yield* new BillingReadError({ reason: "endpoint" });
      }
      if (config.kind === "anthropic") {
        return yield* claudeConsole.read(key, checkedAt, config.organizationId);
      }
      const fingerprint = Hex.encode(
        yield* digest.digest(
          Digest.sha256,
          new TextEncoder().encode(`${config.kind}:${url.origin}:${key}`),
        ),
      );
      const path =
        config.kind === "deepseek"
          ? "/user/balance"
          : config.kind === "abliteration"
            ? "/v1/credits"
            : config.kind === "zai-api"
              ? "/api/biz/account/query-customer-account-report"
              : "/api/monitor/usage/quota/limit";
      const raw = yield* client
        .execute(
          HttpClientRequest.get(`${url.origin}${path}`).pipe(
            HttpClientRequest.setHeader(
              "Authorization",
              config.kind === "zai-coding" ? key : `Bearer ${key}`,
            ),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout("10 seconds"),
        );
      const base = { checkedAt, credentialFingerprint: fingerprint };
      if (config.kind === "deepseek") {
        const payload = yield* decodeDeepSeekBalance(raw);
        const balances = yield* Effect.forEach(payload.balance_infos, (balance) => {
          const remaining = numeric(balance.total_balance);
          return remaining === undefined || !/^[A-Z]{3}$/.test(balance.currency)
            ? Effect.fail(new BillingReadError({ reason: "payload" }))
            : Effect.succeed({ currency: balance.currency, remaining });
        });
        if (balances.length === 0) return yield* new BillingReadError({ reason: "payload" });
        return { ...base, windows: [], balances } satisfies ServerProviderUsageLimits;
      }
      if (config.kind === "abliteration") {
        const { data } = yield* decodeAbliterationBalance(raw);
        const remaining = numeric(data.total_credits);
        if (remaining === undefined) return yield* new BillingReadError({ reason: "payload" });
        return {
          ...base,
          windows: [],
          balances: [{ currency: "USD", remaining }],
        } satisfies ServerProviderUsageLimits;
      }
      if (config.kind === "zai-api") {
        const payload = yield* decodeZaiBalance(raw);
        // This undocumented account report accepts API keys; availableBalance excludes frozen funds.
        const remaining = numeric(payload.data.availableBalance);
        if (!payload.success || numeric(payload.code) !== 200 || remaining === undefined) {
          return yield* new BillingReadError({ reason: "payload" });
        }
        return {
          ...base,
          windows: [],
          balances: [{ currency: "USD", remaining }],
          externalUsage: {
            label: "Z.ai prepaid balance",
            url: "https://z.ai/manage-apikey/billing",
          },
        } satisfies ServerProviderUsageLimits;
      }
      const payload = yield* decodeZaiQuota(raw);
      const code = numeric(payload.code);
      if (payload.success === false || (code !== undefined && code !== 0 && code !== 200)) {
        return yield* new BillingReadError({ reason: "payload" });
      }
      const windows = payload.data.limits.flatMap((limit) => {
        const window = quotaWindow(limit);
        return window ? [window] : [];
      });
      if (windows.length === 0) return yield* new BillingReadError({ reason: "payload" });
      return { ...base, windows } satisfies ServerProviderUsageLimits;
    },
    Effect.map((limits: ServerProviderUsageLimits) => limits),
  );
  return { read };
});
