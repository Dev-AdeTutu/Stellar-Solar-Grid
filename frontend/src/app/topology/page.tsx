"use client";

import React from "react";
import { NetworkTopologyMap } from "../../components/NetworkTopologyMap";

export default function TopologyPage() {
  return (
    <main className="max-w-7xl mx-auto p-6 space-y-6">
      <NetworkTopologyMap />
    </main>
  );
}
