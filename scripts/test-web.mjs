/** Exercise the packaged Web profile and native effort menu against a local gateway. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, symlink, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

if (!process.argv[2]) throw new Error('Pass the installed app.asar/dsh runtime directory');
const runtime = resolve(process.argv[2]);
const output = resolve('.test-output');
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(output, 'web-'));
const profile = join(home, 'profiles', 'web');
const documents = join(home, 'documents');
const modelId = process.env.DSH_TEST_MODEL ?? 'gpt-6.1-sol';
const desiredLevel = process.env.DSH_TEST_EFFORT ?? 'max';
const expectedLabels = modelId === 'gpt-6-sol' ? ['Off', 'Low', 'Medium', 'High', 'Xhigh', 'Max'] : ['Low', 'Medium', 'High', 'Xhigh', 'Max'];
const desiredLabel = desiredLevel.charAt(0).toUpperCase() + desiredLevel.slice(1);
await mkdir(join(profile, 'node_modules'), { recursive: true });
await mkdir(documents);
const pluginPath = resolve(process.env.DSH_TEST_PLUGIN_PATH ?? '.');
const pluginVersion = JSON.parse(await readFile(join(pluginPath, 'package.json'), 'utf8')).version;
await symlink(pluginPath, join(profile, 'node_modules', 'dsh-model-thinking'), 'junction');
const extraBundles = [];
if (process.env.DSH_TEST_SLIDER_PATH) {
  await symlink(resolve(process.env.DSH_TEST_SLIDER_PATH), join(profile, 'node_modules', 'dsh-codex-effort-slider'), 'junction');
  extraBundles.push('dsh-codex-effort-slider');
}
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-model-thinking': pluginVersion },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...extraBundles, 'dsh-model-thinking'] } },
}));
await writeFile(join(profile, 'cordis.yml'), '[]\n');
await writeFile(join(home, 'cordis.patch.yml'), '[]\n');
let notifyRequest;
const requested = new Promise(resolve => { notifyRequest = resolve; });
const requests = [];
const gateway = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const value = JSON.parse(body);
  requests.push({ path: req.url, model: value.model, effort: value.reasoning_effort });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'mock-ui', object: 'chat.completion.chunk', created: 1, model: value.model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
  notifyRequest();
});
await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
const gatewayAddress = gateway.address();
assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: { 'local-relay': { displayName: 'Local test relay',
    api: 'openai-completions', baseURL: `http://127.0.0.1:${gatewayAddress.port}/v1`, apiKeyEnv: 'LOCAL_FIXTURE_KEY',
    models: [{ id: modelId, name: 'GPT test relay' }],
  } } } },
  { id: 'agent-default-model', config: { provider: 'local-relay', model: modelId } },
  { id: 'locale', config: { preference: 'en' } },
  { id: 'workspace-controller', config: { documentsDirectory: documents } },
], null, 2));
const executable = process.env.DSH_TEST_EXECUTABLE ?? process.execPath;
const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
let browser;
let host;
let bootLog = '';
let stderr = '';
let bootTimer;
try {
  const ready = new Promise((resolve, reject) => {
    host = spawn(executable, [cli, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: home, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1', LOCAL_FIXTURE_KEY: 'local-fixture-key', DEEPSEEK_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bootTimer = setTimeout(() => reject(new Error(`Web boot timed out: ${stderr}`)), 60000);
    host.stdout.on('data', chunk => {
      bootLog += chunk;
      const match = bootLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (match) { clearTimeout(bootTimer); resolve(match[1]); }
    });
    host.stderr.on('data', chunk => { stderr += chunk; });
    host.once('error', reject);
    host.once('exit', code => reject(new Error(`Web exited ${code}: ${stderr}`)));
  });
  const authUrl = await ready;
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_TEST_BROWSER_CHANNEL ?? 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Select model/ }).first().waitFor({ timeout: 30000 });
  await writeFile(join(output, 'ui-body.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: join(output, 'ui-before-menu.png'), animations: 'disabled' });
  if (process.env.DSH_TEST_INSPECT_UI === '1') throw new Error('Initial UI snapshot captured for inspection');
  if (await page.getByText('Preview Notice', { exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await page.getByRole('button', { name: /Select model/ }).first().click();
  const prefix = extraBundles.length > 0 ? 'slider-effort' : 'native-effort';
  if (extraBundles.length > 0) {
    const slider = page.getByRole('slider', { name: '推理等级' });
    await slider.waitFor();
    assert.equal(Number(await slider.getAttribute('aria-valuemax')), expectedLabels.length - 1);
    await slider.press(desiredLevel === 'off' ? 'Home' : 'End');
    await page.waitForFunction(label => document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext') === label, desiredLabel);
    await page.getByRole('button', { name: new RegExp(`Select model, current .*reasoning effort ${desiredLabel}`) }).waitFor();
  } else {
    const effortRow = page.getByRole('menuitem', { name: /effort/i });
    await effortRow.waitFor();
    await effortRow.click();
    for (const name of expectedLabels) await page.getByText(name, { exact: true }).waitFor();
  }
  await page.screenshot({ path: join(output, `${prefix}-light.png`), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(output, `${prefix}-dark.png`), animations: 'disabled' });
  if (extraBundles.length > 0) await page.keyboard.press('Escape');
  else await page.getByText(desiredLabel, { exact: true }).click();
  await page.locator('[contenteditable="true"]').last().fill('Reply with ok');
  await page.locator('[contenteditable="true"]').last().press('Enter');
  const requestTimer = setTimeout(() => notifyRequest(), 20000);
  await requested;
  clearTimeout(requestTimer);
  assert.ok(requests.length > 0, 'submitting from the native composer must reach the local gateway');
  assert.equal(requests.at(-1).effort, desiredLevel === 'off' ? 'none' : desiredLevel);
  assert.equal(requests.at(-1).model, modelId);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, model: modelId, nativeMenu: expectedLabels, uiSubmittedEffort: requests.at(-1).effort,
    existingSlider: extraBundles.length > 0, screenshots: [`${prefix}-light.png`, `${prefix}-dark.png`] }));
} finally {
  clearTimeout(bootTimer);
  await browser?.close();
  if (host && host.exitCode === null) {
    const exited = new Promise(resolve => host.once('exit', resolve));
    host.kill();
    await exited;
  }
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  await writeFile(join(output, 'web-boot.log'), bootLog.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>'));
  await writeFile(join(output, 'web-errors.log'), stderr);
}
