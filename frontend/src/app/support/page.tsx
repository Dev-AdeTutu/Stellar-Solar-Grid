"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";
import { getSmartHomeSession } from "@/lib/smartHomeClient";
import { useWalletStore } from "@/store/walletStore";

const API = env.NEXT_PUBLIC_BACKEND_URL;
type Ticket = {
  id: number;
  user: string;
  userEmail: string | null;
  subject: string;
  description: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  createdAt: string;
  updatedAt: string;
};

const statusLabels: Record<Ticket["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export default function SupportPage() {
  const address = useWalletStore((state) => state.address);
  const signTransaction = useWalletStore((state) => state.signTransaction);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [priority, setPriority] = useState<Ticket["priority"]>("normal");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (path: string, init: RequestInit = {}) => {
    if (!address) throw new Error("Connect your wallet to contact support.");
    const token = await getSmartHomeSession(address, signTransaction);
    const response = await fetch(`${API}/api/tickets${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body as { tickets?: Ticket[]; ticket?: Ticket };
  }, [address, signTransaction]);

  const loadTickets = useCallback(async () => {
    if (!address) {
      setTickets([]);
      return;
    }
    const result = await call("");
    setTickets(result.tickets ?? []);
  }, [address, call]);

  useEffect(() => {
    loadTickets().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load tickets"));
  }, [loadTickets]);

  async function submitTicket(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await call("", { method: "POST", body: JSON.stringify({ subject, description, email: email || undefined, priority }) });
      setSubject("");
      setDescription("");
      setMessage("Your support request was submitted. We will keep you updated by email.");
      await loadTickets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to submit ticket");
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(id: number, status: Ticket["status"]) {
    setError(null);
    try {
      await call(`/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadTickets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update ticket");
    }
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-solar-dark px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-solar-yellow">Customer care</p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">How can we help?</h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">Report a meter issue, ask a billing question, or request help from the SolarGrid support team.</p>
          </div>
          {!address && <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">Connect your wallet above to create and view support tickets.</div>}
          {message && <div role="status" className="mb-6 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-200">{message}</div>}
          {error && <div role="alert" className="mb-6 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">{error}</div>}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
            <section className="rounded-2xl border border-white/10 bg-solar-accent p-5 shadow-xl">
              <h2 className="text-xl font-semibold">Open a ticket</h2>
              <p className="mt-1 text-sm text-slate-400">Include enough detail for us to investigate quickly.</p>
              <form onSubmit={submitTicket} className="mt-6 space-y-4">
                <label className="block text-sm font-medium text-slate-200">Subject<input required maxLength={160} value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-solar-dark px-3 py-2.5 text-sm outline-none focus:border-solar-yellow" placeholder="e.g. Meter stopped reporting" /></label>
                <label className="block text-sm font-medium text-slate-200">Description<textarea required minLength={10} maxLength={10000} value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2 min-h-32 w-full rounded-lg border border-white/10 bg-solar-dark px-3 py-2.5 text-sm outline-none focus:border-solar-yellow" placeholder="What happened, and when?" /></label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-200">Priority<select value={priority} onChange={(event) => setPriority(event.target.value as Ticket["priority"])} className="mt-2 w-full rounded-lg border border-white/10 bg-solar-dark px-3 py-2.5 text-sm outline-none focus:border-solar-yellow"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
                  <label className="block text-sm font-medium text-slate-200">Email for updates<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-solar-dark px-3 py-2.5 text-sm outline-none focus:border-solar-yellow" placeholder="you@example.com" /></label>
                </div>
                <button disabled={!address || busy} className="w-full rounded-lg bg-solar-yellow px-4 py-3 text-sm font-bold text-solar-dark transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Submitting…" : "Submit ticket"}</button>
              </form>
            </section>
            <section>
              <div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-semibold">Your tickets</h2><span className="text-xs text-slate-500">{tickets.length} total</span></div>
              {tickets.length === 0 ? <div className="rounded-2xl border border-dashed border-white/15 bg-solar-accent/50 p-8 text-center text-sm text-slate-400">No tickets yet. We are here when you need us.</div> : <div className="space-y-3">{tickets.map((ticket) => <article key={ticket.id} className="rounded-2xl border border-white/10 bg-solar-accent p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-slate-500">Ticket #{ticket.id} · {new Date(ticket.createdAt).toLocaleDateString()}</p><h3 className="mt-1 font-semibold">{ticket.subject}</h3></div><div className="flex items-center gap-2"><span className="rounded-full border border-solar-yellow/30 bg-solar-yellow/10 px-2.5 py-1 text-xs font-semibold text-solar-yellow">{ticket.priority}</span><span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-slate-300">{statusLabels[ticket.status]}</span></div></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-400">{ticket.description}</p><div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3"><label className="text-xs text-slate-500" htmlFor={`status-${ticket.id}`}>Update status</label><select id={`status-${ticket.id}`} value={ticket.status} onChange={(event) => updateStatus(ticket.id, event.target.value as Ticket["status"])} className="rounded-md border border-white/10 bg-solar-dark px-2 py-1.5 text-xs text-slate-200"><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></div></article>)}</div>}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
