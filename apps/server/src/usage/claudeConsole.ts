import { type ServerProviderUsageLimits, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const minorUnits = Schema.Int.check(
  Schema.isBetween({
    minimum: Number.MIN_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
);
const currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/));
const decodeOrganizations = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      uuid: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
      name: TrimmedNonEmptyString,
      capabilities: Schema.Array(Schema.String),
    }),
  ),
);
const decodeCredits = Schema.decodeUnknownEffect(
  Schema.Struct({
    amount: minorUnits,
    currency,
    balance: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          credits: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                exponent: Schema.optional(
                  Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
);
const decodeSpend = Schema.decodeUnknownEffect(
  Schema.Struct({
    amount: minorUnits.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

class ClaudeConsoleReadError extends Schema.TaggedError<ClaudeConsoleReadError>()(
  "ClaudeConsoleReadError",
  { reason: Schema.Literals(["session", "permission", "organization", "credential"]) },
) {
  override get message() {
    switch (this.reason) {
      case "session":
        return "Claude Console session expired. Sign in and replace the source's session key.";
      case "permission":
        return "This Claude Console session does not have access to API billing.";
      case "organization":
        return "Select an API organization using its Organization ID in the usage source settings.";
      case "credential":
        return "Enter only the Claude Console sessionKey cookie value.";
    }
  }
}

export const makeClaudeConsole = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const read = Effect.fn("ClaudeConsole.read")(function* (
    sessionKey: string,
    checkedAt: string,
    organizationId?: string,
  ) {
    if (!sessionKey || /[;\r\n]/.test(sessionKey)) {
      return yield* new ClaudeConsoleReadError({ reason: "credential" });
    }
    const request = Effect.fn("ClaudeConsole.request")(function* (path: string) {
      const response = yield* client.execute(
        HttpClientRequest.get(`https://platform.claude.com${path}`).pipe(
          HttpClientRequest.setHeaders({
            Cookie: `sessionKey=${sessionKey}`,
            Accept: "application/json",
          }),
        ),
      );
      if (response.status === 401) return yield* new ClaudeConsoleReadError({ reason: "session" });
      if (response.status === 403)
        return yield* new ClaudeConsoleReadError({ reason: "permission" });
      yield* HttpClientResponse.filterStatusOk(response);
      return yield* response.json;
    }, Effect.timeout("10 seconds"));

    const organizations = yield* decodeOrganizations(yield* request("/api/organizations"));
    const candidates = organizations.filter(
      (organization) =>
        organization.capabilities.includes("api") &&
        (!organizationId || organization.uuid === organizationId),
    );
    const organization = candidates[0];
    if (candidates.length !== 1 || !organization) {
      return yield* new ClaudeConsoleReadError({ reason: "organization" });
    }
    const path = `/api/organizations/${organization.uuid}`;
    const credits = yield* decodeCredits(yield* request(`${path}/prepaid/credits`));
    // Console reports minor units, with a legacy USD-cent default when the exponent is absent.
    const scale = 10 ** (credits.balance?.credits?.exponent ?? 2);
    const spend = yield* request(`${path}/current_spend`).pipe(
      Effect.flatMap(decodeSpend),
      Effect.result,
    );
    const credentialFingerprint = Hex.encode(
      yield* digest.digest(
        Digest.sha256,
        new TextEncoder().encode(`anthropic:platform.claude.com:${organization.uuid}`),
      ),
    );
    return {
      checkedAt,
      credentialFingerprint,
      accountLabel: organization.name,
      windows: [],
      balances: [{ currency: credits.currency, remaining: credits.amount / scale }],
      monthlySpend: {
        currency: credits.currency,
        amount: spend._tag === "Success" ? spend.success.amount / scale : null,
      },
      externalUsage: {
        label: "Claude API billing",
        url: "https://platform.claude.com/settings/billing",
      },
    } satisfies ServerProviderUsageLimits;
  });
  return { read };
});
