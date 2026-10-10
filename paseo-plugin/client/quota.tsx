/**
 * Quota screen + sidebar entry. Renders the bridge's combined quota card
 * (GLM Coding Plan, Opencode Go, Ollama Cloud) with usage bars, reset
 * countdowns and per-model MCP detail — everything the native Paseo usage
 * card (server/usage.ts) does not carry. Text colors come from theme.colors;
 * only the bar fills use fixed heat hexes so they read on light and dark.
 */

import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import {
  quotaGet,
  type QuotaOutput,
} from "../shared/quota";

/** The screen's auto-refresh cadence. The daemon caches for 30s. */
const REFRESH_MS = 60_000;

type HeatKey = "statusSuccess" | "statusWarning" | "statusDanger";

function heat(usedPercent: number): HeatKey {
  if (usedPercent > 90) return "statusDanger";
  if (usedPercent >= 70) return "statusWarning";
  return "statusSuccess";
}

/** "in 2h 13m" / "in 3d 1h" / "now" from seconds-until or an epoch-ms target. */
function until(input: number, isEpochMs: boolean): string {
  const sec = Math.round((isEpochMs ? input - Date.now() : input) / 1000);
  if (!Number.isFinite(sec) || sec <= 0) return "now";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

interface ThemeColors {
  foreground: string;
  foregroundMuted: string;
  surface0: string;
  surface2: string;
  border: string;
  accent: string;
  accentForeground: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}

function Bar({
  usedPercent,
  colors,
}: {
  usedPercent: number;
  colors: ThemeColors;
}) {
  const pct = Math.max(0, Math.min(100, usedPercent));
  return (
    <View
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.surface2,
        overflow: "hidden",
        marginTop: 4,
      }}
    >
      <View
        style={{
          width: `${pct}%` as `${number}%`,
          height: 6,
          borderRadius: 3,
          backgroundColor: colors[heat(usedPercent)],
        }}
      />
    </View>
  );
}

function WindowRow({
  label,
  usedPercent,
  meta,
  colors,
}: {
  label: string;
  usedPercent: number;
  meta?: string;
  colors: ThemeColors;
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {label}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {Math.round(usedPercent)}% used{meta ? ` · ${meta}` : ""}
        </Text>
      </View>
      <Bar usedPercent={usedPercent} colors={colors} />
    </View>
  );
}

function MutedLine({ text, colors }: { text: string; colors: ThemeColors }) {
  return (
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginBottom: 8 }}>
      {text}
    </Text>
  );
}

function Section({
  title,
  subtitle,
  colors,
  children,
}: {
  title: string;
  subtitle?: string;
  colors: ThemeColors;
  children: ReactNode;
}) {
  return (
    <View style={{ marginBottom: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: colors.accent, fontSize: 12 }}>{subtitle}</Text>
        ) : null}
      </View>
      <View style={{ height: 12 }} />
      {children}
    </View>
  );
}

function GlmSection({ data, colors }: { data: QuotaOutput["glm"]; colors: ThemeColors }) {
  if (data.kind === "success") {
    return (
      <Section
        title="GLM Coding Plan"
        subtitle={data.level}
        colors={colors}
      >
        {data.items.map((item) => {
          const label =
            item.key === "token_5h"
              ? "5-hour window"
              : item.key === "mcp"
                ? "MCP tool calls"
                : item.key.startsWith("token_")
                  ? "Weekly window"
                  : item.label;
          const meta =
            item.usedCount !== undefined && item.totalCount !== undefined
              ? `${item.usedCount} / ${item.totalCount}`
              : undefined;
          return (
            <View key={item.key}>
              <WindowRow
                label={label}
                usedPercent={item.usedPercent}
                meta={meta}
                colors={colors}
              />
              {item.nextResetTime ? (
                <MutedLine
                  text={`Resets ${until(item.nextResetTime, true)}`}
                  colors={colors}
                />
              ) : null}
              {item.detail?.map((d) => (
                <Text
                  key={d.modelCode}
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 11,
                    marginLeft: 12,
                    marginBottom: 2,
                  }}
                >
                  {d.modelCode}: {d.usage}
                </Text>
              ))}
            </View>
          );
        })}
      </Section>
    );
  }
  const line =
    data.kind === "auth_error"
      ? "Not signed in — GLM credentials missing from ~/.zcode."
      : data.kind === "rate_limited"
        ? "GLM quota API rate-limited — retry shortly."
        : "GLM quota unavailable.";
  return (
    <Section title="GLM Coding Plan" colors={colors}>
      <MutedLine text={line} colors={colors} />
    </Section>
  );
}

function GoSection({ data, colors }: { data: QuotaOutput["go"]; colors: ThemeColors }) {
  const title = "Opencode Go";
  if (data.kind === "success") {
    const rows: Array<{ label: string; usagePercent: number; resetInSec: number }> = [
      { label: "Rolling 5h", usagePercent: data.rolling.usagePercent, resetInSec: data.rolling.resetInSec },
      { label: "Weekly", usagePercent: data.weekly.usagePercent, resetInSec: data.weekly.resetInSec },
    ];
    if (data.monthly) {
      rows.push({ label: "Monthly", usagePercent: data.monthly.usagePercent, resetInSec: data.monthly.resetInSec });
    }
    return (
      <Section title={title} colors={colors}>
        {rows.map((row) => (
          <View key={row.label}>
            <WindowRow label={row.label} usedPercent={row.usagePercent} colors={colors} />
            <MutedLine text={`Resets ${until(row.resetInSec, false)}`} colors={colors} />
          </View>
        ))}
      </Section>
    );
  }
  const line =
    data.kind === "not_configured"
      ? "Not configured."
      : data.kind === "auth_error"
        ? "Not signed in."
        : "Unavailable.";
  return (
    <Section title={title} colors={colors}>
      <MutedLine text={line} colors={colors} />
    </Section>
  );
}

function OcSection({ data, colors }: { data: QuotaOutput["oc"]; colors: ThemeColors }) {
  const title = "Ollama Cloud";
  if (data.kind === "success") {
    const rows: Array<{ label: string; pct: number; resetAt?: number }> = [];
    if (data.session !== undefined) {
      rows.push({ label: "Session (5h)", pct: data.session * 100, resetAt: data.sessionResetAt });
    }
    if (data.weekly !== undefined) {
      rows.push({ label: "Weekly", pct: data.weekly * 100, resetAt: data.weeklyResetAt });
    }
    if (data.monthly !== undefined) {
      rows.push({ label: "Monthly", pct: data.monthly * 100, resetAt: data.monthlyResetAt });
    }
    if (rows.length === 0) {
      return (
        <Section title={title} colors={colors}>
          <MutedLine text="No usage reported yet." colors={colors} />
        </Section>
      );
    }
    return (
      <Section title={title} colors={colors}>
        {rows.map((row) => (
          <View key={row.label}>
            <WindowRow label={row.label} usedPercent={row.pct} colors={colors} />
            {row.resetAt ? (
              <MutedLine text={`Resets ${until(row.resetAt, true)}`} colors={colors} />
            ) : null}
          </View>
        ))}
      </Section>
    );
  }
  const line =
    data.kind === "not_configured"
      ? "Not configured."
      : data.kind === "auth_error"
        ? "Not signed in."
        : "Unavailable.";
  return (
    <Section title={title} colors={colors}>
      <MutedLine text={line} colors={colors} />
    </Section>
  );
}

function Separator({ colors }: { colors: ThemeColors }) {
  return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />;
}

function QuotaScreenInner({
  theme,
  layout,
}: {
  theme: { colors: ThemeColors };
  layout: { compact: boolean };
}) {
  const colors = theme.colors;
  const getQuota = useRpc(quotaGet);
  const [data, setData] = useState<QuotaOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getQuota({}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [getQuota]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: colors.surface0,
      } as const,
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 4,
      } as const,
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        marginBottom: 8,
      },
      title: { color: colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      refresh: {
        backgroundColor: colors.accent,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 8,
      },
      refreshText: { color: colors.accentForeground, fontSize: 13 },
      updated: { color: colors.foregroundMuted, fontSize: 11 },
    }),
    [colors, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Quota</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh quota"
            onPress={() => void load()}
            style={styles.refresh}
          >
            <Text style={styles.refreshText}>{loading ? "Refreshing…" : "Refresh"}</Text>
          </Pressable>
        </View>
        {data ? (
          <Text style={styles.updated}>
            Updated {new Date(data.queriedAt).toLocaleTimeString()}
            {data.error ? ` · ${data.error}` : ""}
          </Text>
        ) : null}
        {error ? <MutedLine text={`Query failed: ${error}`} colors={colors} /> : null}
        {data ? (
          <>
            <GlmSection data={data.glm} colors={colors} />
            <Separator colors={colors} />
            <GoSection data={data.go} colors={colors} />
            <Separator colors={colors} />
            <OcSection data={data.oc} colors={colors} />
          </>
        ) : (
          <MutedLine
            text={loading ? "Loading quota…" : "No data yet — press Refresh."}
            colors={colors}
          />
        )}
      </ScrollView>
    </View>
  );
}

export function QuotaScreen({ theme, layout }: PluginScreenProps) {
  return <QuotaScreenInner theme={theme} layout={layout} />;
}

function QuotaSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gauge"
      label="Quota"
      active={currentScreen?.screenId === "quota"}
      onPress={() => openScreen({ screenId: "quota" })}
    />
  );
}

export function contributeClient(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "quota",
    title: "Quota",
    Component: QuotaScreen,
  });
  const removeSidebar = client.addSidebarFooterItem({
    id: "quota",
    title: "Quota",
    Component: QuotaSidebarItem,
  });
  return () => {
    removeScreen();
    removeSidebar();
  };
}
