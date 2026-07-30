"use client";
// apps/web/components/workspace/TabBar.tsx
// Tab navigation row beneath the header.
// Active tab gets a brand-purple underline + purple text — matches the inventory-dashboard pattern.

export type TabId = "enhance" | "scan" | "history";

export interface TabDef {
  id: TabId;
  label: string;
  count?: number;
}

interface TabBarProps {
  tabs: TabDef[];
  active: TabId;
  onChange: (id: TabId) => void;
  /**
   * Optional prefetch hook fired on hover / focus of a tab button.
   * Workspace wires this to the dynamic-import loader functions for
   * the code-split panels (Scan / Resize / History) so the
   * chunk download races the operator's click — by the time they
   * commit to the tab, the JS is already parsed and the switch
   * feels instant instead of having a brief loading flash.
   * No-op for tabs whose panels are eagerly imported (Enhance).
   */
  onPrefetch?: (id: TabId) => void;
}

export function TabBar({ tabs, active, onChange, onPrefetch }: TabBarProps) {
  return (
    <nav className="border-b border-line bg-header-bg" role="tablist" aria-label="Workspace sections">
      <div className="flex items-end px-6 gap-10 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              onMouseEnter={() => onPrefetch?.(tab.id)}
              onFocus={() => onPrefetch?.(tab.id)}
              className={`
                relative flex items-center gap-2 py-4 text-base font-bold uppercase tracking-[0.16em]
                transition-colors whitespace-nowrap
                ${isActive
                  ? "text-accent"
                  : "text-ink hover:text-ink"}
              `}
            >
              <span>{tab.label}</span>
              {typeof tab.count === "number" && (
                <span className={`
                  inline-flex items-center justify-center min-w-6.5 h-5.5 px-2
                  rounded text-sm font-bold tabular-nums
                  ${isActive ? "bg-cta text-accent" : "bg-panel-hi text-ink"}
                `}>
                  {tab.count}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute left-0 right-0 bottom-0 h-0.75 bg-cta"
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
