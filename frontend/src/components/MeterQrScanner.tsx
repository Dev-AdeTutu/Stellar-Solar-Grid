"use client";

import { useEffect, useRef, useState } from "react";

type MeterQrPayload = {
  version: number;
  type: "stellar-solar-grid-meter";
  meter_id: string;
  owner: string;
  metadata?: Record<string, unknown>;
};

function parsePayload(raw: string): MeterQrPayload {
  const value = JSON.parse(raw) as MeterQrPayload;
  if (value.type !== "stellar-solar-grid-meter" || !value.meter_id || !value.owner) {
    throw new Error("This QR code is not a SolarGrid meter code");
  }
  if (!/^G[A-Z2-7]{55}$/.test(value.owner)) throw new Error("The QR code contains an invalid owner address");
  return value;
}

export default function MeterQrScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [payload, setPayload] = useState<MeterQrPayload | null>(null);
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!scanning || !videoRef.current || !("BarcodeDetector" in window)) return;
    let active = true;
    let stream: MediaStream | undefined;
    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const Detector = (window as unknown as { BarcodeDetector: new (opts?: { formats: string[] }) => { detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
        const detector = new Detector({ formats: ["qr_code"] });
        while (active) {
          const found = await detector.detect(videoRef.current);
          if (found[0]?.rawValue) {
            setPayload(parsePayload(found[0].rawValue));
            setError("");
            setScanning(false);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to access the camera");
      }
    };
    void run();
    return () => {
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning]);

  function applyManual() {
    try {
      setPayload(parsePayload(manual));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid QR payload");
    }
  }

  return (
    <section className="mx-auto max-w-xl space-y-5 rounded-2xl border border-white/10 bg-solar-accent p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Install a meter</h1>
        <p className="mt-1 text-sm text-gray-400">Scan the technician QR code to validate and fill the registration form.</p>
      </div>
      <video ref={videoRef} className="aspect-video w-full rounded-xl bg-black object-cover" muted playsInline aria-label="QR scanner camera" />
      <button type="button" onClick={() => { setError(""); setScanning(true); }} className="w-full rounded-lg bg-solar-yellow px-4 py-3 font-semibold text-solar-dark">
        {scanning ? "Scanning…" : "Start camera scanner"}
      </button>
      <div className="border-t border-white/10 pt-4">
        <label className="text-sm text-gray-300">Fallback: paste QR JSON</label>
        <textarea value={manual} onChange={(event) => setManual(event.target.value)} rows={4} className="mt-2 w-full rounded-lg border border-white/10 bg-solar-dark p-3 text-xs text-white" placeholder='{"type":"stellar-solar-grid-meter",...}' />
        <button type="button" onClick={applyManual} className="mt-2 rounded-lg border border-white/20 px-4 py-2 text-sm text-white">Validate code</button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {payload && (
        <form className="space-y-3 rounded-xl border border-green-500/30 bg-green-500/5 p-4" onSubmit={(event) => event.preventDefault()}>
          <h2 className="font-semibold text-green-300">Registration details validated</h2>
          <label className="block text-sm text-gray-300">Meter ID<input readOnly value={payload.meter_id} className="mt-1 w-full rounded border border-white/10 bg-solar-dark p-2 text-white" /></label>
          <label className="block text-sm text-gray-300">Owner<input readOnly value={payload.owner} className="mt-1 w-full rounded border border-white/10 bg-solar-dark p-2 font-mono text-xs text-white" /></label>
          <p className="text-xs text-gray-400">The validated values are ready for the authenticated registration transaction.</p>
        </form>
      )}
    </section>
  );
}
