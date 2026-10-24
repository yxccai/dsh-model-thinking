/** Exact-model reasoning metadata from the pi-ai catalog shipped with DSH. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EFFORTS, type Effort } from './capabilities.ts';

/** Capability reference; undefined denotes a model absent from the catalog. */
export interface ModelCapability {
  efforts: Partial<Record<Effort, string | null>> | false;
  thinkingFormat?: string;
}
/** Resolve one configured provider/model pair against installed reference data. */
export type CapabilityLookup = (provider: string, model: string) => ModelCapability | undefined;
/** Catalog fields used by the overlay; transport implementations are never invoked. */
export interface CatalogModel {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<Effort, string | null>>;
  thinkingFormat?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function capability(model: CatalogModel): ModelCapability {
  if (!model.reasoning) return { efforts: false };
  const efforts: Partial<Record<Effort, string | null>> = {};
  for (const level of EFFORTS) {
    const wire = model.thinkingLevelMap?.[level];
    if (wire === null || ((level === 'xhigh' || level === 'max') && wire === undefined)) continue;
    efforts[level] = wire ?? (level === 'off' ? null : level);
  }
  return { efforts, ...(model.thinkingFormat === undefined ? {} : { thinkingFormat: model.thinkingFormat }) };
}

/**
 * Index exact IDs, preferring the named catalog provider and canonical OpenAI GPT entries.
 * Ambiguous cross-provider capabilities require an explicit rule instead of guessing.
 * @param models - installed catalog models.
 * @returns lookup over immutable capability references.
 */
export function createCapabilityLookup(models: readonly CatalogModel[]): CapabilityLookup {
  const byId = new Map<string, CatalogModel[]>();
  for (const model of models) byId.set(model.id, [...byId.get(model.id) ?? [], model]);
  return (provider, modelId) => {
    let id = modelId;
    let preferred = provider;
    let candidates = byId.get(id);
    if (candidates === undefined && modelId.includes('/')) {
      const at = modelId.indexOf('/');
      preferred = modelId.slice(0, at);
      id = modelId.slice(at + 1);
      candidates = byId.get(id)?.filter(model => model.provider === preferred);
    }
    if (!candidates?.length) return undefined;
    const exact = candidates.find(model => model.provider === preferred);
    if (exact) return capability(exact);
    if (/^(?:gpt-|o[134](?:-|$))/iu.test(id)) {
      const openai = candidates.find(model => model.provider === 'openai');
      if (openai) return capability(openai);
    }
    const capabilities = candidates.map(capability);
    return capabilities.every(item => JSON.stringify(item) === JSON.stringify(capabilities[0])) ? capabilities[0] : undefined;
  };
}

function importTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!record(value)) return undefined;
  return importTarget(value.import ?? value.node ?? value.default);
}

/**
 * Read the public providers export of the adapter's own installed pi-ai version.
 * Only package manifests and built-in catalogs are read; no network or credentials are used.
 * @param installAnchor - active DSH profile's immutable runtime package anchor.
 * @returns model lookup for the installed DSH generation.
 */
export async function loadInstalledCatalog(installAnchor: string): Promise<CapabilityLookup> {
  const require = createRequire(installAnchor);
  const adapter = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json');
  const fromAdapter = createRequire(adapter);
  const manifestPath = fromAdapter.resolve.paths('@earendil-works/pi-ai')
    ?.map(path => join(path, '@earendil-works/pi-ai/package.json')).find(existsSync);
  if (!manifestPath) throw new Error('The installed pi-ai package could not be located');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!record(manifest) || !record(manifest.exports)) throw new Error('The installed pi-ai package has no public exports');
  const target = importTarget(manifest.exports['./providers/all'] ?? manifest.exports['./providers/*'])?.replace('*', 'all');
  if (!target?.startsWith('./')) throw new Error('The installed pi-ai providers export is unavailable');
  const module: Record<string, unknown> = await import(pathToFileURL(resolve(dirname(manifestPath), target)).href);
  if (typeof module.builtinProviders !== 'function' || typeof module.getBuiltinModels !== 'function') {
    throw new Error('The installed pi-ai version does not expose built-in model metadata');
  }
  const providers: unknown = module.builtinProviders();
  if (!Array.isArray(providers)) throw new Error('Invalid built-in provider catalog');
  const models: CatalogModel[] = [];
  for (const provider of providers) {
    if (!record(provider) || typeof provider.id !== 'string') continue;
    const entries: unknown = module.getBuiltinModels(provider.id);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!record(entry) || typeof entry.id !== 'string') continue;
      const map = record(entry.thinkingLevelMap) ? entry.thinkingLevelMap : {};
      const thinkingLevelMap: Partial<Record<Effort, string | null>> = {};
      for (const level of EFFORTS) {
        const wire = map[level];
        if (typeof wire === 'string' || wire === null) thinkingLevelMap[level] = wire;
      }
      const compat = record(entry.compat) ? entry.compat : {};
      models.push({ provider: provider.id, id: entry.id, reasoning: entry.reasoning === true, thinkingLevelMap,
        ...(typeof compat.thinkingFormat === 'string' ? { thinkingFormat: compat.thinkingFormat } : {}),
      });
    }
  }
  return createCapabilityLookup(models);
}
