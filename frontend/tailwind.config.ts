import type { Config } from "tailwindcss";

/**
 * CleanShot design tokens — matches the existing Discount Forklift internal
 * tooling visual language (Daily Activity, Inventory Dashboard, etc.):
 *
 *   - Pure black surface, near-black raised cards, subtle gray borders
 *   - JetBrains Mono throughout (loaded via next/font in app/layout.tsx)
 *   - Discount Forklift red as the single brand accent
 *   - Semantic status colors for big display numbers (pass/warn/fail/info/etc.)
 *   - Uppercase + tracking-wide labels in muted gray over big bold numbers
 *
 * If you change a token here, look at the screenshots in /docs/style-ref/
 * (or the equivalent reference) before adjusting — the dashboards lean on
 * specific values and small drifts make the suite feel inconsistent.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Discount Forklift brand — the only red in the palette.
        // Use sparingly: alerts, active tab indicator, primary CTAs, divider.
        df: {
          red:        "#E11D2C",
          "red-700":  "#B91722",
          "red-900":  "#7A0F17",
          "red-tint": "#1A0608",  // alert backgrounds (very dark red wash)
        },

        // Surface system — ordered from base (page) to elevated (cards).
        surface: {
          base:   "#000000",
          raised: "#0B0B0B",
          card:   "#111111",
          hover:  "#1A1A1A",
        },

        // Borders
        line: {
          DEFAULT: "#262626",
          subtle:  "#1A1A1A",
          bright:  "#3A3A3A",
        },

        // Status colors for big display numbers — match the dashboards.
        status: {
          pass:    "#22C55E",
          warn:    "#EAB308",
          fail:    "#EF4444",
          info:    "#3B82F6",
          rental:  "#A855F7",
          deposit: "#F97316",
          cash:    "#FBBF24",
        },

        // Text scale
        ink: {
          DEFAULT: "#FFFFFF",
          muted:   "#9CA3AF",
          dim:     "#6B7280",
          faint:   "#4B5563",
        },
      },
      fontFamily: {
        sans: ["var(--font-jetbrains)", "ui-monospace", "Menlo", "Consolas", "monospace"],
        mono: ["var(--font-jetbrains)", "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
      letterSpacing: {
        "label":       "0.08em",
        "label-loose": "0.12em",
      },
      fontSize: {
        "display-sm": ["2.5rem",  { lineHeight: "1", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display":    ["3rem",    { lineHeight: "1", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display-lg": ["3.75rem", { lineHeight: "1", letterSpacing: "-0.03em", fontWeight: "700" }],
      },
    },
  },
  plugins: [],
};

export default config;
