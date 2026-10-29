import { StyleSheet, Text, View } from "react-native";

/** 和 web 控制台同一个隐喻：一条管子，填充比例就是队列压力。 */
export function Pipe({ depth, max }: { depth: number; max: number }) {
  const pct = Math.min(1, max ? depth / max : 0);
  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Text style={s.label}>Queue pressure</Text>
        <Text style={s.read}>{depth}<Text style={s.sub}> of {max}</Text></Text>
      </View>
      <View style={s.track}><View style={[s.fill, { width: `${pct * 100}%` }, pct > 0.8 && s.warn]} /></View>
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { backgroundColor: "#fff", borderRadius: 8, padding: 16, borderWidth: 1, borderColor: "#d3dae0" },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 },
  label: { color: "#16232e", fontSize: 15 },
  read: { fontSize: 26, fontVariant: ["tabular-nums"], color: "#16232e", fontWeight: "500" },
  sub: { fontSize: 13, color: "#7a8794", fontWeight: "400" },
  track: { height: 14, backgroundColor: "#f3f6f8", borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: "#0e7c9e" },
  warn: { backgroundColor: "#c2542d" },
});
