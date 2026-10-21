import Link from "next/link";
import EnergyMixPanel from "@/components/EnergyMixPanel";

export default function MeterEnergyPage({ params }: { params: { id: string } }) {
  return <main className="max-w-4xl mx-auto p-6 space-y-6">
    <Link href="/dashboard/user" className="underline">Back to meters</Link>
    <h1 className="text-2xl font-bold">Meter energy sources</h1>
    <EnergyMixPanel meterId={params.id} />
  </main>;
}
