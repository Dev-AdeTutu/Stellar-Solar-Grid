"use client";

import React, { useEffect, useRef } from "react";

export type StatusFilter = "all" | "active" | "inactive";

interface MeterSearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
  totalCount: number;
  filteredCount: number;
}

export function MeterSearchBar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  totalCount,
  filteredCount,
}: MeterSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut listener: Ctrl+K or Cmd+K focuses search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="mb-6 space-y-3 rounded-xl border border-white/10 bg-solar-accent/50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Search Input Box */}
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search meters by ID, nickname, location, or status... (Ctrl+K)"
            className="w-full rounded-lg border border-white/15 bg-solar-dark py-2 pl-9 pr-16 text-sm text-white placeholder-gray-500 focus:border-solar-yellow focus:outline-none focus:ring-1 focus:ring-solar-yellow transition"
            aria-label="Search meters"
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 gap-1.5">
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                className="rounded p-1 text-xs text-gray-400 hover:text-white hover:bg-white/10 transition"
                title="Clear search"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
            <kbd className="hidden sm:inline-block rounded border border-white/10 bg-solar-dark px-1.5 py-0.5 text-[10px] font-mono text-gray-400 shadow-sm">
              ⌘K
            </kbd>
          </div>
        </div>

        {/* Status Filter Buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-solar-dark p-1">
          {(["all", "active", "inactive"] as StatusFilter[]).map((filter) => {
            const isActive = statusFilter === filter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => onStatusFilterChange(filter)}
                className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${
                  isActive
                    ? "bg-solar-yellow text-solar-dark shadow-sm"
                    : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {filter}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter Stats Bar */}
      {(searchQuery || statusFilter !== "all") && (
        <div className="flex items-center justify-between text-xs text-gray-400 pt-1 border-t border-white/5">
          <span>
            Showing <strong className="text-solar-yellow">{filteredCount}</strong> of{" "}
            <strong>{totalCount}</strong> meters
          </span>
          <button
            onClick={() => {
              onSearchChange("");
              onStatusFilterChange("all");
            }}
            className="text-xs text-gray-400 hover:text-solar-yellow underline transition"
          >
            Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
