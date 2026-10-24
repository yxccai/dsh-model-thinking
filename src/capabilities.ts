/** Runtime-only additions to explicitly configured pi-ai model capabilities. */
import type { CapabilityLookup } from './catalog.ts';

/** Effort names supported by DSH's pi-ai adapter. */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** A selector effort; the wire spelling can differ. */
export type Effort = typeof EFFORTS[number];
/** Explicit opt-in for a provider/model pair, with `*` wildcards. */
export interface Rule {
  provider: string;
  model: string;
  efforts: Partial<Record<Effort, string | null>>;
}
/** Validated plugin options. */
export interface Options {
  autoCatalog?: boolean;
  /** Compatibility switch for configurations written by 0.1.0. */
  autoGpt?: boolean;
  defaultEfforts: Effort[];
  rules: Rule[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'iu').test(value);
}

function automaticModel(id: string): boolean {
  const name = id.split('/').at(-1) ?? id;
  return /^(?:gpt-[56](?:[.-]|$)|o[134](?:[.-]|$))/iu.test(name)
    && !/(?:^|[-.])(?:chat|nonreasoning)(?:[-.]|$)/iu.test(name);
}

/**
 * Reject unusable effort declarations before any provider configuration changes.
 * @param options - plugin configuration after schema defaults.
 */
export function validateOptions(options: Options): void {
  const validate = (efforts: Partial<Record<Effort, string | null>>, label: string) => {
    if (!Object.keys(efforts).some(level => level !== 'off')) {
      throw new Error(`${label} must offer at least one thinking level`);
    }
    for (const [level, value] of Object.entries(efforts)) {
      if (!EFFORTS.includes(level as Effort) || (value === null ? level !== 'off' : typeof value !== 'string' || !value.trim())) {
        throw new Error(`${label}.${level} must name a supported effort and a non-empty wire value; only off may use null`);
      }
    }
  };
  if (options.defaultEfforts.length > 0) validate(Object.fromEntries(options.defaultEfforts.map(level => [level, level])), 'defaultEfforts');
  if (new Set(options.defaultEfforts).size !== options.defaultEfforts.length) throw new Error('defaultEfforts repeats a level');
  for (const rule of options.rules) {
    if (!rule.provider.trim() || !rule.model.trim()) throw new Error('Each rule needs provider and model patterns');
    validate(rule.efforts, `${rule.provider}/${rule.model}`);
  }
}

/**
 * Add reasoning metadata without mutating raw config, explicit declarations, or credentials.
 * Only declared models on Chat Completions / Responses routes are eligible.
 * @param value - interpolated pi-ai configuration from Cordis.
 * @param options - validated defaults and explicit model rules.
 * @returns the original object when unchanged, otherwise a detached replacement of changed rows.
 */
export function enrichCapabilities(value: unknown, options: Options, lookup: CapabilityLookup = () => undefined): unknown {
  if (!record(value) || !record(value.providers)) return value;
  const providers = { ...value.providers };
  let changed = false;
  for (const [provider, profile] of Object.entries(value.providers)) {
    if (!record(profile) || !['openai-completions', 'openai-responses'].includes(String(profile.api))) continue;
    const profileCompat = record(profile.compat) ? profile.compat : {};
    const enrich = (model: unknown, id: string): unknown => {
      if (!record(model) || Object.hasOwn(model, 'reasoningEfforts')) return model;
      const compat = record(model.compat) ? model.compat : {};
      if (compat.supportsReasoningEffort === false || (compat.supportsReasoningEffort === undefined && profileCompat.supportsReasoningEffort === false)) return model;
      const rule = options.rules.find(item => matches(item.provider, provider) && matches(item.model, id));
      const format = compat.thinkingFormat ?? profileCompat.thinkingFormat;
      const automatic = options.autoGpt ?? options.autoCatalog ?? true;
      const reference = automatic ? lookup(provider, id) : undefined;
      const fallback = automatic && reference === undefined && automaticModel(id) && options.defaultEfforts.length > 0;
      if (rule === undefined && (!automatic || reference?.efforts === false || (!reference && !fallback))) return model;
      if (rule === undefined && format !== undefined && format !== (reference?.thinkingFormat ?? 'openai')) return model;
      const efforts = rule?.efforts ?? reference?.efforts ?? Object.fromEntries(options.defaultEfforts.map(level => [level, level]));
      if (efforts === false) return model;
      changed = true;
      return {
        ...model,
        reasoningEfforts: { ...efforts },
        ...(profile.api === 'openai-completions' ? {
          compat: { ...compat, supportsReasoningEffort: true, thinkingFormat: format ?? reference?.thinkingFormat ?? 'openai' },
        } : {}),
      };
    };
    if (Array.isArray(profile.models)) {
      const original = profile.models;
      const models = original.map(model => record(model) && typeof model.id === 'string' ? enrich(model, model.id) : model);
      if (models.some((model, index) => model !== original[index])) providers[provider] = { ...profile, models };
    } else if (record(profile.modelOverrides)) {
      const overrides = profile.modelOverrides;
      const modelOverrides = Object.fromEntries(Object.entries(overrides).map(([id, model]) => [id, enrich(model, id)]));
      if (Object.entries(modelOverrides).some(([id, model]) => model !== overrides[id])) providers[provider] = { ...profile, modelOverrides };
    }
  }
  return changed ? { ...value, providers } : value;
}
