"use client";
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import MeterMap, { type MeterMapPoint } from "@/components/MeterMap";
import { env } from "@/lib/env";

export default function ProviderMapPage() {
  const [points, setPoints] = useState<MeterMapPoint[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/meters/map`).then((res) => res.ok ? res.json() : Promise.reject(new Error("Unable to load meter locations"))).then((data) => setPoints(data.points ?? [])).catch((reason: Error) => setError(reason.message)); }, []);
  return <><Navbar /><main className="mx-auto min-h-screen max-w-6xl px-4 py-8"><h1 className="mb-2 text-2xl font-bold text-solar-yellow">Meter network map</h1><p className="mb-6 text-sm text-gray-400">Explore meter status and usage density by geographic region and provider.</p>{error ? <p role="alert" className="text-red-400">{error}</p> : <MeterMap points={points} />}</main></>;
}
