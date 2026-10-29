import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { API, getCreds, setCreds } from "@/lib/api";
import { THRESHOLDS } from "@/lib/alerts";

export default function Settings() {
  const c = getCreds();
  const [admin, setAdmin] = useState(c.adminToken); const [key, setKey] = useState(c.apiKey);
  return (
    <View style={s.page}>
      <Text style={s.label}>Gateway address</Text>
      <Text style={s.value}>{API}</Text>
      <Text style={s.help}>Set in app.json → expo.extra.apiUrl. Use the LAN IP of the machine running the gateway, not localhost.</Text>
      <Text style={s.label}>Admin token</Text>
      <TextInput style={s.input} value={admin} secureTextEntry autoCapitalize="none" onChangeText={(v) => { setAdmin(v); setCreds(v, key); }} />
      <Text style={s.label}>API key</Text>
      <TextInput style={s.input} value={key} secureTextEntry autoCapitalize="none" placeholder="rly_…" onChangeText={(v) => { setKey(v); setCreds(admin, v); }} />
      <Text style={s.label}>Alerts</Text>
      <Text style={s.help}>You get a notification when queue pressure passes {THRESHOLDS.queuePressure * 100}%, GPU memory passes {THRESHOLDS.gpuMem * 100}%, or a job lands in the dead-letter queue. Each alert repeats at most once every 5 minutes.</Text>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#e9edf1", padding: 16, gap: 6 },
  label: { color: "#4a5966", fontSize: 13, marginTop: 14 },
  value: { color: "#16232e", fontSize: 15 },
  help: { color: "#7a8794", fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderColor: "#d3dae0", borderRadius: 8, padding: 10, backgroundColor: "#fff" },
});
