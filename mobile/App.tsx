import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import { api, loadMeters, loadUsage, type MeterSummary, type UsageEvent, WEB_APP_URL } from "./src/api";
import { hasNativePushEnabled, readSavedOwner, registerNativePush, unlockOwner, unregisterNativePush } from "./src/native";

const COLORS = {
  background: "#101711",
  surface: "#19231b",
  line: "#2b382d",
  text: "#f0f3e8",
  muted: "#9da99b",
  lime: "#d4f05a",
  orange: "#ffad70",
  red: "#ff8174",
};
const STROOPS_PER_XLM = 10_000_000;
const SHORT_ADDRESS = /^G[A-Z2-7]{55}$/;
const PAYMENT_PLANS = ["Daily", "Weekly", "Monthly", "Usage"] as const;

function formatXlm(value: string | number): string {
  return `${(Number(value) / STROOPS_PER_XLM).toFixed(2)} XLM`;
}

function ActionButton({ title, onPress, secondary = false }: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary]}>
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [owner, setOwner] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [meters, setMeters] = useState<MeterSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageEvent[]>([]);
  const [amount, setAmount] = useState("10");
  const [plan, setPlan] = useState<(typeof PAYMENT_PLANS)[number]>("Usage");
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"energy" | "wallet">("energy");
  const [pushEnabled, setPushEnabled] = useState(false);

  const refresh = useCallback(async (address: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const nextMeters = await loadMeters(address);
      setMeters(nextMeters);
      setSelected((current) => current && nextMeters.some((meter) => meter.meter_id === current)
        ? current : nextMeters[0]?.meter_id ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    readSavedOwner().then(async (saved) => {
      if (!active || !saved) {
        setLoading(false);
        return;
      }
      const hasBiometrics = await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync();
      if (!hasBiometrics) {
        setAddressInput(saved);
        setLoading(false);
        return;
      }
      const unlocked = await unlockOwner(saved);
      if (!active) return;
      if (unlocked) {
        setOwner(saved);
        setPushEnabled(await hasNativePushEnabled());
        await refresh(saved);
      } else {
        setAddressInput(saved);
        setLoading(false);
      }
    }).catch((cause) => {
      if (!active) return;
      setError((cause as Error).message);
      setLoading(false);
    });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!owner) return;
    void refresh(owner);
    const timer = setInterval(() => void refresh(owner), 30_000);
    return () => clearInterval(timer);
  }, [owner, refresh]);

  useEffect(() => {
    if (!selected) {
      setUsage([]);
      return;
    }
    loadUsage(selected).then(setUsage).catch(() => setUsage([]));
  }, [selected]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (typeof data.meterId === "string") setSelected(data.meterId);
      setTab("wallet");
    });
    return () => subscription.remove();
  }, []);

  async function connectAddress() {
    const address = addressInput.trim().toUpperCase();
    if (!SHORT_ADDRESS.test(address)) {
      setError("Enter a valid Stellar public address.");
      return;
    }
    setError(null);
    try {
      const hasBiometrics = await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync();
      if (hasBiometrics) {
        const unlocked = await unlockOwner(address);
        if (!unlocked) return;
      }
      setOwner(address);
      setPushEnabled(await hasNativePushEnabled());
      setLoading(true);
      await refresh(address);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function topUp() {
    if (!selected || !WEB_APP_URL) {
      Alert.alert("Payment handoff unavailable", "Set EXPO_PUBLIC_WEB_APP_URL to your deployed web app.");
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      Alert.alert("Check the amount", "Enter an amount greater than zero.");
      return;
    }
    const url = `${WEB_APP_URL}/pay?meter=${encodeURIComponent(selected)}&amount=${encodeURIComponent(numericAmount)}&plan=${encodeURIComponent(plan)}`;
    await Linking.openURL(url);
  }

  async function enablePush() {
    if (!owner) return;
    try {
      await registerNativePush(owner);
      setPushEnabled(true);
      Alert.alert("Notifications enabled", "Low-balance alerts will be sent to this device.");
    } catch (cause) {
      Alert.alert("Could not enable notifications", (cause as Error).message);
    }
  }

  async function togglePush() {
    if (pushEnabled) {
      try {
        await unregisterNativePush();
        setPushEnabled(false);
      } catch (cause) {
        Alert.alert("Could not disable notifications", (cause as Error).message);
      }
    } else {
      await enablePush();
    }
  }

  function signOut() {
    setOwner(null);
    setMeters([]);
    setUsage([]);
    setAddressInput("");
  }

  const currentMeter = meters.find((meter) => meter.meter_id === selected);
  const lowBalance = meters.filter((meter) => meter.is_low_balance).length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow}>STELLAR SOLAR GRID</Text>
          <Text style={styles.topTitle}>Energy, in view.</Text>
        </View>
        {owner && <Pressable accessibilityRole="button" onPress={signOut}><Text style={styles.signOut}>Lock</Text></Pressable>}
      </View>

      {!owner ? (
        <View style={styles.loginWrap}>
          <View style={styles.orbit}>
            <Text style={styles.orbitIcon}>ϟ</Text>
          </View>
          <Text style={styles.loginTitle}>Your energy account</Text>
          <Text style={styles.bodyMuted}>Use your Stellar public address to view meters and balance. No secret key is requested or stored.</Text>
          <TextInput
            autoCapitalize="characters"
            autoCorrect={false}
            onChangeText={setAddressInput}
            placeholder="G... Stellar public address"
            placeholderTextColor={COLORS.muted}
            style={styles.addressInput}
            value={addressInput}
          />
          {error && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
          <ActionButton title="Unlock dashboard" onPress={() => void connectAddress()} />
          <Text style={styles.loginFoot}>Biometrics protect this device&apos;s local dashboard session.</Text>
        </View>
      ) : (
        <>
          <View style={styles.tabs}>
            <Pressable onPress={() => setTab("energy")} style={[styles.tab, tab === "energy" && styles.tabActive]}><Text style={[styles.tabText, tab === "energy" && styles.tabTextActive}>Energy</Text></Pressable>
            <Pressable onPress={() => setTab("wallet")} style={[styles.tab, tab === "wallet" && styles.tabActive]}><Text style={[styles.tabText, tab === "wallet" && styles.tabTextActive}>Wallet</Text></Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => owner && refresh(owner)} tintColor={COLORS.lime} />}
          >
            {error && <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text>}
            {tab === "energy" ? (
              <>
                <View style={styles.summaryStrip}>
                  <View><Text style={styles.summaryLabel}>CONNECTED METERS</Text><Text style={styles.summaryValue}>{meters.length}</Text></View>
                  <View style={styles.summaryDivider} />
                  <View><Text style={styles.summaryLabel}>NEED ATTENTION</Text><Text style={[styles.summaryValue, lowBalance > 0 && { color: COLORS.orange }]}>{lowBalance}</Text></View>
                  <View style={styles.liveMark}><View style={styles.liveDot} /><Text style={styles.liveText}>LIVE</Text></View>
                </View>

                <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Your meters</Text><Text style={styles.sectionMeta}>30 sec refresh</Text></View>
                {loading ? <ActivityIndicator color={COLORS.lime} style={{ marginTop: 40 }} /> : meters.length === 0 ? (
                  <View style={styles.empty}><Text style={styles.emptyTitle}>No meters found</Text><Text style={styles.bodyMuted}>This Stellar address has no registered meters yet.</Text></View>
                ) : meters.map((meter) => (
                  <Pressable key={meter.meter_id} onPress={() => setSelected(meter.meter_id)} style={[styles.meterRow, selected === meter.meter_id && styles.meterRowSelected]}>
                    <View style={styles.meterIcon}><Text style={styles.meterIconText}>⚡</Text></View>
                    <View style={styles.meterMain}>
                      <Text style={styles.meterName}>{meter.meter_id}</Text>
                      <Text style={[styles.meterStatus, meter.active ? styles.statusOn : styles.statusOff]}>{meter.active ? "Active" : "Inactive"}{meter.is_low_balance ? " · Low balance" : ""}</Text>
                    </View>
                    <Text style={styles.meterBalance}>{formatXlm(meter.balance)}</Text>
                  </Pressable>
                ))}

                {currentMeter && (
                  <>
                    <View style={styles.balanceHero}>
                      <Text style={styles.summaryLabel}>AVAILABLE BALANCE</Text>
                      <Text style={styles.balanceValue}>{formatXlm(currentMeter.balance)}</Text>
                      <Text style={styles.balanceCaption}>{currentMeter.active ? "Powering your meter" : "Meter is currently inactive"}</Text>
                    </View>
                    <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Recent usage</Text><Text style={styles.sectionMeta}>Last 7 events</Text></View>
                    {usage.length === 0 ? <Text style={styles.bodyMuted}>No recent usage events.</Text> : usage.slice(0, 5).map((event, index) => (
                      <View key={`${event.received_at}-${index}`} style={styles.usageRow}>
                        <View><Text style={styles.usageDate}>{new Date(event.received_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}</Text><Text style={styles.usageSub}>Energy draw</Text></View>
                        <Text style={styles.usageAmount}>{(event.units / 1000).toFixed(2)} kWh</Text>
                      </View>
                    ))}
                  </>
                )}
              </>
            ) : (
              <>
                <View style={styles.walletCard}>
                  <Text style={styles.summaryLabel}>STELLAR ACCOUNT</Text>
                  <Text selectable style={styles.walletAddress}>{owner}</Text>
                  <Text style={styles.bodyMuted}>Public address only. Your signing wallet remains in control of transactions.</Text>
                </View>
                <View style={styles.tradeSection}>
                  <Text style={styles.sectionTitle}>Energy top-up</Text>
                  <Text style={styles.bodyMuted}>Choose an amount. Transaction signing continues in the secure web wallet flow.</Text>
                  <View style={styles.planSelector}>
                    {PAYMENT_PLANS.map((option) => (
                      <Pressable key={option} onPress={() => setPlan(option)} style={[styles.planOption, plan === option && styles.planOptionSelected]}>
                        <Text style={[styles.planText, plan === option && styles.planTextSelected]}>{option}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <TextInput keyboardType="decimal-pad" onChangeText={setAmount} style={styles.addressInput} value={amount} />
                  <ActionButton title="Continue to payment" onPress={() => void topUp()} />
                </View>
                <View style={styles.notice}><Text style={styles.noticeMark}>i</Text><Text style={styles.noticeText}>Solar Grid never asks for your secret key. Confirm the meter and amount in your wallet before signing.</Text></View>
                <ActionButton secondary title={pushEnabled ? "Disable low-balance alerts" : "Enable low-balance alerts"} onPress={() => void togglePush()} />
              </>
            )}
          </ScrollView>
          <View style={styles.bottomNav}>
            <Pressable onPress={() => setTab("energy")}><Text style={[styles.navItem, tab === "energy" && styles.navItemActive]}>⌂  Energy</Text></Pressable>
            <Pressable onPress={() => setTab("wallet")}><Text style={[styles.navItem, tab === "wallet" && styles.navItemActive]}>◇  Wallet</Text></Pressable>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  topBar: { paddingHorizontal: 22, paddingVertical: 16, borderBottomWidth: 1, borderColor: COLORS.line, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eyebrow: { color: COLORS.lime, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  topTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", marginTop: 4 },
  signOut: { color: COLORS.muted, fontSize: 13, padding: 8 },
  loginWrap: { flex: 1, justifyContent: "center", paddingHorizontal: 24, paddingBottom: 24 },
  orbit: { height: 74, width: 74, borderRadius: 37, borderColor: COLORS.lime, borderWidth: 1, backgroundColor: "#222d1e", alignItems: "center", justifyContent: "center", marginBottom: 26 },
  orbitIcon: { color: COLORS.lime, fontSize: 38, fontWeight: "600" },
  loginTitle: { color: COLORS.text, fontSize: 28, fontWeight: "700", marginBottom: 9 },
  bodyMuted: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginBottom: 16 },
  addressInput: { backgroundColor: COLORS.surface, color: COLORS.text, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, fontSize: 14, marginVertical: 10 },
  button: { backgroundColor: COLORS.lime, alignItems: "center", justifyContent: "center", minHeight: 50, borderRadius: 12, paddingHorizontal: 18, marginTop: 10 },
  buttonSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: COLORS.line },
  buttonText: { color: COLORS.background, fontWeight: "800", fontSize: 14 },
  buttonTextSecondary: { color: COLORS.text },
  loginFoot: { marginTop: 22, color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  errorText: { color: COLORS.red, fontSize: 13, marginBottom: 8 },
  errorBanner: { color: COLORS.red, borderColor: "#744039", borderWidth: 1, padding: 12, borderRadius: 10, marginBottom: 14 },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: COLORS.line, paddingHorizontal: 20 },
  tab: { paddingVertical: 14, paddingHorizontal: 12, marginRight: 12 },
  tabActive: { borderBottomWidth: 2, borderColor: COLORS.lime },
  tabText: { color: COLORS.muted, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: COLORS.lime },
  content: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32 },
  summaryStrip: { flexDirection: "row", alignItems: "center", gap: 17, paddingVertical: 15, borderBottomWidth: 1, borderColor: COLORS.line, marginBottom: 22 },
  summaryLabel: { color: COLORS.muted, fontSize: 9, fontWeight: "800", letterSpacing: 1.1 },
  summaryValue: { color: COLORS.text, fontSize: 20, fontWeight: "700", marginTop: 5 },
  summaryDivider: { width: 1, height: 35, backgroundColor: COLORS.line },
  liveMark: { marginLeft: "auto", flexDirection: "row", gap: 6, alignItems: "center" },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.lime },
  liveText: { color: COLORS.lime, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  sectionHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, marginTop: 8 },
  sectionTitle: { color: COLORS.text, fontSize: 17, fontWeight: "700" },
  sectionMeta: { color: COLORS.muted, fontSize: 11 },
  meterRow: { flexDirection: "row", alignItems: "center", minHeight: 72, gap: 12, borderBottomWidth: 1, borderColor: COLORS.line, paddingVertical: 12 },
  meterRowSelected: { backgroundColor: COLORS.surface, marginHorizontal: -10, paddingHorizontal: 10, borderRadius: 12, borderBottomColor: "transparent" },
  meterIcon: { height: 38, width: 38, borderRadius: 12, backgroundColor: "#293323", alignItems: "center", justifyContent: "center" },
  meterIconText: { color: COLORS.lime, fontSize: 18 },
  meterMain: { flex: 1, minWidth: 0 },
  meterName: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  meterStatus: { fontSize: 11, marginTop: 5 },
  statusOn: { color: COLORS.lime },
  statusOff: { color: COLORS.muted },
  meterBalance: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  balanceHero: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 20, marginTop: 24, marginBottom: 24, borderLeftWidth: 3, borderLeftColor: COLORS.lime },
  balanceValue: { color: COLORS.text, fontSize: 30, fontWeight: "700", marginTop: 10 },
  balanceCaption: { color: COLORS.muted, fontSize: 12, marginTop: 5 },
  usageRow: { minHeight: 54, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderColor: COLORS.line },
  usageDate: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  usageSub: { color: COLORS.muted, fontSize: 11, marginTop: 4 },
  usageAmount: { color: COLORS.lime, fontSize: 13, fontWeight: "700" },
  empty: { paddingVertical: 28 },
  emptyTitle: { color: COLORS.text, fontWeight: "700", fontSize: 16, marginBottom: 8 },
  walletCard: { padding: 18, borderWidth: 1, borderColor: COLORS.line, borderRadius: 14, backgroundColor: COLORS.surface, marginBottom: 26 },
  walletAddress: { color: COLORS.text, fontSize: 13, lineHeight: 20, marginVertical: 12 },
  tradeSection: { marginBottom: 24 },
  planSelector: { flexDirection: "row", gap: 7, marginTop: 12 },
  planOption: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line },
  planOptionSelected: { borderColor: COLORS.lime, backgroundColor: "#293323" },
  planText: { color: COLORS.muted, fontSize: 11, fontWeight: "600" },
  planTextSelected: { color: COLORS.lime },
  notice: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: "#43502e", backgroundColor: "#20291d", marginVertical: 18 },
  noticeMark: { color: COLORS.lime, fontWeight: "800" },
  noticeText: { color: COLORS.muted, fontSize: 12, lineHeight: 18, flex: 1 },
  bottomNav: { borderTopWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.background, flexDirection: "row", justifyContent: "space-around", paddingVertical: 14 },
  navItem: { color: COLORS.muted, fontSize: 13, fontWeight: "600" },
  navItemActive: { color: COLORS.lime },
});