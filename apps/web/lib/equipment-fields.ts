// apps/web/lib/equipment-fields.ts
//
// The fixed choices behind the Tire type, Fuel type and Year dropdowns, shared
// by the Enhance tab's details card (MetaCard) and the export form
// (ExportControls) so the two can never offer different lists.
//
// The option VALUES are words the export namer already understands
// (apps/api/src/cleanshot_api/services/export_naming.py): Pneumatic -> P,
// Cushion -> C, Diesel -> D, Gas -> G, LP -> LP, Dual Fuel -> DUAL,
// Electric -> E, Manual -> M. The letter in each label is what appears in the
// file name. ⚠️ _FUEL_CODES there is the other copy of this vocabulary; a fuel
// added here and not there is offered to operators and then dropped from the
// name.
//
// A value that arrives from somewhere else -- typed before these were
// dropdowns, or carried in by an import -- is matched to an option when it
// plainly means one ("LPG", "pneumatic tires"). Anything else is shown as it
// is rather than silently cleared; see SelectField.

export interface FieldOption {
  value: string;
  label: string;
}

export const TIRE_OPTIONS: readonly FieldOption[] = [
  { value: "Pneumatic", label: "Pneumatic (P)" },
  { value: "Cushion",   label: "Cushion (C)" },
];

export const FUEL_OPTIONS: readonly FieldOption[] = [
  { value: "Diesel",    label: "Diesel (D)" },
  { value: "Gas",       label: "Gas (G)" },
  { value: "LP",        label: "LP / Propane (LP)" },
  { value: "Dual Fuel", label: "Dual fuel (DUAL)" },
  { value: "Electric",  label: "Electric (E)" },
  /* Propelled by a person: nothing powers travel or steering. A manual pallet
     jack with an electric pump for the forks is still Manual. */
  { value: "Manual",    label: "Manual (M)" },
];

const TIRE_SYNONYMS: Record<string, string> = {
  p: "Pneumatic", pneumatic: "Pneumatic",
  c: "Cushion",   cushion:   "Cushion",
};

const FUEL_SYNONYMS: Record<string, string> = {
  d: "Diesel", diesel: "Diesel",
  g: "Gas", gas: "Gas", gasoline: "Gas", petrol: "Gas",
  lp: "LP", lpg: "LP", "lp gas": "LP", propane: "LP",
  dual: "Dual Fuel", "dual fuel": "Dual Fuel", "lp/gas": "Dual Fuel", "gas/lp": "Dual Fuel",
  e: "Electric", electric: "Electric", battery: "Electric",
  m: "Manual", manual: "Manual",
};

const squash = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, " ");

/** The tire option a stored value means, or null if it is not one of them. */
export function canonicalTire(raw: string | undefined | null): string | null {
  const s = squash(raw ?? "").replace(/ tires?$/, "");
  return TIRE_SYNONYMS[s] ?? null;
}

/** The fuel option a stored value means, or null if it is not one of them. */
export function canonicalFuel(raw: string | undefined | null): string | null {
  const s = squash(raw ?? "").replace(/\s*\/\s*/g, "/");
  return FUEL_SYNONYMS[s] ?? null;
}

/** Oldest model year offered. Older units are rare but real on the used market. */
export const OLDEST_YEAR = 1960;

/**
 * Next year down to OLDEST_YEAR, newest first. Next year is included because
 * new units are sold as the coming model year late in the calendar year.
 * There is deliberately no default: an unknown year stays blank.
 */
export function yearOptions(now: Date = new Date()): FieldOption[] {
  const out: FieldOption[] = [];
  for (let y = now.getFullYear() + 1; y >= OLDEST_YEAR; y--) {
    out.push({ value: String(y), label: String(y) });
  }
  return out;
}

/** A stored year that is one of the offered options, or null. */
export function canonicalYear(raw: string | undefined | null, now: Date = new Date()): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return y >= OLDEST_YEAR && y <= now.getFullYear() + 1 ? s : null;
}
