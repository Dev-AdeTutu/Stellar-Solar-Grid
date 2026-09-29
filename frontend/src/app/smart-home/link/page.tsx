"use client";

/**
 * Account-linking consent page (#904). Google Home / Alexa send the user
 * here (via /api/smart-home/oauth/authorize). The owner signs in with their
 * wallet, picks which meters to share and whether the assistant may switch
 * them, and is then redirected back to the assistant app.
 */
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";
import { getSmartHomeSession, smartHomeFetch } from "@/lib/smartHomeClient";

type MeterRow = { meterId: string; nickname: string };

const PLATFORM_NAME: Record<string, string> = { google: "Google Home", alexa: "Amazon Alexa" };

export default function SmartHomeLinkPage() {
  const { address, connect, signTransaction } = useWalletStore();
  const storedMeter = usePaymentStore((s) => s.meterId);
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [meters, setMeters] = useState<MeterRow[]>([{ meterId: "", nickname: "" }]);
  const [allowControl, setAllowControl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
  }, []);

  useEffect(() => {
    if (storedMeter) setMeters((m) => (m.length === 1 && !m[0].meterId ? [{ meterId: storedMeter, nickname: "" }] : m));
  }, [storedMeter]);

  const clientId = params?.get("client_id") ?? "";
  const redirectUri = params?.get("redirect_uri") ?? "";
  const state = params?.get("state") ?? "";
  const platform = PLATFORM_NAME[params?.get("platform") ?? ""] ?? "your voice assistant";

  function cancel() {
    if (!redirectUri) return;
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function authorize() {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getSmartHomeSession(address, signTransaction);
      const selected = meters.filter((m) => m.meterId.trim()).map((m) => ({ meterId: m.meterId.trim(), nickname: m.nickname.trim() || undefined }));
      const { redirectUrl } = await smartHomeFetch<{ redirectUrl: string }>(token, "/oauth/consent", {
        method: "POST",
        body: JSON.stringify({ clientId, redirectUri, state, meters: selected, scopes: allowControl ? ["read", "control"] : ["read"] }),
      });
      window.location.href = redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (params && (!clientId || !redirectUri)) {
    return (
      <>
        <Navbar />
        <main className="p-6 max-w-xl mx-auto">
          <p>This page is opened from the Google Home or Alexa app when you link SolarGrid.</p>
        </main>
      </>
    );
  }

  const valid = meters.some((m) => m.meterId.trim());

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Link SolarGrid to {platform}</h1>

        {!address ? (
          <>
            <p className="mb-4 opacity-80">Connect the wallet that owns your meters to continue.</p>
            <button className="rounded bg-sky-600 px-4 py-2 text-white" onClick={() => connect()}>
              Connect wallet
            </button>
          </>
        ) : (
          <>
            <h2 className="font-semibold mt-4 mb-2">Meters to share</h2>
            <p className="text-sm opacity-70 mb-3">The nickname is what you&apos;ll say, e.g. &ldquo;turn off the shop meter&rdquo;.</p>
            <div className="space-y-2 mb-3">
              {meters.map((m, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    aria-label={`Meter ${i + 1} ID`}
                    className="flex-1 rounded border px-2 py-1 bg-transparent"
                    placeholder="Meter ID"
                    value={m.meterId}
                    onChange={(e) => setMeters((all) => all.map((x, j) => (j === i ? { ...x, meterId: e.target.value } : x)))}
                  />
                  <input
                    aria-label={`Meter ${i + 1} nickname`}
                    className="flex-1 rounded border px-2 py-1 bg-transparent"
                    placeholder="Nickname (optional)"
                    maxLength={40}
                    value={m.nickname}
                    onChange={(e) => setMeters((all) => all.map((x, j) => (j === i ? { ...x, nickname: e.target.value } : x)))}
                  />
                  {meters.length > 1 && (
                    <button aria-label="Remove meter" className="px-2" onClick={() => setMeters((all) => all.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="text-sm underline mb-6" onClick={() => setMeters((all) => [...all, { meterId: "", nickname: "" }])}>
              + Add another meter
            </button>

            <label className="flex items-start gap-2 mb-6">
              <input type="checkbox" className="mt-1" checked={allowControl} onChange={(e) => setAllowControl(e.target.checked)} />
              <span>
                Allow {platform} to turn these meters on and off and run my energy routines.
                <span className="block text-xs opacity-70">Leave unchecked to only allow checking status and balance.</span>
              </span>
            </label>

            <div className="rounded border border-white/10 p-3 text-sm mb-6">
              <p className="font-semibold mb-1">What {platform} will receive</p>
              <ul className="list-disc ml-5 opacity-80 space-y-1">
                <li>The meter nicknames (or IDs) you enter above</li>
                <li>Whether each meter is on, and its credit balance when you ask for it</li>
              </ul>
              <p className="mt-2 opacity-80">
                Your wallet address and usage history are not shared. Voice commands are logged for 30 days so you can review
                them, and you can unlink or delete everything at any time from the Smart Home page.
              </p>
            </div>

            {error && <p className="text-red-500 mb-4">{error}</p>}
            <div className="flex gap-3">
              <button className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50" disabled={!valid || busy} onClick={authorize}>
                {busy ? "Waiting for signature…" : "Sign & authorize"}
              </button>
              <button className="rounded border px-4 py-2" onClick={cancel} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
