import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichCapabilities, validateOptions, type Options } from '../src/capabilities.ts';

const options: Options = { autoGpt: true, defaultEfforts: ['low', 'medium', 'high'], rules: [] };
const config = (models: object[], api = 'openai-completions') => ({
  providers: { relay: { api, baseURL: 'http://localhost/v1', apiKeyEnv: 'TEST_KEY', models } },
});
const transformed = (raw: ReturnType<typeof config>, opts = options) => enrichCapabilities(raw, opts) as ReturnType<typeof config>;
const first = (raw: ReturnType<typeof config>): Record<string, unknown> => raw.providers.relay.models[0] as Record<string, unknown>;

test('custom GPT declarations gain native efforts without changing the source', () => {
  const raw = config([{ id: 'gpt-6-fixture', contextWindow: 200000, compat: { supportsStore: false } }]);
  const before = structuredClone(raw);
  const enriched = transformed(raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(first(enriched).reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.deepEqual(first(enriched).compat, { supportsStore: false, supportsReasoningEffort: true, thinkingFormat: 'openai' });
  assert.equal(enriched.providers.relay.apiKeyEnv, raw.providers.relay.apiKeyEnv);
});

test('unsupported families, GPT Chat aliases and unrelated protocols keep their configuration', () => {
  for (const id of ['gpt-4o', 'gpt-5-chat-latest', 'claude-opus', 'deepseek-v4', 'embedding-model']) {
    const raw = config([{ id }]);
    assert.equal(transformed(raw), raw, id);
  }
  const raw = config([{ id: 'gpt-6-fixture' }], 'anthropic-messages');
  assert.equal(transformed(raw), raw);
});

test('explicit effort declarations and opt-outs take precedence', () => {
  for (const reasoningEfforts of [false, { high: 'high', max: 'ultra' }]) {
    const raw = config([{ id: 'gpt-6-fixture', reasoningEfforts }]);
    assert.equal(transformed(raw), raw);
  }
  const raw = config([{ id: 'gpt-6-fixture', compat: { supportsReasoningEffort: false } }]);
  assert.equal(transformed(raw), raw);
});

test('route compatibility opt-outs and alternative wire formats remain authoritative', () => {
  for (const compat of [{ supportsReasoningEffort: false }, { thinkingFormat: 'deepseek' }]) {
    const raw = { providers: { relay: { ...config([{ id: 'gpt-6-fixture' }]).providers.relay, compat } } };
    assert.equal(transformed(raw), raw);
  }
});

test('explicit rules map gateway wire values and match the provider/model pair', () => {
  const opts: Options = { ...options, autoGpt: false, rules: [
    { provider: 'relay', model: 'custom-*', efforts: { high: 'high', max: 'ultra' } },
    { provider: '*', model: '*', efforts: { medium: 'medium' } },
  ] };
  const enriched = transformed(config([{ id: 'custom-reasoner' }]), opts);
  assert.deepEqual(first(enriched).reasoningEfforts, { high: 'high', max: 'ultra' });
  assert.deepEqual(first(transformed(config([{ id: 'other' }]), opts)).reasoningEfforts, { medium: 'medium' });
});

test('Responses models gain effort metadata without Chat Completions compatibility switches', () => {
  const enriched = transformed(config([{ id: 'gpt-6-fixture' }], 'openai-responses'));
  assert.deepEqual(first(enriched).reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.equal(first(enriched).compat, undefined);
});

test('existing modelOverrides are supported without replacing their catalog', () => {
  const raw = { providers: { relay: { api: 'openai-completions', modelOverrides: { 'gpt-5.4': { maxTokens: 5000 } } } } };
  const expected = structuredClone(raw);
  const enriched = enrichCapabilities(raw, options) as { providers: { relay: { modelOverrides: Record<string, Record<string, unknown>> } } };
  assert.equal(enriched.providers.relay.modelOverrides['gpt-5.4'].maxTokens, 5000);
  assert.deepEqual(enriched.providers.relay.modelOverrides['gpt-5.4'].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.deepEqual(raw, expected);
});

test('a second overlay is idempotent and disabled auto mode keeps the original', () => {
  const raw = config([{ id: 'gpt-6-fixture' }]);
  const enriched = transformed(raw);
  assert.equal(transformed(enriched), enriched);
  assert.equal(transformed(raw, { ...options, autoGpt: false }), raw);
});

test('an empty fallback is accepted; off-only and invalid wire mappings are rejected', () => {
  validateOptions({ ...options, defaultEfforts: [] });
  assert.throws(() => validateOptions({ ...options, defaultEfforts: ['off'] }), /thinking level/);
  assert.throws(() => validateOptions({ ...options, defaultEfforts: ['high', 'high'] }), /repeats/);
  for (const efforts of [{ high: null }, { high: '' }, { off: null }]) {
    assert.throws(() => validateOptions({ ...options, rules: [{ provider: '*', model: '*', efforts }] }));
  }
  validateOptions({ ...options, rules: [{ provider: '*', model: '*', efforts: { off: null, high: 'high' } }] });
});
