"use client";

export function SkeletonCard({ height = 80 }: { height?: number }) {
  return (
    <div
      className="rounded-xl border border-white/10 bg-solar-accent animate-pulse"
      style={{ height: `${height}px` }}
    />
  );
}
