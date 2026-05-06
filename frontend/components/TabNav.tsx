"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/utils";

const TABS = [
  { href: "/",       label: "Enhance", match: (p: string) => p === "/" },
  { href: "/scan",   label: "Scan",    match: (p: string) => p.startsWith("/scan") },
  { href: "/resize", label: "Resize",  match: (p: string) => p.startsWith("/resize") },
] as const;

/**
 * Top-of-page tab bar. Matches the OVERVIEW / PRIORITY UNITS / ALL UNITS
 * style from the Inventory Dashboard:
 *   - Active tab: DF red text + thick red underline that overlaps the
 *     containing border-bottom (so it reads as a continuation of the divider)
 *   - Inactive tab: muted text, hover lifts to white
 *   - All caps + tracking-wide labels
 */
export function TabNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Tabs" className="flex items-stretch">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "relative flex items-center gap-2 px-5 py-3 text-xs font-semibold uppercase tracking-label-loose transition-colors",
              active
                ? "text-df-red"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-[2px] bg-df-red"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
