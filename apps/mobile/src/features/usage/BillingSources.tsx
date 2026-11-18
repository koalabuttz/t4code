import {
  collectBillingSources,
  formatUsageBalance,
  formatResetsIn,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

export function BillingSources({
  sources,
  now,
}: {
  readonly sources: ReturnType<typeof collectBillingSources>;
  readonly now: number;
}) {
  return sources.map((source) => (
    <View key={source.key} className="gap-3 rounded-xl border border-border-subtle p-4">
      <Text className="text-base font-t3-medium text-foreground">{source.label}</Text>
      <Text className="text-xs text-foreground-muted">{source.environments.join(", ")}</Text>
      {source.limits?.accountLabel ? (
        <Text className="text-xs text-foreground-muted">{source.limits.accountLabel}</Text>
      ) : null}
      {source.error ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
          {source.error}
        </Text>
      ) : null}
      {source.limits?.unavailable ? (
        <Text className="text-sm text-foreground-muted">{source.limits.unavailable.message}</Text>
      ) : null}
      {source.limits?.balances?.map((balance) => (
        <Text
          key={balance.currency}
          className="text-lg font-t3-medium tabular-nums text-foreground"
        >
          {formatUsageBalance(balance)} remaining
        </Text>
      ))}
      {source.limits?.monthlySpend ? (
        <Text className="text-sm text-foreground-muted">
          This month (UTC):{" "}
          {source.limits.monthlySpend.amount === null
            ? "Spend unavailable"
            : `${formatUsageBalance({ currency: source.limits.monthlySpend.currency, remaining: source.limits.monthlySpend.amount })} spent`}
        </Text>
      ) : null}
      {source.limits?.windows.map((window) => (
        <View key={window.id} className="gap-1">
          <View className="flex-row justify-between gap-3">
            <Text className="text-xs text-foreground-muted">{window.label}</Text>
            <Text className="text-xs tabular-nums text-foreground">
              {remainingPercent(window)}% left
            </Text>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={window.label}
            accessibilityValue={{ min: 0, max: 100, now: remainingPercent(window) }}
            className="h-1.5 overflow-hidden rounded-full bg-subtle-strong"
          >
            <View className="h-full bg-primary" style={{ width: `${remainingPercent(window)}%` }} />
          </View>
          {window.resetsAt ? (
            <Text className="text-xs text-foreground-muted">{formatResetsIn(window, now)}</Text>
          ) : null}
        </View>
      ))}
      {source.limits && !source.limits.unavailable ? (
        <Text className="text-xs text-foreground-muted">
          Updated {new Date(source.limits.checkedAt).toLocaleString()}
        </Text>
      ) : null}
      {source.limits?.externalUsage ? (
        <Pressable
          accessibilityRole="link"
          className="min-h-11 justify-center"
          onPress={() => {
            const url = source.limits?.externalUsage?.url;
            if (url) void Linking.openURL(url).catch(() => undefined);
          }}
        >
          <Text className="text-sm font-t3-medium text-primary">Manage billing</Text>
        </Pressable>
      ) : null}
    </View>
  ));
}
