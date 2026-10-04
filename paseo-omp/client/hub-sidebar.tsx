import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
// Namespace import: on 0.9/0.10 hosts this module lacks SidebarRow, which is only rendered from
// 0.11-only sidebar items. Typed locally so older SDK typechecks still compile.
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { AvailabilityDisplay } from "../shared/availability-display";
import { toAvailabilityDisplay } from "../shared/availability-display";
import { getOmpProviderHealth } from "../shared/provider-diagnostics";
import { HubProcessList } from "./hub-popover";
import { availabilityTrailingSuffix } from "./hub-status";
import { freshnessNotice, type PillFreshness, type PillKind } from "./pill-freshness";
import { HUB_AVAILABILITY_QUERY_KEY } from "./provider-diagnostics-state";
import { CONFIG_SCREEN_ID, type HubSnapshot, hubTrailing } from "./sidebar-compat";

// The row is always mounted; a slower poll bounds per-client RPC fan-out across workspaces.
const HUB_POLL_MS = 15_000;
// Shared with the config surface health read; staleTime mirrors the server health cache TTL.
const HUB_AVAILABILITY_STALE_MS = 30_000;
const HUB_SIDEBAR_QUERY_KEY = ["paseo-omp", "hub-sidebar"] as const;

interface OpenScreenInput {
  screenId: string;
  params?: Record<string, string>;
}
type HostProps = Pick<PluginHostProps, "theme" | "layout">;
interface PopoverProps extends HostProps {
  close(): void;
  openScreen(input: OpenScreenInput): void;
}
interface SidebarItemProps extends HostProps {
  currentScreen: { screenId: string; params: Record<string, string> } | null;
  openScreen(input: OpenScreenInput): void;
  openPopover(Content: ComponentType<PopoverProps>): void;
}
type SidebarRowComponent = ComponentType<{
  id?: string;
  icon?: string | ComponentType<{ size: number; color: string }>;
  label?: string;
  onPress(): void;
  active?: boolean;
  trailing?: ReactNode;
}>;

const uiModule: object = pluginUi;
// Present on every 0.11 host, the only hosts that render these items. The guard and cast keep
// older-SDK typechecks (which lack SidebarRow) compiling; presence check only, because host
// components may be memo/forwardRef objects rather than plain functions.
const SidebarRow: SidebarRowComponent | undefined =
  "SidebarRow" in uiModule && uiModule.SidebarRow
    ? (uiModule.SidebarRow as SidebarRowComponent)
    : undefined;

export function ConfigSidebarItem({ currentScreen, openScreen }: SidebarItemProps) {
  if (!SidebarRow) return null;
  return (
    <SidebarRow
      icon="Settings"
      label="OMP"
      active={currentScreen?.screenId === CONFIG_SCREEN_ID}
      onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
    />
  );
}

/**
 * Stale/error banner for a composer pill's popover (QW3). Pure presentation: the state machine
 * lives in `pill-freshness.ts` and Retry reuses the owner's existing refresh function, so this
 * adds no timer and no RPC. Renders nothing while fresh.
 */
export function PillFreshnessBanner({
  kind,
  state,
  theme,
  onRetry,
}: {
  kind: PillKind;
  state: PillFreshness;
  theme: PluginHostProps["theme"];
  onRetry(): void;
}) {
  const notice = freshnessNotice(state, kind);
  if (!notice) return null;
  const color = notice.tone === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color, fontSize: 12, flexShrink: 1 }}>{notice.text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Retry ${kind} refresh`}
        onPress={onRetry}
      >
        <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Retry</Text>
      </Pressable>
    </View>
  );
}

export function createHubSidebar(loadSnapshot: () => Promise<HubSnapshot>) {
  const useHubSnapshot = () =>
    useQuery({
      queryKey: HUB_SIDEBAR_QUERY_KEY,
      queryFn: loadSnapshot,
      refetchInterval: HUB_POLL_MS,
    });

  function AvailabilityBanner({
    theme,
    display,
    onRetry,
    openScreen,
  }: {
    theme: PluginHostProps["theme"];
    display: AvailabilityDisplay;
    onRetry(): void;
    openScreen(input: OpenScreenInput): void;
  }) {
    if (!display.showBadge) return null;
    const color =
      display.tone === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
    return (
      <View style={{ gap: 4 }}>
        <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{display.title}</Text>
        {display.detail ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {display.detail}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 12 }}>
          {display.action === "retry" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry OMP probe"
              onPress={onRetry}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                Retry
              </Text>
            </Pressable>
          ) : null}
          {display.action === "open-diagnostics" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open OMP diagnostics"
              onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                Open diagnostics
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  function HubSidebarPopover({ theme, layout, openScreen }: PopoverProps) {
    const snapshot = useHubSnapshot();
    const loadHealth = useRpc(getOmpProviderHealth);
    const health = useQuery({
      queryKey: HUB_AVAILABILITY_QUERY_KEY,
      queryFn: () => loadHealth({}),
      staleTime: HUB_AVAILABILITY_STALE_MS,
    });
    const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
    const availability = health.data ? toAvailabilityDisplay(health.data) : undefined;
    const banner = availability ? (
      <AvailabilityBanner
        theme={theme}
        display={availability}
        onRetry={() => void health.refetch()}
        openScreen={openScreen}
      />
    ) : null;
    if (snapshot.isLoading) return <Text style={muted}>Loading hub processes…</Text>;
    if (!snapshot.data) {
      return (
        <View style={{ gap: layout.compact ? 12 : 14 }}>
          {banner}
          <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
            Could not read omp hub state.
          </Text>
        </View>
      );
    }
    const active = snapshot.data.workspaces.filter(({ processes }) => processes.length > 0);
    const notes = [
      snapshot.data.unreadable > 0
        ? `${snapshot.data.unreadable} workspace(s) could not be read.`
        : undefined,
      snapshot.data.truncated ? "Showing the first 50 workspaces." : undefined,
    ].filter(Boolean);
    return (
      <View style={{ gap: layout.compact ? 12 : 14 }}>
        {banner}
        {notes.map((note) => (
          <Text key={note} style={{ ...muted, fontSize: 12 }}>
            {note}
          </Text>
        ))}
        {active.length === 0 ? <Text style={muted}>No hub-supervised processes.</Text> : null}
        {active.map(({ cwd, processes }) => (
          <View key={cwd} style={{ gap: 6 }}>
            <Text numberOfLines={1} style={{ ...muted, fontSize: 12 }}>
              {cwd}
            </Text>
            <HubProcessList theme={theme} layout={layout} cwd={cwd} processes={processes} />
          </View>
        ))}
      </View>
    );
  }

  function HubSidebarItem({ theme, openPopover }: SidebarItemProps) {
    const snapshot = useHubSnapshot();
    const loadHealth = useRpc(getOmpProviderHealth);
    const health = useQuery({
      queryKey: HUB_AVAILABILITY_QUERY_KEY,
      queryFn: () => loadHealth({}),
      staleTime: HUB_AVAILABILITY_STALE_MS,
    });
    if (!SidebarRow) return null;
    const display = health.data ? toAvailabilityDisplay(health.data) : undefined;
    const availability = availabilityTrailingSuffix(display);
    const state = hubTrailing(snapshot.data, snapshot.error !== null);
    const accessibilityLabel = [availability, state?.accessibilityLabel].filter(Boolean).join(", ");
    const trailing =
      availability || state ? (
        <View
          accessibilityLabel={accessibilityLabel || undefined}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {availability ? (
            <Text
              style={{
                color:
                  display?.tone === "danger"
                    ? theme.colors.statusDanger
                    : theme.colors.statusWarning,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {availability}
            </Text>
          ) : null}
          {state?.running ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {state.running}
            </Text>
          ) : null}
          {state?.failed || state?.unreadable ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
              {[state?.failed, state?.unreadable ? "!" : undefined].filter(Boolean).join(" ")}
            </Text>
          ) : null}
        </View>
      ) : undefined;
    return (
      <SidebarRow
        icon="Activity"
        label="OMP Hub"
        trailing={trailing}
        onPress={() => openPopover(HubSidebarPopover)}
      />
    );
  }

  return { HubSidebarItem, HubSidebarPopover };
}
