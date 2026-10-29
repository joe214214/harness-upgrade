import { useState } from "react";
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import { chatOnce, speakToFile, type Part } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string; image?: string; meta?: string };

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]); const [input, setInput] = useState(""); const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);   // data URL

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.7 });
    if (!res.canceled && res.assets[0].base64) setImage(`data:${res.assets[0].mimeType ?? "image/jpeg"};base64,${res.assets[0].base64}`);
  };
  const play = async (text: string) => {
    try {
      const { uri } = await speakToFile(text);
      const { sound } = await Audio.Sound.createAsync({ uri });
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((st) => { if (st.isLoaded && st.didJustFinish) sound.unloadAsync(); });
    } catch {}
  };
  const toParts = (m: Msg): string | Part[] =>
    m.image ? [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: m.image } }] : m.content;

  const send = async () => {
    const text = input.trim(); if ((!text && !image) || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: text || "(image)", image: image ?? undefined }];
    setMsgs(history); setInput(""); setImage(null); setBusy(true);
    try {
      const { text: reply, relay } = await chatOnce(history.map((m) => ({ role: m.role, content: toParts(m) })));
      setMsgs([...history, { role: "assistant", content: reply, meta: `TTFT ${relay.ttft_ms} ms · queued ${relay.queue_wait_ms} ms · ${relay.inference_ms} ms total` }]);
    } catch (e: any) { setMsgs([...history, { role: "assistant", content: `Request failed: ${e.message}` }]); }
    finally { setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <FlatList data={msgs} keyExtractor={(_, i) => String(i)} contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Text style={s.muted}>Send a message. Put an API key in Settings first.</Text>}
        renderItem={({ item }) => (
          <View style={[s.msg, item.role === "user" ? s.user : s.assistant]}>
            {item.image && <Image source={{ uri: item.image }} style={s.thumb} />}
            <Text style={s.text}>{item.content}</Text>
            {item.meta && <Text style={s.meta}>{item.meta}</Text>}
            {item.role === "assistant" && !item.content.startsWith("Request failed") && (
              <Pressable onPress={() => play(item.content)} hitSlop={8}><Text style={s.play}>▶ Read aloud</Text></Pressable>
            )}
          </View>
        )} />
      {image && <View style={s.pendingRow}><Image source={{ uri: image }} style={s.thumb} /><Pressable onPress={() => setImage(null)}><Text style={s.play}>Remove</Text></Pressable></View>}
      <View style={s.inputRow}>
        <Pressable style={s.btnQuiet} onPress={pick} disabled={busy}><Text style={s.btnQuietText}>＋</Text></Pressable>
        <TextInput style={s.input} value={input} onChangeText={setInput} placeholder={image ? "Ask about the photo…" : "Message…"} editable={!busy} onSubmitEditing={send} returnKeyType="send" />
        <Pressable style={[s.btn, (busy || (!input.trim() && !image)) && s.btnOff]} onPress={send} disabled={busy || (!input.trim() && !image)}>
          <Text style={s.btnText}>{busy ? "…" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#e9edf1" },
  msg: { maxWidth: "85%", padding: 12, borderRadius: 12 },
  user: { alignSelf: "flex-end", backgroundColor: "#d6ecf2", borderBottomRightRadius: 2 },
  assistant: { alignSelf: "flex-start", backgroundColor: "#fff", borderWidth: 1, borderColor: "#d3dae0" },
  text: { color: "#16232e", lineHeight: 21 },
  meta: { color: "#7a8794", fontSize: 11, marginTop: 6, fontVariant: ["tabular-nums"] },
  muted: { color: "#7a8794", textAlign: "center", marginTop: 40 },
  inputRow: { flexDirection: "row", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: "#d3dae0", backgroundColor: "#fff" },
  input: { flex: 1, borderWidth: 1, borderColor: "#d3dae0", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#fff" },
  btn: { backgroundColor: "#0e7c9e", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  btnOff: { opacity: 0.5 },
  btnText: { color: "#fff", fontWeight: "500" },
  btnQuiet: { borderWidth: 1, borderColor: "#d3dae0", borderRadius: 8, paddingHorizontal: 12, justifyContent: "center", backgroundColor: "#f3f6f8" },
  btnQuietText: { color: "#16232e", fontSize: 18 },
  thumb: { width: 120, height: 90, borderRadius: 6, marginBottom: 6, backgroundColor: "#f3f6f8" },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: "#d3dae0" },
  play: { color: "#0e7c9e", fontSize: 12, marginTop: 6 },
});
