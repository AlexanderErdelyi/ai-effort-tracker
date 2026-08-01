/**
 * Per-model AIU (AI Unit) rate table + credit math for issue #59.
 *
 * This module is deliberately FRAMEWORK-FREE and PURE: it never touches VS Code
 * settings, the store, or the filesystem, so the rate resolution and the credit
 * math stay small and unit-testable in isolation (mirrors {@link ./rates.ts}).
 *
 * Background (verified empirically on real VS Code chat storage — see issue #59
 * and its comments): GitHub Copilot bills chat requests in *AI Units* (AIU). The
 * transient `result.metadata.usage.copilot_usage` block exposes the EXACT cost as
 * `total_nano_aiu` (nano-AIU; `total_nano_aiu / 1e9 === AIU`) plus a
 * `token_details[]` breakdown of `token_count × cost_per_batch / batch_size`. That
 * block is live-compacted away within seconds, so it is only occasionally caught.
 *
 * What IS durable per request is the resolved model + `promptTokens` /
 * `completionTokens`. So the PRIMARY, always-available estimate is
 * `promptTokens × inputRate + completionTokens × outputRate` for the model's
 * family, and the EXACT value from `total_nano_aiu` (when the live tailer catches
 * it before compaction) UPGRADES that estimate.
 *
 * The rates below are expressed as **nano-AIU per token** and are best-effort,
 * derived from the one fully-verified sample (claude-opus-4.8:
 * `cost_per_batch` input `500000000000`, output `2500000000000`, `batch_size`
 * `1000000` → input `500000` nano-AIU/token, output `2500000` nano-AIU/token) and
 * scaled across families by their relative provider pricing. They are intended to
 * be easy to edit and are also overridable at runtime via the
 * `aiEffortTracker.aiuRatesOverride` setting. The cache read/write split is NOT
 * durably available, so `promptTokens` is charged at the (non-cached) input rate
 * — an approximation the exact `total_nano_aiu` upgrade and the GitHub billing
 * import both reconcile.
 */

/** A per-family rate in nano-AIU per token. Both fields are finite and >= 0. */
export interface AiuRate {
  /** Nano-AIU charged per prompt (input) token. */
  inputNanoAiuPerToken: number;
  /** Nano-AIU charged per completion (output) token. */
  outputNanoAiuPerToken: number;
}

/** Nano-AIU in one AIU credit (`total_nano_aiu / NANO_PER_AIU === AIU`). */
export const NANO_PER_AIU = 1_000_000_000;

/**
 * Model-family → rate map (nano-AIU per token). Keys are lowercase family stems
 * matched by substring against a normalized model id (longest key wins). Edit
 * freely; unknown models fall back to {@link FALLBACK_AIU_RATE}. Numbers are
 * best-effort (see module doc) — never treat them as authoritative billing.
 */
export const AIU_RATES: Record<string, AiuRate> = {
  // Anthropic Claude — anchored on the verified opus-4.8 sample.
  'claude-opus': { inputNanoAiuPerToken: 500_000, outputNanoAiuPerToken: 2_500_000 },
  // Sonnet ≈ 1/5 of Opus (provider pricing $3/$15 vs $15/$75 per Mtok).
  'claude-sonnet': { inputNanoAiuPerToken: 100_000, outputNanoAiuPerToken: 500_000 },
  'claude-haiku': { inputNanoAiuPerToken: 25_000, outputNanoAiuPerToken: 125_000 },
  'claude-3.5': { inputNanoAiuPerToken: 100_000, outputNanoAiuPerToken: 500_000 },
  'claude-3.7': { inputNanoAiuPerToken: 100_000, outputNanoAiuPerToken: 500_000 },
  claude: { inputNanoAiuPerToken: 100_000, outputNanoAiuPerToken: 500_000 },

  // OpenAI GPT family (approximate; $2.5/$10 per Mtok class for gpt-4o/5).
  'gpt-4o-mini': { inputNanoAiuPerToken: 5_000, outputNanoAiuPerToken: 20_000 },
  'gpt-4.1-mini': { inputNanoAiuPerToken: 5_000, outputNanoAiuPerToken: 20_000 },
  'gpt-5-mini': { inputNanoAiuPerToken: 10_000, outputNanoAiuPerToken: 40_000 },
  'gpt-4o': { inputNanoAiuPerToken: 50_000, outputNanoAiuPerToken: 200_000 },
  'gpt-4.1': { inputNanoAiuPerToken: 40_000, outputNanoAiuPerToken: 160_000 },
  'gpt-5': { inputNanoAiuPerToken: 50_000, outputNanoAiuPerToken: 200_000 },
  gpt: { inputNanoAiuPerToken: 50_000, outputNanoAiuPerToken: 200_000 },

  // OpenAI reasoning models — heavier output weighting.
  'o1-mini': { inputNanoAiuPerToken: 30_000, outputNanoAiuPerToken: 120_000 },
  'o3-mini': { inputNanoAiuPerToken: 30_000, outputNanoAiuPerToken: 120_000 },
  o1: { inputNanoAiuPerToken: 150_000, outputNanoAiuPerToken: 600_000 },
  o3: { inputNanoAiuPerToken: 100_000, outputNanoAiuPerToken: 400_000 },

  // Google Gemini (approximate mid-tier).
  'gemini-2.5-pro': { inputNanoAiuPerToken: 40_000, outputNanoAiuPerToken: 160_000 },
  'gemini-2.0-flash': { inputNanoAiuPerToken: 5_000, outputNanoAiuPerToken: 20_000 },
  'gemini-flash': { inputNanoAiuPerToken: 5_000, outputNanoAiuPerToken: 20_000 },
  gemini: { inputNanoAiuPerToken: 40_000, outputNanoAiuPerToken: 160_000 }
};

/**
 * Safe fallback rate for a model id that matches no family. Mid-range so an
 * unknown model still yields a finite, non-zero, non-negative estimate (never
 * NaN). Chosen at the gpt-4o class so unknowns are neither wildly over- nor
 * under-counted.
 */
export const FALLBACK_AIU_RATE: AiuRate = {
  inputNanoAiuPerToken: 50_000,
  outputNanoAiuPerToken: 200_000
};

/** Coerce an unknown to a finite, non-negative number, else `fallback`. Pure. */
function safeNonNeg(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** True when `rate` is a fully valid {@link AiuRate} (both fields finite, >= 0). */
function isValidRate(rate: unknown): rate is AiuRate {
  if (!rate || typeof rate !== 'object') return false;
  const r = rate as Partial<AiuRate>;
  return (
    typeof r.inputNanoAiuPerToken === 'number' &&
    Number.isFinite(r.inputNanoAiuPerToken) &&
    r.inputNanoAiuPerToken >= 0 &&
    typeof r.outputNanoAiuPerToken === 'number' &&
    Number.isFinite(r.outputNanoAiuPerToken) &&
    r.outputNanoAiuPerToken >= 0
  );
}

/**
 * Normalize a raw model id (e.g. `claude-opus-4-8`, `claude-sonnet-4.6`,
 * `gpt-5.3-codex`, `gpt-4o-2024-07-18`) to a lowercase stem, dropping trailing
 * date/version stamps so family matching is stable. Pure; always returns a
 * string (empty for a nullish/blank id).
 */
export function normalizeModelId(modelId: string | null | undefined): string {
  if (typeof modelId !== 'string') return '';
  return modelId
    .trim()
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-preview$/, '');
}

/**
 * Resolve the family stem key for a model id (the longest {@link AIU_RATES} key
 * that is a substring of the normalized id), or `'unknown'` when nothing matches.
 * Overrides are consulted first so a user-provided family can win. Pure.
 */
export function resolveModelFamily(
  modelId: string | null | undefined,
  overrides?: Record<string, unknown>
): string {
  const norm = normalizeModelId(modelId);
  if (!norm) return 'unknown';
  let best: string | undefined;
  const consider = (key: string) => {
    if (!key) return;
    if (norm.includes(key.toLowerCase()) && (!best || key.length > best.length)) best = key;
  };
  if (overrides && typeof overrides === 'object') {
    for (const key of Object.keys(overrides)) if (isValidRate(overrides[key])) consider(key);
  }
  for (const key of Object.keys(AIU_RATES)) consider(key);
  return best ?? 'unknown';
}

/**
 * Resolve the effective {@link AiuRate} for a model id. Precedence: a valid
 * runtime override wins over the built-in {@link AIU_RATES}, which wins over
 * {@link FALLBACK_AIU_RATE}. Always returns a valid rate (never NaN). Pure.
 */
export function resolveAiuRate(
  modelId: string | null | undefined,
  overrides?: Record<string, unknown>
): AiuRate {
  const norm = normalizeModelId(modelId);
  const family = resolveModelFamily(modelId, overrides);
  if (family !== 'unknown') {
    const ov = overrides?.[family];
    if (isValidRate(ov)) return { ...ov };
    const built = AIU_RATES[family];
    if (isValidRate(built)) return { ...built };
  }
  // Also honor an override keyed on the exact normalized id, even if it is not
  // a substring family match (lets a user pin a single model precisely).
  if (overrides && isValidRate(overrides[norm])) return { ...(overrides[norm] as AiuRate) };
  return { ...FALLBACK_AIU_RATE };
}

/**
 * PRIMARY estimate: credits (AIU) for a request from its durable model +
 * prompt/completion token counts. `= (prompt × inputRate + completion ×
 * outputRate) / NANO_PER_AIU`. Negative / non-finite token counts are treated as
 * `0`, so the result is ALWAYS a finite, non-negative number (never NaN). Pure.
 */
export function estimateCreditsAiu(
  modelId: string | null | undefined,
  promptTokens: unknown,
  completionTokens: unknown,
  overrides?: Record<string, unknown>
): number {
  const rate = resolveAiuRate(modelId, overrides);
  const prompt = safeNonNeg(promptTokens);
  const completion = safeNonNeg(completionTokens);
  const nano = prompt * rate.inputNanoAiuPerToken + completion * rate.outputNanoAiuPerToken;
  const credits = nano / NANO_PER_AIU;
  return Number.isFinite(credits) && credits >= 0 ? credits : 0;
}

/** One `copilot_usage.token_details[]` row (all fields best-effort/optional). */
interface TokenDetail {
  batch_size?: unknown;
  cost_per_batch?: unknown;
  token_count?: unknown;
  token_type?: unknown;
}

/**
 * EXACT credits (AIU) from a captured `copilot_usage` block, or `null` when the
 * block carries no usable cost. Prefers the authoritative `total_nano_aiu`
 * (`/ NANO_PER_AIU`); falls back to reconstructing it from `token_details[]` as
 * `Σ token_count × cost_per_batch / batch_size` (the formula verified in #59).
 * Fully defensive: any missing/malformed field yields `null`, never throws,
 * never NaN. Pure.
 */
export function exactCreditsFromCopilotUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as { total_nano_aiu?: unknown; token_details?: unknown };

  if (typeof u.total_nano_aiu === 'number' && Number.isFinite(u.total_nano_aiu) && u.total_nano_aiu >= 0) {
    return u.total_nano_aiu / NANO_PER_AIU;
  }

  if (Array.isArray(u.token_details)) {
    let nano = 0;
    let sawAny = false;
    for (const raw of u.token_details as TokenDetail[]) {
      if (!raw || typeof raw !== 'object') continue;
      const count = safeNonNeg(raw.token_count, NaN);
      const costPerBatch = safeNonNeg(raw.cost_per_batch, NaN);
      const batchSize = safeNonNeg(raw.batch_size, NaN);
      if (!Number.isFinite(count) || !Number.isFinite(costPerBatch) || !Number.isFinite(batchSize) || batchSize <= 0) {
        continue;
      }
      nano += (count * costPerBatch) / batchSize;
      sawAny = true;
    }
    if (sawAny && Number.isFinite(nano) && nano >= 0) return nano / NANO_PER_AIU;
  }

  return null;
}
