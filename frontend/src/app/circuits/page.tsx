import React from "react";
import Navbar from "@/components/Navbar";
import CircuitManagement from "@/components/CircuitManagement";

export default function CircuitsPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Circuit Management & Load Shedding
          </h1>
          <p className="text-slate-400 mt-2">
            Configure smart meter sub-circuit priorities, shed non-essential loads when prepaid balances drop, and command IoT relays.
          </p>
        </div>

        <CircuitManagement />
      </main>
    </div>
  );
}
