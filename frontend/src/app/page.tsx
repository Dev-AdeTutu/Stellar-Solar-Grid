import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <div className="w-full max-w-2xl">
        <span className="text-5xl">☀️</span>
        <h1 className="mt-4 text-3xl font-bold text-solar-yellow sm:text-5xl">
          Stellar SolarGrid
        </h1>
        <p className="mt-4 text-base text-gray-300 sm:text-lg">
          Affordable, pay-as-you-go solar energy powered by the Stellar blockchain.
          No large upfront costs — just clean energy on your terms.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/dashboard/user"
            className="rounded-lg bg-solar-yellow px-6 py-3.5 font-semibold text-solar-dark hover:opacity-90 transition text-base"
          >
            User Dashboard
          </Link>
          <Link
            href="/dashboard/provider"
            className="rounded-lg border border-solar-yellow px-6 py-3.5 font-semibold text-solar-yellow hover:bg-solar-yellow hover:text-solar-dark transition text-base"
          >
            Provider Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
