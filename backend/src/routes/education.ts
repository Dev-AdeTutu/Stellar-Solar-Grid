import { Router } from "express";

export const educationRouter = Router();

export interface Module {
  id: string;
  title: Record<string, string>;
  lesson: Record<string, string>;
  quiz: { q: Record<string, string>; options: string[]; answer: number }[];
  badge: string;
}

export const MODULES: Module[] = [
  {
    id: "solar",
    title: { en: "Solar Basics", fr: "Bases du solaire", es: "Conceptos solares" },
    lesson: {
      en: "Solar panels convert sunlight into electricity. Output depends on sun hours, angle and panel capacity (kW).",
      fr: "Les panneaux solaires convertissent la lumière en électricité.",
      es: "Los paneles solares convierten la luz solar en electricidad.",
    },
    quiz: [{ q: { en: "What unit measures panel capacity?", fr: "Quelle unité mesure la capacité ?", es: "¿Qué unidad mide la capacidad?" }, options: ["kW", "kWh", "V"], answer: 0 }],
    badge: "☀️ Sun Starter",
  },
  {
    id: "efficiency",
    title: { en: "Energy Efficiency", fr: "Efficacité énergétique", es: "Eficiencia energética" },
    lesson: {
      en: "kWh measures energy used over time. LED bulbs use ~75% less energy than incandescent bulbs.",
      fr: "Le kWh mesure l'énergie consommée dans le temps.",
      es: "El kWh mide la energía usada en el tiempo.",
    },
    quiz: [{ q: { en: "A 100W bulb on for 10h uses?", fr: "Ampoule 100W pendant 10h ?", es: "¿Bombilla de 100W por 10h?" }, options: ["1 kWh", "10 kWh", "0.1 kWh"], answer: 0 }],
    badge: "💡 Efficiency Pro",
  },
  {
    id: "grid",
    title: { en: "The Grid", fr: "Le réseau", es: "La red" },
    lesson: {
      en: "Mini-grids distribute power from shared solar arrays to many homes. Pay-as-you-go meters keep it fair.",
      fr: "Les mini-réseaux distribuent l'énergie solaire partagée.",
      es: "Las minirredes distribuyen energía solar compartida.",
    },
    quiz: [{ q: { en: "What keeps mini-grid billing fair?", fr: "Qu'est-ce qui rend la facturation équitable ?", es: "¿Qué hace justa la facturación?" }, options: ["Smart meters", "Guessing", "Flat fees"], answer: 0 }],
    badge: "🔌 Grid Guru",
  },
];

const progress = new Map<string, Record<string, number>>();

educationRouter.get("/modules", (_req, res) => res.json(MODULES));

/** POST /api/education/:userId/:moduleId/submit  body: { answers: number[] } */
educationRouter.post("/:userId/:moduleId/submit", (req, res) => {
  const mod = MODULES.find((m) => m.id === req.params.moduleId);
  if (!mod) return res.status(404).json({ error: "Module not found" });
  const answers: number[] = req.body.answers ?? [];
  const score = mod.quiz.filter((q, i) => answers[i] === q.answer).length / mod.quiz.length;
  const p = progress.get(req.params.userId) ?? {};
  p[mod.id] = Math.max(p[mod.id] ?? 0, score);
  progress.set(req.params.userId, p);
  res.json({ score, passed: score >= 0.7, badge: score >= 0.7 ? mod.badge : null });
});

educationRouter.get("/:userId/progress", (req, res) => {
  const p = progress.get(req.params.userId) ?? {};
  const completed = MODULES.filter((m) => (p[m.id] ?? 0) >= 0.7);
  res.json({
    progress: p,
    badges: completed.map((m) => m.badge),
    certificate: completed.length === MODULES.length ? { userId: req.params.userId, issuedAt: new Date().toISOString(), title: "Energy Literacy Certificate" } : null,
  });
});
