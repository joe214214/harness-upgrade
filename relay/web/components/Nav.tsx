"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { adminToken, apiKey, setAdminToken, setApiKey } from "@/lib/api";

const links = [
  ["/", "Overview"], ["/keys", "API keys"], ["/requests", "Requests"], ["/chat", "Chat"], ["/transcribe", "Transcribe"],
] as const;

export function Nav() {
  const path = usePathname();
  const [admin, setAdmin] = useState(""); const [key, setKey] = useState("");
  useEffect(() => { setAdmin(adminToken()); setKey(apiKey()); }, []);
  return (
    <nav className="nav">
      <div className="brand">Relay <small>gateway console</small></div>
      {links.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>
      ))}
      <div className="spacer" />
      <label className="readout">Admin token
        <input type="password" value={admin} placeholder="RELAY_ADMIN_TOKEN" style={{ width: "100%", marginTop: 4 }}
          onChange={(e) => { setAdmin(e.target.value); setAdminToken(e.target.value); }} />
      </label>
      <label className="readout" style={{ marginTop: 10 }}>API key (for Chat / Transcribe)
        <input type="password" value={key} placeholder="rly_…" style={{ width: "100%", marginTop: 4 }}
          onChange={(e) => { setKey(e.target.value); setApiKey(e.target.value); }} />
      </label>
    </nav>
  );
}
