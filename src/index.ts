/** Non-persistent pi-ai capability overlay for the native DSH model/effort menu. */

import type { Context, Fiber } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-app-boot';
import z from '@deepseek-ai/schemastery';
import { EFFORTS, enrichCapabilities, validateOptions, type Options } from './capabilities.ts';
import { loadInstalledCatalog, type CapabilityLookup } from './catalog.ts';

/** Plugin identifier displayed by Cordis. */
export const name = 'model-thinking';
/** Loader owns the provider entries whose raw configuration remains unchanged. */
export const inject = ['loader'];
/** Optional automatic GPT detection and explicit gateway effort mappings. */
export const Config = z.object({
  autoCatalog: z.boolean().default(true),
  autoGpt: z.boolean(),
  defaultEfforts: z.array(z.union(EFFORTS)).default([]),
  rules: z.array(z.object({
    provider: z.string().default('*'),
    model: z.string().required(),
    efforts: z.dict(z.union([z.string(), z.const(null)]), z.union(EFFORTS)).required(),
  })).default([]),
});

const TARGET = '@deepseek-ai/dsh-llm-pi-ai';

/**
 * Enrich effective provider config and restore raw capabilities when disabled.
 * @param ctx - root-profile Loader context.
 * @param options - validated plugin defaults and model-specific rules.
 * @returns fulfillment once already active pi-ai instances use the overlay.
 */
export async function apply(ctx: Context, options: Options): Promise<void> {
  validateOptions(options);
  let lookup: CapabilityLookup = () => undefined;
  if (options.autoGpt ?? options.autoCatalog ?? true) {
    const anchor = ctx.get('profileContext')?.installAnchor;
    if (anchor) {
      try { lookup = await loadInstalledCatalog(anchor); }
      catch (error) { ctx.logger.warn('model-thinking: built-in capability catalog unavailable; explicit rules remain usable: %s', String(error)); }
    }
  }
  const release = ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const value: unknown = next();
    if (this.entry?.options.name !== TARGET || this.parent.fiber.entry === this.entry) return value;
    return enrichCapabilities(value, options, lookup);
  }, { global: true, prepend: true });

  const refresh = async () => {
    for (const entry of ctx.loader.entries()) {
      const fiber = entry.fiber;
      if (entry.options.name !== TARGET || entry.disabled || fiber?.state !== 2) continue;
      // noSave keeps provider YAML and the next raw reload free of this overlay.
      fiber.update(entry.options.config, true);
      await fiber.await();
      if (fiber.state !== 2) throw new Error(`Could not reload ${entry.id}; inspect its plugin error`);
    }
  };
  ctx.effect(() => async () => {
    release();
    await refresh();
  });
  await refresh();
}
