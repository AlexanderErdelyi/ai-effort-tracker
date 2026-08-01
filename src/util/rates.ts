/**
 * Rate resolution + ROI math inputs (issue #15 / milestone M3).
 *
 * This module is deliberately FRAMEWORK-FREE and PURE: it never touches VS Code
 * settings or the store directly. The {@link Database} reads the raw VS Code
 * configuration + a project's `settings` and hands them to these functions, so
 * the precedence rules and the economic math stay small and unit-testable in
 * isolation. The full ROI *report* is a later milestone (M7 / #29); here we only
 * resolve effective rates and expose the raw economic figures that report will
 * consume.
 */

/** Effective per-project (or global) rates after applying precedence. */
export interface EffectiveRates {
  /** What one developer hour COSTS (money). Null only when no rate is resolvable. */
  hourlyCostRate: number | null;
  /** What one developer hour is BILLED/SOLD for (money). Null when unset. */
  hourlySellRate: number | null;
  /** ISO-ish currency label these figures are expressed in (e.g. 'USD', 'EUR'). */
  currency: string;
  /** Money cost per 1 credit / premium-request. Null when unset. */
  creditCostPerUnit: number | null;
}

/**
 * Raw inputs for {@link resolveEffectiveRates}. The three tiers mirror the
 * documented precedence: a project override wins over the new global default,
 * which in turn wins over the LEGACY settings that shipped before this issue
 * (`hourlyRateUsd` for cost, `usdPerCredit` for credit cost). Any field may be
 * undefined/NaN — the resolver simply skips it and falls through to the next
 * tier.
 */
export interface RateGlobals {
  /** New global default cost rate (`aiEffortTracker.defaultHourlyCostRate`). */
  defaultHourlyCostRate?: number;
  /** New global default sell rate (`aiEffortTracker.defaultHourlySellRate`). */
  defaultHourlySellRate?: number;
  /** New global currency (`aiEffortTracker.currency`). */
  currency?: string;
  /** New global credit cost (`aiEffortTracker.creditCostPerUnit`). */
  creditCostPerUnit?: number;
  /** LEGACY cost rate (`aiEffortTracker.hourlyRateUsd`) — never broken. */
  legacyHourlyRateUsd?: number;
  /** LEGACY credit cost (`aiEffortTracker.usdPerCredit`) — never broken. */
  legacyUsdPerCredit?: number;
}

/** The subset of {@link ProjectSettings} that carries per-project rate overrides. */
export interface ProjectRateOverrides {
  hourlyCostRate?: number;
  hourlySellRate?: number;
  currency?: string;
  creditCostPerUnit?: number;
}

/** Return the first finite, non-negative number in `values`, else null. Pure. */
function firstNumber(...values: (number | undefined | null)[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** Return the first non-empty string in `values`, else null. Pure. */
function firstString(...values: (string | undefined | null)[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Resolve the effective rates for a project. Precedence (documented in
 * package.json / the PR):
 *   project setting  >  new global default  >  legacy setting
 * so nobody's existing `hourlyRateUsd` / `usdPerCredit` config breaks: when the
 * new defaults are unset the legacy values still apply. Missing rates yield
 * `null` (never NaN); currency always resolves to a string ('USD' last resort).
 * Pure.
 */
export function resolveEffectiveRates(
  overrides: ProjectRateOverrides | undefined,
  globals: RateGlobals
): EffectiveRates {
  const o = overrides ?? {};
  return {
    hourlyCostRate: firstNumber(
      o.hourlyCostRate,
      globals.defaultHourlyCostRate,
      globals.legacyHourlyRateUsd
    ),
    hourlySellRate: firstNumber(o.hourlySellRate, globals.defaultHourlySellRate),
    currency: firstString(o.currency, globals.currency) ?? 'USD',
    creditCostPerUnit: firstNumber(
      o.creditCostPerUnit,
      globals.creditCostPerUnit,
      globals.legacyUsdPerCredit
    )
  };
}

/** Milliseconds in one hour — used to convert tracked ms into billable hours. */
export const MS_PER_HOUR = 3_600_000;

/** Raw inputs the ROI math needs for a project (or work item). */
export interface RoiInput {
  /**
   * Billable active time in ms. Convention (documented): the sum of
   * human-coding + AI-generating + reviewing modes; `idle` never counts.
   */
  billableMs: number;
  /** Total credits (premium requests) attributed to the subject. */
  credits: number;
  /**
   * Money cost already recorded on ledger entries (`CreditTotals.cost`). When
   * present (> 0) it is authoritative and used verbatim; otherwise credit cost
   * is derived as `credits * creditCostPerUnit`.
   */
  ledgerCost: number;
  /** Effective rates resolved via {@link resolveEffectiveRates}. */
  rates: EffectiveRates;
}

/**
 * The economic figures an ROI report consumes. Every money figure is `number |
 * null`: `null` means "a required rate was missing" and is intentionally NOT
 * coerced to 0 so a report can distinguish "unconfigured" from "genuinely zero".
 * By construction no field is ever NaN.
 */
export interface RoiFigures {
  /** {@link RoiInput.billableMs} expressed in hours. */
  billableHours: number;
  hourlyCostRate: number | null;
  hourlySellRate: number | null;
  creditCostPerUnit: number | null;
  currency: string;
  /** hours * hourlyCostRate. Null when the cost rate is unresolved. */
  laborCost: number | null;
  /** Recorded ledger cost, or credits * creditCostPerUnit. Null when neither is available. */
  creditCost: number | null;
  /** laborCost + creditCost (each treated as 0 only when the OTHER is present). Null when both null. */
  totalCost: number | null;
  /** hours * hourlySellRate. Null when the sell rate is unset. */
  soldValue: number | null;
  /** soldValue - totalCost. Null when either side is unresolved. */
  netValue: number | null;
}

/** Add two `number | null` values, returning null only when BOTH are null. Pure. */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Compute the ROI economic figures for a subject from its billable time,
 * credits and effective rates. Guards every product/sum so a missing rate
 * yields `null` instead of NaN (see {@link RoiFigures}). Pure.
 */
export function computeRoiFigures(input: RoiInput): RoiFigures {
  const { rates } = input;
  const billableMs = Number.isFinite(input.billableMs) && input.billableMs > 0 ? input.billableMs : 0;
  const credits = Number.isFinite(input.credits) && input.credits > 0 ? input.credits : 0;
  const ledgerCost = Number.isFinite(input.ledgerCost) && input.ledgerCost > 0 ? input.ledgerCost : 0;
  const billableHours = billableMs / MS_PER_HOUR;

  const laborCost =
    rates.hourlyCostRate !== null ? billableHours * rates.hourlyCostRate : null;

  let creditCost: number | null;
  if (ledgerCost > 0) {
    creditCost = ledgerCost;
  } else if (rates.creditCostPerUnit !== null) {
    creditCost = credits * rates.creditCostPerUnit;
  } else {
    creditCost = null;
  }

  const totalCost = addNullable(laborCost, creditCost);

  const soldValue =
    rates.hourlySellRate !== null ? billableHours * rates.hourlySellRate : null;

  const netValue =
    soldValue !== null && totalCost !== null ? soldValue - totalCost : null;

  return {
    billableHours,
    hourlyCostRate: rates.hourlyCostRate,
    hourlySellRate: rates.hourlySellRate,
    creditCostPerUnit: rates.creditCostPerUnit,
    currency: rates.currency,
    laborCost,
    creditCost,
    totalCost,
    soldValue,
    netValue
  };
}
