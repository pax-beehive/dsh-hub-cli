import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, createCliRunner, createTools } from '../index.js'

const HASH = `sha256:${'a'.repeat(64)}`
const PLAN_ID = '11111111-1111-4111-8111-111111111111'
const SECRET = 'must-stay-local-secret-marker'
const context = { signal: new AbortController().signal }
const plan = { id: PLAN_ID, status: 'planned', kind: 'profile.edit', input: { profile: 'custom' } }
function toolset(run) { return new Map(createTools(run).map((tool) => [tool.name, tool])) }
async function execute(tools, name, args = {}, exec = context) { return tools.get(name).execute(args, exec) }
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-adapter-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// This real child fixture speaks the public CLI's NDJSON/exit-code protocol.
async function childFixture(t, options = {}) {
  const root = await temporary(t)
  const path = join(root, 'cli.mjs')
  await writeFile(path, `
const mode = process.argv[2];
if (mode === 'chunks') {
  const data = Buffer.from(JSON.stringify({text:'Chinese 中文'})+'\\n'+JSON.stringify({event:'done'})+'\\n');
  for (const byte of data) process.stdout.write(Buffer.from([byte]));
} else if (mode === 'blocked') {
  console.log(JSON.stringify({error:'PROFILE_UPGRADE_BLOCKED',contextHash:${JSON.stringify(HASH)},summary:{conflicts:[{id:'c1',choices:['local','upstream']}]}})); process.exitCode=2;
} else if (mode === 'preview-blocked') {
  console.log(JSON.stringify({status:'conflicted',contextHash:${JSON.stringify(HASH)},summary:{conflicts:[]}})); process.exitCode=2;
} else if (mode === 'nested-blocked') {
  console.log(JSON.stringify({profile:'custom',upgrade:{status:'conflicted',contextHash:${JSON.stringify(HASH)},summary:{conflicts:[{id:'c1',choices:['local','upstream']}]}}})); process.exitCode=2;
} else if (mode === 'invalid') { process.stdout.write('{"secret":"'+${JSON.stringify(SECRET)}); }
else if (mode === 'empty') {}
else if (mode === 'bad-exit2') { console.log(JSON.stringify({unrelated:true})); process.exitCode=2; }
else if (mode === 'error') { console.error(${JSON.stringify(SECRET)}); process.exitCode=1; }
else if (mode === 'runtime') { console.error('Run dsh-hub runtime prepare --runtime-version 0.1.1'); process.exitCode=1; }
else if (mode === 'large-out') { process.stdout.write('x'.repeat(4000)); setInterval(()=>{},1000); }
else if (mode === 'large-err') { process.stderr.write('x'.repeat(4000)); setInterval(()=>{},1000); }
else if (mode === 'wait') { setInterval(()=>{},1000); }
else if (mode === 'environment') {
  console.log(JSON.stringify({ visible:process.env.VISIBLE_INPUT, home:process.env.DSH_HOME,
    storedPresent:process.env.ADAPTER_SAVED_INPUT !== undefined,
    secondStoredPresent:process.env.ADAPTER_SECOND_SAVED_INPUT !== undefined,
    markerPresent:process.env.DSH_HUB_STORED_INPUT_KEYS !== undefined }));
}
`)
  return createCliRunner({ cliPath: path, ...options })
}

test('adapter registers real host definitions and delegates to the public CLI package', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies['@dsh-plugin-hub/cli'], 'workspace:*')
  const registered = []
  apply({ tools: { register(tool) { registered.push(tool) } } })
  const expected = ['search', 'plugin_info', 'plugin_plan', 'profile_edit_plan', 'profile_plan', 'profile_diff',
    'profile_upgrade_plan', 'profile_list', 'profile_status', 'profile_inputs', 'profile_run_preview',
    'runtime_prepare_guidance', 'profile_doctor', 'operation_apply', 'profile_share_plan', 'profile_rollback_plan', 'profile_history']
  assert.deepEqual(registered.map((tool) => tool.name).sort(), expected.map((name) => `dsh_hub_${name}`).sort())
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
  }
})

test('real child runner decodes complete multibyte NDJSON and preserves safe blocked contexts', async (t) => {
  const run = await childFixture(t)
  assert.deepEqual(await run(['chunks']), [{ text: 'Chinese 中文' }, { event: 'done' }])
  for (const mode of ['blocked', 'preview-blocked', 'nested-blocked']) {
    const [blocked] = await run([mode])
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.exitCode, 2)
    assert.equal(blocked.contextHash, HASH)
    assert.ok(blocked.summary.conflicts)
  }
})

test('runner waits for close, including data received after exit', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  const run = createCliRunner({ spawnProcess: (_node, _args, options) => {
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    queueMicrotask(() => {
      child.stdout.emit('data', '{"ready":')
      child.emit('exit', 0)
      child.stdout.emit('data', 'true}\n')
      child.emit('close', 0)
    })
    return child
  } })
  assert.deepEqual(await run([]), [{ ready: true }])
})

test('malformed/empty JSON, non-JSON errors and both byte caps fail without leaking output', async (t) => {
  const run = await childFixture(t, { maxStdoutBytes: 1000, maxStderrBytes: 1000 })
  for (const [mode, code] of [['invalid', 'CLI_INVALID_JSON'], ['empty', 'CLI_INVALID_JSON'],
    ['bad-exit2', 'CLI_FAILED'], ['error', 'CLI_FAILED'], ['large-out', 'CLI_OUTPUT_LIMIT'], ['large-err', 'CLI_OUTPUT_LIMIT']]) {
    await assert.rejects(run([mode]), (error) => {
      assert.equal(error.code, code)
      assert.ok(!String(error).includes(SECRET))
      return true
    })
  }
})

test('cancelled and unstartable child reject without hanging or raw subprocess diagnostics', async (t) => {
  const run = await childFixture(t)
  const controller = new AbortController()
  const pending = run(['wait'], controller.signal)
  setTimeout(() => controller.abort(), 40)
  await assert.rejects(pending, { code: 'CLI_ABORTED' })
  const missing = createCliRunner({ spawnProcess: () => { throw new Error(SECRET) } })
  await assert.rejects(missing([]), (error) => error.code === 'CLI_START_FAILED' && !String(error).includes(SECRET))
})

test('each real child receives explicit environment but no marked saved inputs or provenance marker', async (t) => {
  const env = { VISIBLE_INPUT: 'explicit-external-value', DSH_HOME: '/fixture/dsh', ADAPTER_SAVED_INPUT: SECRET,
    DSH_HUB_STORED_INPUT_KEYS: JSON.stringify({ v: 1, keys: ['ADAPTER_SAVED_INPUT'] }) }
  const run = await childFixture(t, { env })
  const [first] = await run(['environment'])
  assert.deepEqual(first, { visible: 'explicit-external-value', home: '/fixture/dsh', storedPresent: false, secondStoredPresent: false, markerPresent: false })
  assert.equal(env.ADAPTER_SAVED_INPUT, SECRET, 'sanitization must not mutate the host environment')
  assert.ok(env.DSH_HUB_STORED_INPUT_KEYS)
  env.ADAPTER_SECOND_SAVED_INPUT = 'second-private-sentinel'
  env.DSH_HUB_STORED_INPUT_KEYS = JSON.stringify({ v: 1, keys: ['ADAPTER_SAVED_INPUT', 'ADAPTER_SECOND_SAVED_INPUT'] })
  const [second] = await run(['environment'])
  assert.equal(second.secondStoredPresent, false, 'provenance must be evaluated for every spawn')
  assert.equal(second.storedPresent, false)
  assert.equal(second.visible, 'explicit-external-value')
  assert.ok(!JSON.stringify([first, second]).includes(SECRET))
  delete env.DSH_HUB_STORED_INPUT_KEYS
  const [external] = await run(['environment'])
  assert.equal(external.storedPresent, true, 'unmarked incoming values remain explicit external environment')
  assert.equal(external.secondStoredPresent, true)
  assert.equal(external.markerPresent, false)
})

test('malformed provenance and attempts to remove process keys fail before any child starts', async () => {
  let starts = 0
  const env = { VISIBLE_INPUT: 'external', ADAPTER_SAVED_INPUT: SECRET }
  const run = createCliRunner({ env, spawnProcess: () => { starts += 1; throw new Error('must not spawn') } })
  const invalidMarkers = [SECRET, '{', JSON.stringify({ v: 2, keys: [] }),
    ...['PATH', 'DSH_HOME', 'NODE_OPTIONS', 'DSH_HUB_TOKEN', 'DSH_HUB_STORED_INPUT_KEYS'].map((key) => JSON.stringify({ v: 1, keys: [key] }))]
  for (const marker of invalidMarkers) {
    env.DSH_HUB_STORED_INPUT_KEYS = marker
    await assert.rejects(run(['profile', 'list', '--json']), (error) => {
      assert.equal(error.code, 'CLI_INPUT_PROVENANCE_INVALID')
      assert.ok(!String(error).includes(marker))
      assert.ok(!String(error).includes(SECRET))
      return true
    })
  }
  assert.equal(starts, 0)
})

test('all local edits forward exact target, runtime and action through reviewed plans', async () => {
  const calls = []
  const tools = toolset(async (args, signal) => { calls.push(args); assert.equal(signal, context.signal); return [plan] })
  const edits = [
    [{ action: 'add', packageName: 'dsh-extra', version: '2.0.0', position: 1 }, ['install', 'dsh-extra', '--version', '2.0.0', '--position', '1']],
    ...['remove', 'enable', 'disable'].map((action) => [{ action, packageName: 'dsh-extra' }, ['profile', 'plugin', action, 'dsh-extra']]),
    [{ action: 'reorder', order: ['dsh-extra', '@deepseek-ai/dsh-base'] }, ['profile', 'plugin', 'reorder', 'dsh-extra', '@deepseek-ai/dsh-base']],
    [{ action: 'configure', patchFile: '/private/tmp/my patch.yml' }, ['profile', 'configure', '--file', '/private/tmp/my patch.yml']],
    [{ action: 'input-declare', inputKey: 'SERVICE_KEY', label: 'Service key', required: false, secret: false },
      ['profile', 'inputs', 'declare', 'SERVICE_KEY', '--label', 'Service key', '--optional', '--public-input']],
    [{ action: 'input-remove', inputKey: 'SERVICE_KEY' }, ['profile', 'inputs', 'undeclare', 'SERVICE_KEY']],
  ]
  for (const [intent, prefix] of edits) {
    const result = await execute(tools, 'dsh_hub_profile_edit_plan', { ...intent, profile: 'custom', runtimeVersion: '0.1.1' })
    assert.deepEqual(calls.at(-1), [...prefix, '--profile', 'custom', '--plan', '--json', '--runtime-version', '0.1.1'])
    assert.equal(result.review.required, true)
    assert.equal(result.review.planId, PLAN_ID)
  }
  await execute(tools, 'dsh_hub_plugin_plan', { packageName: 'dsh-extra', runtimeVersion: '0.1.1', position: 0 })
  assert.deepEqual(calls.at(-1), ['install', 'dsh-extra', '--version', 'latest', '--position', '0', '--profile', 'web', '--plan', '--json', '--runtime-version', '0.1.1'])
  const before = calls.length
  await assert.rejects(execute(tools, 'dsh_hub_profile_edit_plan', { action: 'configure', patchFile: 'x', value: SECRET }), /Unexpected tool argument/)
  await assert.rejects(execute(tools, 'dsh_hub_profile_edit_plan', { action: 'reorder', order: ['x', 'x'] }), /every enabled package/)
  await assert.rejects(execute(tools, 'dsh_hub_plugin_plan', { packageName: 'x', position: -1 }), /nonnegative/)
  assert.equal(calls.length, before)
})

test('structured choices round-trip privately into every relevant CLI preview/plan and files are removed', async () => {
  const paths = []
  const resolutions = { contextHash: HASH, choices: { 'safe/conflict/id': 'local' } }
  const tools = toolset(async (args) => {
    const path = args[args.indexOf('--resolutions') + 1]
    paths.push(path)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), resolutions)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700)
    return [plan]
  })
  for (const [name, args] of [
    ['dsh_hub_plugin_plan', { packageName: 'dsh-extra' }],
    ['dsh_hub_profile_edit_plan', { action: 'disable', packageName: 'dsh-extra' }],
    ['dsh_hub_profile_plan', { slug: 'starter' }],
    ['dsh_hub_profile_upgrade_plan', {}], ['dsh_hub_profile_diff', {}],
  ]) await execute(tools, name, { ...args, resolutions })
  for (const path of paths) await assert.rejects(access(path), { code: 'ENOENT' })
  let failedPath
  const failureTools = toolset(async (args) => { failedPath = args.at(-1); throw Object.assign(new Error('cancelled'), { code: 'CLI_ABORTED' }) })
  await assert.rejects(execute(failureTools, 'dsh_hub_profile_plan', { slug: 'starter', resolutions }), /cancelled/)
  await assert.rejects(access(failedPath), { code: 'ENOENT' })
  await assert.rejects(execute(tools, 'dsh_hub_profile_plan', { slug: 'starter', resolutions: { contextHash: HASH, choices: { id: SECRET } } }), /local or upstream/)
})

test('conflict → reviewed choices → new plan → confirmed apply keeps exact plan and never auto-confirms', async () => {
  const calls = []
  const tools = toolset(async (args) => {
    calls.push(args)
    if (args[0] === 'operation') return [{ type: 'operation.completed', planId: args[2] }]
    if (!args.includes('--resolutions')) return [{ status: 'blocked', exitCode: 2, contextHash: HASH, summary: { conflicts: [{ id: 'c1', choices: ['local', 'upstream'] }] } }]
    const choices = JSON.parse(await readFile(args.at(-1), 'utf8'))
    if (choices.contextHash !== HASH) return [{ status: 'blocked', exitCode: 2, contextHash: HASH, error: 'PROFILE_UPGRADE_BLOCKED' }]
    return [{ ...plan, input: { ...plan.input, resolutions: choices } }]
  })
  const blocked = await execute(tools, 'dsh_hub_profile_upgrade_plan')
  assert.equal(blocked.contextHash, HASH)
  assert.equal(blocked.review, undefined)
  const next = await execute(tools, 'dsh_hub_profile_upgrade_plan', { resolutions: { contextHash: blocked.contextHash, choices: { c1: 'local' } } })
  assert.equal(next.review.planId, PLAN_ID)
  const before = calls.length
  await assert.rejects(execute(tools, 'dsh_hub_operation_apply', { planId: next.id, confirmed: false }), /Explicit user confirmation/)
  assert.equal(calls.length, before)
  const applied = await execute(tools, 'dsh_hub_operation_apply', { planId: next.id, confirmed: true })
  assert.deepEqual(calls.at(-1), ['operation', 'apply', PLAN_ID, '--json'])
  assert.equal(applied.events[0].planId, PLAN_ID)
  const stale = await execute(tools, 'dsh_hub_profile_upgrade_plan', { resolutions: { contextHash: `sha256:${'b'.repeat(64)}`, choices: { c1: 'local' } } })
  assert.equal(stale.status, 'blocked')
  assert.equal(stale.id, undefined)
})

test('local readiness and run previews never set inputs, prepare caches or start a runtime', async () => {
  const calls = []
  const tools = toolset(async (args) => {
    calls.push(args)
    if (args[1] === 'list') return [[{ profile: 'custom', source: 'local' }]]
    if (args[1] === 'status') return [{ healthy: false, source: 'local', inputs: [{ key: 'SERVICE_KEY', configured: false }], checks: [{ id: 'required-input', status: 'failed' }] }]
    return [{ profile: 'custom', runtimeVersion: '0.1.1' }]
  })
  assert.equal((await execute(tools, 'dsh_hub_profile_list')).profiles[0].source, 'local')
  const inputs = await execute(tools, 'dsh_hub_profile_inputs', { profile: 'custom' })
  assert.match(inputs.localEntry.command, /inputs set '<KEY>' --profile custom/)
  const preview = await execute(tools, 'dsh_hub_profile_run_preview', { profile: 'custom' })
  assert.equal(preview.ready, false)
  assert.equal(preview.inputs[0].configured, false)
  assert.deepEqual(calls.at(-1), ['profile', 'run', '--profile', 'custom', '--dry-run', '--json'])
  const before = calls.length
  const guidance = await execute(tools, 'dsh_hub_runtime_prepare_guidance', { runtimeVersion: '0.1.1' })
  assert.equal(calls.length, before)
  assert.equal(guidance.command, 'dsh-hub runtime prepare --runtime-version 0.1.1')
  await assert.rejects(execute(tools, 'dsh_hub_runtime_prepare_guidance', { runtimeVersion: 'latest' }), /exact semantic version/)
})

test('cold-cache errors give preparation instructions without executing preparation', async (t) => {
  const run = await childFixture(t)
  const tools = toolset((_args, signal) => run(['runtime'], signal))
  const result = await execute(tools, 'dsh_hub_plugin_plan', { packageName: 'dsh-extra', runtimeVersion: '0.1.1' })
  assert.equal(result.status, 'blocked')
  assert.equal(result.error, 'RUNTIME_PREPARATION_REQUIRED')
  assert.equal(result.nextStep.command, 'dsh-hub runtime prepare --runtime-version 0.1.1')
  const previewTools = toolset((args, signal) => args[1] === 'status' ? Promise.resolve([{ healthy: true }]) : run(['runtime'], signal))
  const preview = await execute(previewTools, 'dsh_hub_profile_run_preview')
  assert.equal(preview.status, 'blocked')
  assert.equal(preview.ready, false)
  assert.match(preview.nextStep.command, /runtime prepare/)
})

test('doctor/history/share/rollback outputs keep configuration contents out of host results', async () => {
  const snapshot = { source: 'local', runtime: { version: '0.1.1' }, bundles: [{ packageName: 'dsh-extra', version: '2.0.0' }],
    authorBaseline: { manifest: { custom: SECRET }, patch: SECRET }, patchYaml: SECRET, values: { SERVICE_KEY: SECRET } }
  const tools = toolset(async (args) => {
    if (args[1] === 'doctor') return [{ current: snapshot, inputs: [{ key: 'SERVICE_KEY', configured: true, source: 'stored' }] }]
    if (args[1] === 'history') return [[{ id: 'revision', state: snapshot }]]
    return [{ ...plan, input: { target: snapshot, draft: { patch: [{ secret: SECRET }], patchYaml: SECRET }, profile: 'custom' } }]
  })
  for (const [name, args] of [['dsh_hub_profile_doctor', {}], ['dsh_hub_profile_history', {}],
    ['dsh_hub_profile_share_plan', { slug: 'starter', version: '1.0.0' }], ['dsh_hub_profile_rollback_plan', {}]]) {
    const result = await execute(tools, name, args)
    assert.ok(!JSON.stringify(result).includes(SECRET))
    assert.match(JSON.stringify(result), /redacted/)
  }
  const doctor = await execute(tools, 'dsh_hub_profile_doctor')
  assert.deepEqual(doctor.current.values, { redacted: true })
})

async function runtimeFixture(home) {
  const prefix = join(home, '.hub', 'runtimes', '0.1.1', 'node_modules', '@deepseek-ai')
  const runtime = join(prefix, 'dsh'), boot = join(prefix, 'dsh-app-boot')
  await mkdir(join(runtime, 'bin'), { recursive: true })
  await mkdir(join(boot, 'lib'), { recursive: true })
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1', bin: 'bin/dsh.js' }))
  await writeFile(join(runtime, 'bin', 'dsh.js'), "throw new Error('read-only adapter tests must never execute the runtime')")
  await writeFile(join(boot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '0.1.1', main: 'lib/index.js' }))
  await writeFile(join(boot, 'lib', 'index.js'), 'export const PROFILE_TEMPLATES = {web:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"],headless:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}; export const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];')
  for (const name of ['dsh-base', 'dsh-web-app', 'dsh-headless']) {
    const directory = join(prefix, name)
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.1.2', dsh: { bundle: { patch: 'patch.yml' } } }))
    await writeFile(join(directory, 'patch.yml'), '[]\n')
  }
}

test('actual local CLI: warm-cache first local plan, private inputs/status/run preview and stale context', async (t) => {
  const root = await temporary(t), home = join(root, 'dsh')
  await mkdir(home)
  await runtimeFixture(home)
  const tools = toolset(createCliRunner({ env: { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_HUB_TELEMETRY: '0' } }))
  assert.deepEqual((await execute(tools, 'dsh_hub_profile_list')).profiles, [])
  const patchFile = join(root, 'local patch.yml')
  await writeFile(patchFile, `- id: private\n  config:\n    token: ${SECRET}\n`)
  const cold = await execute(tools, 'dsh_hub_profile_edit_plan', { action: 'configure', profile: 'custom', runtimeVersion: '9.9.9', patchFile })
  assert.equal(cold.error, 'RUNTIME_PREPARATION_REQUIRED')
  assert.equal(cold.nextStep.command, 'dsh-hub runtime prepare --runtime-version 9.9.9')
  const created = await execute(tools, 'dsh_hub_profile_edit_plan', { action: 'configure', profile: 'custom', runtimeVersion: '0.1.1', patchFile })
  assert.equal(created.status, 'planned')
  assert.equal(created.effect.source, 'local')
  assert.equal(created.effect.authorBaseline, 'not_applicable')
  assert.equal(created.input.runtimeVersion, '0.1.1')
  assert.equal(created.input.intent.patchFile, patchFile)
  assert.equal(created.input.authorBaseline, undefined)
  assert.ok(!JSON.stringify(created).includes(SECRET))
  await assert.rejects(access(join(home, 'profiles', 'custom')), { code: 'ENOENT' })
  assert.equal((await readdir(join(home, '.hub', 'operations'))).length, 1)
  await assert.rejects(execute(tools, 'dsh_hub_profile_edit_plan', { action: 'configure', profile: 'custom', runtimeVersion: '0.1.1', patchFile,
    resolutions: { contextHash: HASH, choices: {} } }), { code: 'CLI_FAILED' })
  assert.equal((await readdir(join(home, '.hub', 'operations'))).length, 1)

  const directory = join(home, 'profiles', 'custom')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  for (const [tool, args] of [['dsh_hub_profile_run_preview', {}], ['dsh_hub_profile_share_plan', { slug: 'fixture', version: '1.0.0' }]]) {
    const missing = await execute(tools, tool, { ...args, profile: 'custom' })
    assert.equal(missing.error, 'RUNTIME_SELECTION_REQUIRED')
    assert.equal(missing.nextStep.tool, 'dsh_hub_profile_status')
    assert.ok(!JSON.stringify(missing).includes('runtime prepare'))
  }
  const stateDirectory = join(home, '.hub', 'installations', 'custom')
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(join(stateDirectory, 'current.json'), JSON.stringify({ schemaVersion: 2, profile: 'custom', source: 'local',
    runtime: { version: '0.1.1', range: '^0.1.1' }, bundles: [], dependencies: [], inputs: [{ key: 'ADAPTER_TEST_KEY', label: 'Test key', required: true, secret: true }] }))
  const inputsDirectory = join(home, '.hub', 'inputs')
  await mkdir(inputsDirectory, { mode: 0o700 })
  await writeFile(join(inputsDirectory, 'custom.json'), JSON.stringify({ schemaVersion: 1, values: { ADAPTER_TEST_KEY: SECRET } }), { mode: 0o600 })
  const inputs = await execute(tools, 'dsh_hub_profile_inputs', { profile: 'custom' })
  assert.equal(inputs.inputs.find((input) => input.key === 'ADAPTER_TEST_KEY').source, 'stored')
  const status = await execute(tools, 'dsh_hub_profile_status', { profile: 'custom' })
  assert.equal(status.source, 'local')
  assert.equal(status.runtimeVersion, '0.1.1')
  const preview = await execute(tools, 'dsh_hub_profile_run_preview', { profile: 'custom' })
  assert.equal(preview.runtimeVersion, '0.1.1')
  assert.equal(preview.ready, true)
  for (const [tool, args] of [['dsh_hub_profile_run_preview', {}], ['dsh_hub_profile_share_plan', { slug: 'fixture', version: '1.0.0' }]]) {
    const mismatch = await execute(tools, tool, { ...args, profile: 'custom', runtimeVersion: '2.0.0' })
    assert.equal(mismatch.error, 'RUNTIME_PIN_MISMATCH')
    assert.equal(mismatch.nextStep.tool, 'dsh_hub_profile_status')
    assert.ok(!JSON.stringify(mismatch).includes('runtime prepare'))
  }
  for (const result of [inputs, status, preview]) assert.ok(!JSON.stringify(result).includes(SECRET))
  assert.equal((await readdir(join(home, '.hub', 'operations'))).length, 1)
  await writeFile(join(directory, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  const blocked = await execute(tools, 'dsh_hub_profile_edit_plan', { action: 'input-declare', profile: 'custom', inputKey: 'ANOTHER_KEY' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.error, 'PROFILE_UPGRADE_BLOCKED')
  assert.match(blocked.contextHash, /^sha256:/)
  assert.ok(blocked.summary.conflicts.some((conflict) => conflict.path === 'pnpm-lock.yaml'))
  assert.equal((await readdir(join(home, '.hub', 'operations'))).length, 1)
  const choices = Object.fromEntries(blocked.summary.conflicts.map((conflict) => [conflict.id, 'upstream']))
  const resolved = await execute(tools, 'dsh_hub_profile_edit_plan', { action: 'input-declare', profile: 'custom', inputKey: 'ANOTHER_KEY',
    resolutions: { contextHash: blocked.contextHash, choices } })
  assert.equal(resolved.status, 'planned')
  assert.equal(resolved.input.intent.declaration.key, 'ANOTHER_KEY')
  assert.equal((await readdir(join(home, '.hub', 'operations'))).length, 2)
})

test('actual CLI author apply/upgrade preserve nested safe conflicts and accept reviewed choices without network', async (t) => {
  const root = await temporary(t), home = join(root, 'dsh'), directory = join(home, 'profiles', 'custom')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'personal-profile', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), `- id: personal\n  config:\n    token: ${SECRET}\n`)
  const release = { schemaVersion: 1, version: '1.0.0', name: 'Author fixture', description: '', dsh: '*',
    runtime: { range: '*', version: '0.1.1' },
    bundles: [{ packageName: '@deepseek-ai/dsh-base', selector: '0.1.2', version: '0.1.2',
      sourceKind: 'builtin', installSpec: 'builtin:@deepseek-ai/dsh-base@0.1.2', before: [], after: [] }],
    patch: [], patchYaml: '- id: author\n  config:\n    mode: author\n', inputs: [], publishedAt: '2026-09-17T00:00:00.000Z' }
  const profile = { id: PLAN_ID, slug: 'author-fixture', owner: 'fixture', latestVersion: release.version,
    versions: [release], createdAt: release.publishedAt, updatedAt: release.publishedAt }
  // The real CLI executes in a child. A preload replaces fetch entirely, so
  // no sockets, registries, package installation or live API calls occur.
  const preload = join(root, 'fixture-fetch.mjs')
  await writeFile(preload, `globalThis.fetch = async (url) => {
    if (String(url).endsWith('/profiles/author-fixture')) return new Response(${JSON.stringify(JSON.stringify(profile))}, {headers:{'content-type':'application/json'}});
    throw new Error('Network disabled by adapter fixture');
  };`)
  const tools = toolset(createCliRunner({
    env: { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_HUB_TELEMETRY: '0' },
    spawnProcess: (node, args, options) => spawn(node, ['--import', preload, ...args], options),
  }))
  for (const name of ['dsh_hub_profile_plan', 'dsh_hub_profile_upgrade_plan']) {
    const blocked = await execute(tools, name, { slug: 'author-fixture', profile: 'custom' })
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.exitCode, 2)
    assert.equal(blocked.upgrade.status, 'conflicted')
    assert.equal(blocked.contextHash, blocked.upgrade.contextHash)
    assert.equal(blocked.summary.conflicts.length, blocked.upgrade.summary.conflicts.length)
    assert.ok(blocked.summary.conflicts.length > 0)
    assert.ok(!JSON.stringify(blocked).includes(SECRET))
    await assert.rejects(access(join(home, '.hub', 'operations')), { code: 'ENOENT' })
    const choices = Object.fromEntries(blocked.summary.conflicts.map((conflict) => [conflict.id, conflict.choices.includes('local') ? 'local' : 'upstream']))
    const planned = await execute(tools, name, { slug: 'author-fixture', profile: 'custom',
      resolutions: { contextHash: blocked.contextHash, choices } })
    assert.equal(planned.status, 'planned')
    assert.equal(planned.input.profile, 'custom')
    assert.deepEqual(planned.input.resolutions, { contextHash: blocked.contextHash, choices })
    assert.equal(planned.review.planId, planned.id)
    assert.ok(!JSON.stringify(planned).includes(SECRET))
    // Remove only this test's saved plan to independently prove the second
    // conflict path persists no plan and never changes the active Profile.
    await rm(join(home, '.hub', 'operations'), { recursive: true })
  }
  assert.match(await readFile(join(directory, 'cordis.patch.yml'), 'utf8'), new RegExp(SECRET))
  await assert.rejects(access(join(home, '.hub', 'installations')), { code: 'ENOENT' })
})
