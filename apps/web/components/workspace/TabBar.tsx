"use client";
// apps/web/components/workspace/TabBar.tsx
// Tab navigation row beneath the header.
// Active tab gets a red underline + red text — matches the inventory-dashboard pattern.

export type TabId = "enhance" | "scan" | "modify" | "resize" | "history";

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
      <div className="flex items-end px-6 gap-10 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={`
                relative flex items-center gap-2 py-4 text-base font-bold uppercase tracking-[0.16em]
                transition-colors whitespace-nowrap
                ${isActive
                  ? "text-red-400"
                  : "text-zinc-200 hover:text-white"}
              `}
            >
              <span>{tab.label}</span>
              {typeof tab.count === "number" && (
                <span className={`
                  inline-flex items-center justify-center min-w-6.5 h-5.5 px-2
                  rounded text-sm font-bold tabular-nums
                  ${isActive ? "bg-red-900 text-red-100" : "bg-zinc-800 text-zinc-100"}
                `}>
                  {tab.count}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute left-0 right-0 bottom-0 h-0.75 bg-red-600"
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
