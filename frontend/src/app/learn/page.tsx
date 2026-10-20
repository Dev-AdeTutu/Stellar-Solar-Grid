"use client";

import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";

type Lang = "en" | "fr" | "es";
interface Module {
  id: string;
  title: Record<Lang, string>;
  lesson: Record<Lang, string>;
  quiz: { q: Record<Lang, string>; options: string[]; answer: number }[];
  badge: string;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function LearnPage() {
  const { address } = useWalletStore();
  const userId = address ?? "guest";
  const [lang, setLang] = useState<Lang>("en");
  const [modules, setModules] = useState<Module[]>([]);
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [badges, setBadges] = useState<string[]>([]);
  const [certificate, setCertificate] = useState<{ issuedAt: string } | null>(null);
  const [kw, setKw] = useState(1);
  const [hours, setHours] = useState(5);

  const loadProgress = () =>
    fetch(`${API}/api/education/${userId}/progress`).then((r) => r.json()).then((d) => {
      setBadges(d.badges);
      setCertificate(d.certificate);
    });

  useEffect(() => {
    fetch(`${API}/api/education/modules`).then((r) => r.json()).then(setModules).catch(() => {});
    loadProgress().catch(() => {});
  }, [userId]);

  const submit = async (id: string) => {
    await fetch(`${API}/api/education/${userId}/${id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: answers[id] ?? [] }),
    });
    loadProgress();
  };

  return (
    <main className="min-h-screen">
      <Navbar />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">Energy Literacy</h1>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="border rounded px-2 py-1 text-black">
            <option value="en">English</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
          </select>
        </div>

        <p>Badges: {badges.length ? badges.join(" ") : "none yet"}</p>
        {certificate && (
          <div className="border-2 border-yellow-400 rounded p-4 text-center">
            🎓 Energy Literacy Certificate — issued {new Date(certificate.issuedAt).toLocaleDateString()}
          </div>
        )}

        <section className="border rounded p-4">
          <h2 className="font-semibold mb-2">Solar Simulator</h2>
          <label className="block text-sm">Panel size: {kw} kW
            <input type="range" min={0.5} max={10} step={0.5} value={kw} onChange={(e) => setKw(+e.target.value)} className="w-full" />
          </label>
          <label className="block text-sm">Sun hours/day: {hours}
            <input type="range" min={1} max={10} value={hours} onChange={(e) => setHours(+e.target.value)} className="w-full" />
          </label>
          <p className="mt-2">≈ <strong>{(kw * hours * 0.8).toFixed(1)} kWh/day</strong> (80% system efficiency)</p>
        </section>

        {modules.map((m) => (
          <section key={m.id} className="border rounded p-4 space-y-2">
            <h2 className="font-semibold">{m.title[lang]} {badges.includes(m.badge) && "✅"}</h2>
            <p className="text-sm">{m.lesson[lang]}</p>
            {m.quiz.map((q, qi) => (
              <div key={qi}>
                <p className="text-sm font-medium">{q.q[lang]}</p>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((o, oi) => (
                    <button
                      key={oi}
                      onClick={() => setAnswers((a) => { const arr = [...(a[m.id] ?? [])]; arr[qi] = oi; return { ...a, [m.id]: arr }; })}
                      className={`px-3 py-1 rounded border ${answers[m.id]?.[qi] === oi ? "bg-yellow-400 text-black" : ""}`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={() => submit(m.id)} className="px-4 py-2 rounded bg-yellow-500 text-black">Submit</button>
          </section>
        ))}
      </div>
    </main>
  );
}
