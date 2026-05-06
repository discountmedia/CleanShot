/**
 * BrandMark — red pill with the product name.
 *
 * Matches the visual language of the Discount Forklift internal tools:
 * "LEDGER", "DAILY ACTIVITY", "INVENTORY DASHBOARD" all live in a hot-red
 * pill with white tracked-uppercase mono text. CleanShot lives in the same
 * family of tools, so the brand mark follows the same form.
 *
 * If you want the actual Discount Forklift logo here instead, drop the SVG
 * at /public/df-logo.svg and replace this component with an <Image>. Same
 * height (24px), same horizontal placement.
 */
export function BrandMark() {
  return (
    <span className="inline-flex items-center rounded-sm bg-brand-500 px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]">
      CleanShot
    </span>
  );
}
