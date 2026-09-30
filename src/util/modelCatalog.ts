import { createHash } from 'crypto';

/** Token prices per 1,000,000 tokens, in credits (Copilot `models.json` units). */
export interface PriceTier {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Prompt size up to which this tier applies. */
  maxPrompt?: number;
}

export interface ModelPrice {
  default: PriceTier;
  longContext?: PriceTier;
  /** Offered in the model picker when captured. */
  picker?: boolean;
  capturedAt: number;
}

export interface ToolsetServer {
  /** Tool count and definition size (characters) for one MCP server or built-in group. */
  count: number;
  chars: number;
  /** Offered tool names; lets analysis match calls to servers and find unused ones. */
  tools: string[];
}

/** Compact, content-free fingerprint of one tool definition set offered to the model. */
export interface ToolsetInfo {
  id: string;
  firstSeen: number;
  lastSeen: number;
  toolCount: number;
  chars: number;
  servers: Record<string, ToolsetServer>;
}

export const BUILTIN_SERVER = '(built-in/extensions)';
export const MAX_TOOLSETS = 30;

const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const price = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function tier(v: unknown): PriceTier | undefined {
  if (!obj(v)) return undefined;
  const t: PriceTier = {
    input: price(v.input_price), cacheRead: price(v.cache_read_price),
    cacheWrite: price(v.cache_write_price), output: price(v.output_price)
  };
  if (typeof v.max_prompt_tokens === 'number' && v.max_prompt_tokens > 0) t.maxPrompt = v.max_prompt_tokens;
  return t;
}

/** Parse Copilot's `models.json`; models without a positive price are skipped. */
export function parseModelPrices(text: string, capturedAt: number): Record<string, ModelPrice> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const list = Array.isArray(parsed) ? parsed : obj(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
  const result: Record<string, ModelPrice> = {};
  for (const model of list) {
    if (!obj(model) || typeof model.id !== 'string' || !obj(model.billing)) continue;
    const prices = model.billing.token_prices;
    if (!obj(prices)) continue;
    const base = tier(prices.default);
    if (!base || base.input + base.output === 0) continue;
    const long = tier(prices.long_context);
    result[model.id.slice(0, 80)] = {
      default: base, ...(long ? { longContext: long } : {}),
      ...(typeof model.model_picker_enabled === 'boolean' ? { picker: model.model_picker_enabled } : {}),
      capturedAt
    };
  }
  return result;
}

export interface CallTokens {
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
}

/**
 * List-price cost of a call. Uncached input is billed at the cache-write price
 * when the model has one (Anthropic-style prompt caching), otherwise at the
 * input price. Validated against recorded Copilot charges.
 */
export function listCost(p: ModelPrice, call: CallTokens): number {
  const t = p.longContext && p.default.maxPrompt && call.inputTokens > p.default.maxPrompt ? p.longContext : p.default;
  const cached = Math.min(call.inputTokens, Math.max(0, call.cachedTokens ?? 0));
  const uncached = call.inputTokens - cached;
  const uncachedPrice = t.cacheWrite > 0 ? t.cacheWrite : t.input;
  return (uncached * uncachedPrice + cached * t.cacheRead + call.outputTokens * t.output) / 1e6;
}

/** Server key for a tool name. VS Code prefixes MCP tools as `mcp_<label truncated to 13 chars>_<tool>`. */
function candidates(name: string): string[] {
  const rest = name.slice(4);
  const out: string[] = [];
  for (let i = rest.indexOf('_'); i > 0 && i <= 13; i = rest.indexOf('_', i + 1)) out.push(rest.slice(0, i));
  if (rest.length > 13) out.push(rest.slice(0, 13));
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

export function serverKeys(names: string[]): Record<string, string> {
  const mcp = names.filter(n => n.startsWith('mcp_'));
  const shared = new Map<string, number>();
  for (const n of mcp) for (const c of candidates(n)) shared.set(c, (shared.get(c) ?? 0) + 1);
  const result: Record<string, string> = {};
  for (const n of names) {
    if (!n.startsWith('mcp_')) { result[n] = BUILTIN_SERVER; continue; }
    const options = candidates(n);
    const key = options.find(c => (shared.get(c) ?? 0) > 1) ?? options[options.length - 1] ?? n.slice(4);
    result[n] = 'mcp:' + key.replace(/_+$/, '');
  }
  return result;
}

/** Parse a `tools_N.json` file into a content-free fingerprint. Descriptions and schemas are discarded. */
export function parseToolset(text: string, seenAt: number): ToolsetInfo | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (obj(parsed) && typeof parsed.content === 'string') {
    try { parsed = JSON.parse(parsed.content); } catch { return undefined; }
  } else if (obj(parsed) && Array.isArray(parsed.content)) parsed = parsed.content;
  const list = Array.isArray(parsed) ? parsed : obj(parsed) && Array.isArray(parsed.tools) ? parsed.tools : undefined;
  if (!list) return undefined;
  const defs: { name: string; chars: number }[] = [];
  for (const tool of list) {
    if (!obj(tool)) continue;
    const name = typeof tool.name === 'string' ? tool.name
      : obj(tool.function) && typeof tool.function.name === 'string' ? tool.function.name : '';
    if (name) defs.push({ name: name.slice(0, 120), chars: JSON.stringify(tool).length });
  }
  if (!defs.length) return undefined;
  defs.sort((a, b) => a.name.localeCompare(b.name));
  const id = createHash('sha256').update(defs.map(d => `${d.name}:${d.chars}`).join('\n')).digest('hex').slice(0, 16);
  const tools = serverKeys(defs.map(d => d.name));
  const servers: Record<string, ToolsetServer> = {};
  for (const d of defs) {
    const key = tools[d.name];
    const s = servers[key] ??= { count: 0, chars: 0, tools: [] };
    s.count++;
    s.chars += d.chars;
    // Built-in names are recognisable without a list; keep the store small.
    if (key !== BUILTIN_SERVER) s.tools.push(d.name);
  }
  return { id, firstSeen: seenAt, lastSeen: seenAt, toolCount: defs.length,
    chars: defs.reduce((n, d) => n + d.chars, 0), servers };
}

/** Server key of a called tool within a toolset, or a best guess when the toolset is unknown. */
export function serverOf(tool: string, toolset?: ToolsetInfo): string {
  if (toolset) {
    for (const [key, s] of Object.entries(toolset.servers)) if (s.tools.includes(tool)) return key;
  }
  return serverKeys([tool])[tool];
}
