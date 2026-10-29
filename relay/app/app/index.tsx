import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { fetchStatus, type Status } from "@/lib/api";
import { evaluate } from "@/lib/alerts";
import { Pipe } from "@/components/Pipe";

function Readout({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <View style={s.card}>
      <Text style={s.cardLabel}>{label}</Text>
      <Text style={s.cardValue}>{value}<Text style={s.cardUnit}>{unit ? ` ${unit}` : ""}</Text></Text>
    </View>
  );
}

export default function Dashboard() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try { const s = await fetchStatus(); setSt(s); setErr(null); await evaluate(s); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);

  const total = st ? Object.values(st.last_5m.by_status).reduce((a, b) => a + b, 0) : 0;
  const ok = st?.last_5m.by_status.succeeded ?? 0;

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {err && <Text style={s.err}>Can&apos;t reach the gateway ({err}). Check the API address and admin token in Settings.</Text>}
      {st && (
        <>
          <Pipe depth={st.queue.depth} max={st.queue.max_depth} />
          <View style={s.row}>
            <Readout label="Requests, 5 min" value={total} />
            <Readout label="Succeeded" value={total ? Math.round(ok / total * 100) : 0} unit="%" />
          </View>
          <View style={s.row}>
            <Readout label="Time to first token" value={st.last_5m.avg_ttft_ms ?? "–"} unit="ms" />
            <Readout label="Inference" value={st.last_5m.avg_inference_ms ?? "–"} unit="ms" />
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>GPU</Text>
            {st.gpu ? (
              <Text style={s.body}>{st.gpu.name}: {st.gpu.mem_used_gb} / {st.gpu.mem_total_gb} GB, {Math.round(st.gpu.util * 100)}% busy</Text>
            ) : (
              <Text style={s.muted}>Not visible from the gateway host. Plan: {st.profile.profile}, {st.profile.total_gb} / {st.profile.capacity_gb} GB.</Text>
            )}
          </View>
          <Text style={s.muted}>Backend {st.backend} · dead letters {st.queue.dead_letters} · refreshes every 5 s</Text>
        </>
      )}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#e9edf1" },
  row: { flexDirection: "row", gap: 12 },
  card: { flex: 1, backgroundColor: "#fff", borderRadius: 8, padding: 14, borderWidth: 1, borderColor: "#d3dae0" },
  cardLabel: { color: "#4a5966", fontSize: 13 },
  cardValue: { fontSize: 22, fontWeight: "500", color: "#16232e", marginTop: 2, fontVariant: ["tabular-nums"] },
  cardUnit: { fontSize: 13, color: "#7a8794", fontWeight: "400" },
  body: { color: "#16232e", marginTop: 4 },
  muted: { color: "#7a8794", fontSize: 13, marginTop: 4 },
  err: { backgroundColor: "#f7e3da", color: "#16232e", padding: 12, borderRadius: 8 },
});
