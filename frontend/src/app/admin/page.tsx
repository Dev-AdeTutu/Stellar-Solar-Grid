"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!sessionStorage.getItem("admin_token")) {
      router.replace("/admin/login");
    } else {
      setReady(true);
    }
  }, [router]);

  function handleLogout() {
    sessionStorage.removeItem("admin_token");
    router.replace("/admin/login");
  }

  if (!ready) return null;

  return (
    <>
      <Navbar />
      <main className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-16 gap-8">
        <div className="w-full max-w-2xl">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-solar-yellow">Admin Dashboard</h1>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded-lg px-3 py-1.5 transition"
            >
              Sign Out
            </button>
          </div>
          <p className="text-gray-400 text-sm">
            You are authenticated. Admin actions are available here.
          </p>
        </div>
      </main>
    </>
  );
}
