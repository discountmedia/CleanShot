"use client";
// apps/web/components/workspace/TabBar.tsx
// Tab navigation row beneath the header.
// Active tab gets a red underline + red text — matches the inventory-dashboard pattern.

export type TabId = "enhance" | "scan" | "resize" | "history";

export interface TabDef {
  id: TabId;
  label: string;
  count?: number;
}

interface TabBarProps {
  tabs: TabDef[];
  active: TabId;
  onChange: (id: TabId) => void;
}

export function TabBar({ tabs, active, onChange }: TabBarProps) {
  return (
    <nav className="border-b border-zinc-900 bg-black" role="tablist" aria-label="Workspace sections">
      <div className="flex items-end px-6 gap-8 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={`
                relative flex items-center gap-2 py-3 text-xs font-semibold uppercase tracking-[0.16em]
                transition-colors whitespace-nowrap
                ${isActive
                  ? "text-red-500"
                  : "text-zinc-500 hover:text-zinc-300"}
              `}
            >
              <span>{tab.label}</span>
              {typeof tab.count === "number" && (
                <span className={`
                  inline-flex items-center justify-center min-w-[22px] h-[18px] px-1.5
                  rounded text-[10px] font-bold tabular-nums
                  ${isActive ? "bg-red-950 text-red-300" : "bg-zinc-900 text-zinc-400"}
                `}>
                  {tab.count}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute left-0 right-0 bottom-0 h-[2px] bg-red-600"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
