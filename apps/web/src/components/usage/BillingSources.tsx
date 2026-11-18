import {
  collectBillingSources,
  formatUsageBalance,
  formatResetsIn,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function BillingSources({
  sources,
  now,
}: {
  readonly sources: ReturnType<typeof collectBillingSources>;
  readonly now: number;
}) {
  return sources.map((source) => (
    <section key={source.key} className="space-y-3 rounded-xl border p-4">
      <div>
        <h2 className="text-sm font-medium">{source.label}</h2>
        <p className="text-xs text-muted-foreground">{source.environments.join(", ")}</p>
        {source.limits?.accountLabel ? (
          <p className="text-xs text-muted-foreground">{source.limits.accountLabel}</p>
        ) : null}
      </div>
      {source.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {source.error}
        </p>
      ) : null}
      {source.limits?.unavailable ? (
        <p className="text-sm text-muted-foreground">{source.limits.unavailable.message}</p>
      ) : null}
      {source.limits?.balances?.map((balance) => (
        <p key={balance.currency} className="text-lg font-medium tabular-nums">
          {formatUsageBalance(balance)} remaining
        </p>
      ))}
      {source.limits?.monthlySpend ? (
        <p className="text-sm text-muted-foreground">
          This month (UTC):{" "}
          {source.limits.monthlySpend.amount === null
            ? "Spend unavailable"
            : `${formatUsageBalance({ currency: source.limits.monthlySpend.currency, remaining: source.limits.monthlySpend.amount })} spent`}
        </p>
      ) : null}
      {source.limits?.windows.map((window) => (
        <div key={window.id} className="space-y-1">
          <div className="flex justify-between gap-3 text-xs">
            <span>{window.label}</span>
            <span className="tabular-nums">{remainingPercent(window)}% left</span>
          </div>
          <div
            role="meter"
            aria-label={window.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remainingPercent(window)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${remainingPercent(window)}%` }} />
          </div>
          {window.resetsAt ? (
            <p className="text-xs text-muted-foreground">{formatResetsIn(window, now)}</p>
          ) : null}
        </div>
      ))}
      {source.limits && !source.limits.unavailable ? (
        <p className="text-xs text-muted-foreground">
          Updated {new Date(source.limits.checkedAt).toLocaleString()}
        </p>
      ) : null}
      {source.limits?.externalUsage ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const url = source.limits?.externalUsage?.url;
            if (url) void ensureLocalApi().shell.openExternal(url);
          }}
        >
          Manage billing
        </Button>
      ) : null}
    </section>
  ));
}
