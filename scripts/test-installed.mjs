/** Integration against the installed DSH runtime; inference stays on a local mock gateway. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the installed app.asar/dsh runtime directory');
const runtime = resolve(process.argv[2]);
async function load(name) {
  const directory = join(runtime, 'node_modules', '@deepseek-ai', name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return import(pathToFileURL(join(directory, manifest.main ?? 'lib/index.js')).href);
}
const { Context } = await load('cordis');
const { default: Loader } = await load('cordis-plugin-loader');
const { default: Llm, createUserMessage } = await load('dsh-llm');
const overlay = await import(pathToFileURL(resolve('lib/index.js')).href);
const requests = [];
const gateway = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url, body: JSON.parse(text) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/responses') {
      const message = { id: 'mock-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
      const response = { id: 'mock-response', object: 'response', status: 'completed', model: 'gpt-6-fixture', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0,
        item: { ...message, status: 'in_progress', content: [] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', item_id: message.id, output_index: 0,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: message.id, output_index: 0,
        content_index: 0, delta: 'ok' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: message })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
      return;
    }
    const base = { id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-fixture' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
const address = gateway.address();
assert.ok(address && typeof address !== 'string');
const raw = { providers: { relay: {
  api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'LOCAL_FIXTURE_KEY',
  models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }, { id: 'gpt-999-unknown' }, { id: 'gpt-4o' }, { id: 'custom-reasoner' }, { id: 'gpt-6-disabled', reasoningEfforts: false }],
} } };
const original = structuredClone(raw);
raw.providers.responses = { ...raw.providers.relay, api: 'openai-responses', models: [{ id: 'gpt-6.1-sol' }] };
Object.assign(original, structuredClone(raw));
const ctx = new Context();
let persisted = 0;
try {
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(runtime, 'package.json')).href });
  // An in-memory Loader must never receive writes from the overlay.
  ctx.loader.write = () => { persisted++; };
  await ctx.plugin(Llm);
  ctx.provide('profileContext', { installAnchor: join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') });
  ctx.provide('credentials', { resolve: async () => ({ value: 'local-fixture-key' }) });
  const entryId = await ctx.loader.create({ id: 'relay-adapter', name: '@deepseek-ai/dsh-llm-pi-ai', config: raw });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(entryId);
  assert.equal(entry.fiber.state, 2, 'real pi-ai adapter must be active');
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-6.1-sol')).reasoning, undefined);
  const baselineWrites = persisted;
  const enabled = await ctx.plugin(overlay, {});
  assert.equal(enabled.state, 2, 'overlay must activate');
  const model = await ctx.llm.resolveModelInfo('relay', 'gpt-6.1-sol');
  assert.deepEqual(model.reasoning.efforts.map(x => x.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual((await ctx.llm.resolveModelInfo('relay', 'gpt-6-sol')).reasoning.efforts.map(x => x.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-999-unknown')).reasoning, undefined);
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-4o')).reasoning, undefined);
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-6-disabled')).reasoning, undefined);
  assert.deepEqual(entry.options.config, original, 'raw provider config must remain unchanged');
  assert.equal(persisted, baselineWrites, 'enabling must not persist provider edits');
  const send = async (model, effort, provider = 'relay') => {
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider, model, reasoningEffort: effort,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply ok' }], source: { kind: 'user' } })],
      signal: new AbortController().signal,
    })) chunks.push(chunk);
    assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind !== 'error'), JSON.stringify(chunks));
  };
  await send('gpt-6.1-sol', 'high');
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  assert.equal(requests.at(-1).path, '/v1/chat/completions');
  await send('gpt-6.1-sol', 'medium', 'responses');
  assert.equal(requests.at(-1).path, '/v1/responses');
  assert.equal(requests.at(-1).body.reasoning.effort, 'medium');
  await send('gpt-6-sol', 'off');
  assert.equal(requests.at(-1).body.reasoning_effort, 'none');
  const updated = structuredClone(raw);
  updated.providers.relay.models.push({ id: 'gpt-6-luna' });
  await entry.update({ config: updated });
  await ctx.loader.await();
  assert.deepEqual((await ctx.llm.resolveModelInfo('relay', 'gpt-6-luna')).reasoning.efforts.map(x => x.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  const writesAfterUserUpdate = persisted;
  const prepared = await ctx.llm.prepareCall({ provider: 'relay', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  await enabled.dispose();
  await ctx.loader.await();
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-6.1-sol')).reasoning, undefined);
  assert.deepEqual(entry.options.config, updated);
  assert.equal(persisted, writesAfterUserUpdate, 'unloading must not persist provider edits');
  const heldChunks = [];
  for await (const chunk of prepared.stream({ ...prepared.config,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Prepared before disabling' }], source: { kind: 'user' } })],
    signal: new AbortController().signal,
  })) heldChunks.push(chunk);
  assert.ok(heldChunks.some(c => c.type === 'finish' && c.reason.kind !== 'error'), JSON.stringify(heldChunks));
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  const custom = await ctx.plugin(overlay, { autoGpt: false, rules: [{ provider: 'relay', model: 'custom-*', efforts: { off: 'none', low: 'low', max: 'ultra' } }] });
  assert.equal(custom.state, 2);
  assert.deepEqual((await ctx.llm.resolveModelInfo('relay', 'custom-reasoner')).reasoning.efforts.map(x => x.id), ['off', 'low', 'max']);
  await send('custom-reasoner', 'max');
  assert.equal(requests.at(-1).body.reasoning_effort, 'ultra');
  await send('custom-reasoner', 'off');
  assert.equal(requests.at(-1).body.reasoning_effort, 'none');
  assert.equal((await ctx.llm.resolveModelInfo('relay', 'gpt-6.1-sol')).reasoning, undefined);
  await custom.dispose();
  assert.equal(persisted, writesAfterUserUpdate);
  console.log(JSON.stringify({ ok: true, nativeEfforts: model.reasoning.efforts.map(x => x.id),
    wireValues: requests.map(x => x.body.reasoning_effort ?? x.body.reasoning?.effort),
    hotUpdate: true, preparedCallPreserved: true, unloadRestored: true, providerWrites: 0 }));
} finally {
  await ctx.fiber.dispose();
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
}
