import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityLookup, type CatalogModel } from '../src/catalog.ts';
import { enrichCapabilities, type Options } from '../src/capabilities.ts';

const levels = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } as const;
const models: CatalogModel[] = [
  { provider: 'openai', id: 'gpt-6.1-sol', reasoning: true, thinkingLevelMap: levels },
  { provider: 'openai', id: 'gpt-6-sol', reasoning: true, thinkingLevelMap: { ...levels, off: 'none' } },
  { provider: 'openai', id: 'gpt-5-chat-latest', reasoning: false },
  { provider: 'deepseek', id: 'deepseek-v4-pro', reasoning: true, thinkingFormat: 'deepseek',
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } },
];
const lookup = createCapabilityLookup(models);
const options: Options = { autoCatalog: true, defaultEfforts: [], rules: [] };
const raw = (id: string) => ({ providers: { relay: { api: 'openai-completions', models: [{ id }] } } });
function first(value: unknown): Record<string, unknown> {
  return (value as { providers: { relay: { models: Record<string, unknown>[] } } }).providers.relay.models[0];
}

test('exact catalog models offer five or six levels, preserving none wire spelling', () => {
  assert.deepEqual(lookup('relay', 'gpt-6.1-sol')?.efforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(lookup('relay', 'gpt-6-sol')?.efforts, { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(first(enrichCapabilities(raw('gpt-6-sol'), options, lookup)).reasoningEfforts, lookup('relay', 'gpt-6-sol')?.efforts);
});

test('changing the connected model automatically changes the offered levels', () => {
  const five = first(enrichCapabilities(raw('gpt-6.1-sol'), options, lookup));
  const two = first(enrichCapabilities(raw('deepseek-v4-pro'), options, lookup));
  assert.equal(Object.keys(five.reasoningEfforts as object).length, 5);
  assert.deepEqual(two.reasoningEfforts, { high: 'high', max: 'max' });
  assert.deepEqual(two.compat, { supportsReasoningEffort: true, thinkingFormat: 'deepseek' });
});

test('unknown model names gain no invented capabilities by default', () => {
  const input = raw('gpt-999-unknown');
  assert.equal(enrichCapabilities(input, options, lookup), input);
  const plain = raw('gpt-5-chat-latest');
  assert.equal(enrichCapabilities(plain, { ...options, defaultEfforts: ['high'] }, lookup), plain);
});

test('explicit relay limits override the reference model catalog', () => {
  const input = raw('gpt-6-sol');
  const changed = enrichCapabilities(input, { ...options, rules: [{ provider: 'relay', model: '*', efforts: { high: 'high' } }] }, lookup);
  assert.deepEqual(first(changed).reasoningEfforts, { high: 'high' });
  assert.deepEqual(input, raw('gpt-6-sol'));
});

test('provider-prefixed IDs resolve their exact catalog owner', () => {
  assert.deepEqual(lookup('relay', 'openai/gpt-6-sol'), lookup('openai', 'gpt-6-sol'));
  assert.equal(lookup('relay', 'invented/gpt-6-sol'), undefined);
});

test('ambiguous non-GPT provider mappings require an explicit provider', () => {
  const resolve = createCapabilityLookup([
    { provider: 'a', id: 'custom', reasoning: true, thinkingLevelMap: levels },
    { provider: 'b', id: 'custom', reasoning: true, thinkingLevelMap: { ...levels, max: null } },
  ]);
  assert.equal(resolve('relay', 'custom'), undefined);
  assert.ok(resolve('a', 'custom')?.efforts);
  assert.ok(resolve('b', 'custom')?.efforts);
});
