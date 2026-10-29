"use client";
import { useEffect, useState } from "react";
import { admin, type KeyInfo } from "@/lib/api";

export default function Keys() {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [name, setName] = useState("my-app"); const [rpm, setRpm] = useState(60); const [tpm, setTpm] = useState(60000);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => admin<KeyInfo[]>("/keys").then(setKeys).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const r = await admin<{ key: string; name: string }>("/keys", { method: "POST", body: JSON.stringify({ name, rpm_limit: rpm, tpm_limit: tpm }) });
      setCreated(r); setErr(null); load();
    } catch (e: any) { setErr(e.message); }
  };
  const revoke = async (id: string) => { if (!confirm("Revoke this key? Requests using it will start failing immediately.")) return; await admin(`/keys/${id}`, { method: "DELETE" }); load(); };

  return (
    <>
      <h1>API keys</h1>
      <p className="lede">Each key carries its own rate limits. The full key is shown once, when it&apos;s created; only its prefix is stored after that.</p>
      {err && <div className="note warn" style={{ marginBottom: 16 }}>{err}</div>}
      <div className="panel" style={{ marginBottom: 20 }}>
        <h2>Create a key</h2>
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <label className="readout">Requests / min <input type="number" value={rpm} onChange={(e) => setRpm(+e.target.value)} style={{ width: 90, marginLeft: 6 }} /></label>
          <label className="readout">Tokens / min <input type="number" value={tpm} onChange={(e) => setTpm(+e.target.value)} style={{ width: 110, marginLeft: 6 }} /></label>
          <button className="btn" onClick={create}>Create key</button>
        </div>
        {created && (
          <div className="note" style={{ marginTop: 14 }}>
            Key for <b>{created.name}</b> — copy it now, it won&apos;t be shown again:<br />
            <code className="mono" style={{ userSelect: "all" }}>{created.key}</code>
          </div>
        )}
      </div>
      <div className="panel">
        {keys.length === 0 ? <p className="empty">No keys yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th className="num">RPM</th><th className="num">TPM</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td><td className="mono">{k.prefix}…</td>
                <td className="num">{k.rpm_limit}</td><td className="num">{k.tpm_limit.toLocaleString()}</td>
                <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                <td><span className={`tag ${k.revoked ? "bad" : "ok"}`}>{k.revoked ? "revoked" : "active"}</span></td>
                <td>{!k.revoked && <button className="btn danger" onClick={() => revoke(k.id)}>Revoke</button>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
