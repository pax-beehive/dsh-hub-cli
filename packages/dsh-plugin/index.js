import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { stripStoredInputEnvironment } from '@dsh-plugin-hub/cli'

export const name = 'dsh-plugin-hub-tools'
export const inject = ['tools']
const cli = fileURLToPath(import.meta.resolve('@dsh-plugin-hub/cli/bin'))

// Injection is for subprocess boundary tests; production always uses the public CLI.
export function createCliRunner({ spawnProcess = spawn, cliPath = cli, env = process.env,
  maxStdoutBytes = 1_000_000, maxStderrBytes = 100_000 } = {}) {
  return (args, signal) => new Promise((resolve, reject) => {
    let child
    let settled = false
    const fail = (code, message) => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error(message), { code }))
    }
    let childEnvironment
    try { childEnvironment = stripStoredInputEnvironment(env) }
    catch {
      fail('CLI_INPUT_PROVENANCE_INVALID', 'Local input provenance is invalid; relaunch the Profile through dsh-hub before using agent tools')
      return
    }
    try {
      child = spawnProcess(process.execPath, [cliPath, ...args], {
        env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], signal,
      })
    } catch { fail('CLI_START_FAILED', 'Could not start the local dsh-hub CLI'); return }
    const stdout = [], stderr = []
    let outBytes = 0, errBytes = 0
    const collect = (chunks, limit, stream) => (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stream === 'stdout') outBytes += buffer.length
      else errBytes += buffer.length
      if ((stream === 'stdout' ? outBytes : errBytes) > limit) {
        fail('CLI_OUTPUT_LIMIT', 'dsh-hub output exceeded the safe limit; inspect this operation locally')
        child.kill()
        return
      }
      chunks.push(buffer)
    }
    child.stdout.on('data', collect(stdout, maxStdoutBytes, 'stdout'))
    child.stderr.on('data', collect(stderr, maxStderrBytes, 'stderr'))
    child.once('error', (error) => fail(error.name === 'AbortError' ? 'CLI_ABORTED' : 'CLI_START_FAILED',
      error.name === 'AbortError' ? 'dsh-hub operation was cancelled' : 'Could not start the local dsh-hub CLI'))
    // close waits for all stdout/stderr, while exit can precede the last chunk.
    child.once('close', (code, exitSignal) => {
      if (settled) return
      if (exitSignal || signal?.aborted) { fail('CLI_ABORTED', 'dsh-hub operation was cancelled'); return }
      if (code !== 0 && code !== 2) {
        const diagnostic = Buffer.concat(stderr).toString('utf8')
        if (/This Profile is pinned to runtime |The Profile's recorded runtime is [^\n;]+; omit --runtime-version|An author Profile's runtime is pinned by its Release/.test(diagnostic)) {
          fail('RUNTIME_PIN_MISMATCH', 'The requested runtime differs from the Profile pin; omit the override or explicitly plan a runtime change first')
        } else if (/No recorded runtime;|This Profile has no recorded exact runtime;|No exact runtime is recorded for this local Profile;/.test(diagnostic)) {
          fail('RUNTIME_SELECTION_REQUIRED', 'This Profile has no recorded runtime; choose an explicit exact runtime version')
        } else if (/Run dsh-hub runtime prepare --runtime-version/.test(diagnostic)) {
          fail('RUNTIME_PREPARATION_REQUIRED', 'Prepare the selected exact runtime cache locally, then repeat the plan')
        } else {
          fail('CLI_FAILED', `dsh-hub exited ${code}; inspect the command locally for details`)
        }
        return
      }
      let events
      try {
        events = Buffer.concat(stdout).toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
        if (!events.length) throw new Error()
      } catch { fail('CLI_INVALID_JSON', 'dsh-hub returned incomplete or invalid JSON'); return }
      if (code === 2) {
        const blocked = events.at(-1)
        const preview = blocked?.upgrade ?? blocked
        if (!blocked || typeof blocked !== 'object' || Array.isArray(blocked) ||
            !['conflicted', 'baseline_required'].includes(preview?.status) && blocked.error !== 'PROFILE_UPGRADE_BLOCKED' && blocked.error !== 'PROFILE_BASELINE_REQUIRED') {
          fail('CLI_FAILED', 'dsh-hub could not produce an executable plan; inspect the command locally'); return
        }
        events = [{ ...blocked, status: 'blocked', exitCode: 2,
          contextHash: preview.contextHash, summary: preview.summary,
          ...(preview.status ? { blockedReason: preview.status } : {}) }]
      }
      settled = true
      resolve(events)
    })
  })
}
const run = createCliRunner()

// Local history and publication plans can contain full configuration snapshots.
// Keep values on disk while retaining a fingerprint for the user's local review.
const privateFields = new Set(['patch', 'patchYaml', 'cordisPatch', 'manifest', 'config', 'values', 'env', 'environment', 'envOverrides'])
const secretFields = new Set(['values', 'env', 'environment', 'envOverrides'])
export function safeOutput(value) {
  if (Array.isArray(value)) return value.map(safeOutput)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (privateFields.has(key)) {
      if (secretFields.has(key)) return [key, { redacted: true }]
      const body = JSON.stringify(item) ?? ''
      return [key, { redacted: true, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }]
    }
    return [key, safeOutput(item)]
  }))
}

const profileParameter = { type: 'string', description: 'Explicit local target Profile name (default web); use list/status to select it.' }
const runtimeParameter = { type: 'string', description: 'Exact DSH runtime. Defaults to the Profile recorded version; required for a new or unrecorded Profile. Prepare a cold cache locally first.' }
const resolutionsParameter = {
  type: 'object', additionalProperties: false,
  description: 'Choices reviewed by the user for this exact preview context. Replanning binds them; changing the Profile invalidates the context.',
  properties: {
    contextHash: { type: 'string', required: true, description: 'Exact sha256 contextHash returned by the blocked preview.' },
    choices: { type: 'object', required: true, additionalProperties: true, description: 'Map every conflict ID to local or upstream, as offered by that conflict.' },
  },
}
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
function profileName(args) {
  const value = args.profile ?? 'web'
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..' || value.startsWith('-')) throw new Error('Use a valid local Profile name')
  return value
}
function argument(value, label) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0')) throw new Error(`Provide ${label}`)
  return value
}
function runtimeOptions(args, values) {
  if (args.runtimeVersion !== undefined) values.push('--runtime-version', exactRuntime(args.runtimeVersion))
  return values
}
function exactRuntime(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) {
    throw new Error('runtimeVersion must be an exact semantic version')
  }
  return value
}
function shellCommand(args) { return ['dsh-hub', ...args].map((value) => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ') }
function runtimeGuidance(runtimeVersion) {
  return { tool: 'local_cli', command: shellCommand(['runtime', 'prepare', '--runtime-version', runtimeVersion ?? '<exact-semver>']),
    message: 'Run this locally after reviewing the exact runtime. It downloads packages and may run install scripts; the agent tools do not run it.' }
}
async function withResolutions(args, values, action) {
  if (!args.resolutions) return action(values)
  const data = args.resolutions
  if (typeof data.contextHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(data.contextHash) ||
      !data.choices || typeof data.choices !== 'object' || Array.isArray(data.choices) ||
      Object.entries(data.choices).some(([id, choice]) => !id || id.length > 1024 || !['local', 'upstream'].includes(choice))) {
    throw new Error('Use the exact preview contextHash and conflict IDs with local or upstream choices')
  }
  const body = JSON.stringify({ contextHash: data.contextHash, choices: data.choices })
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Conflict resolutions exceed 64 KiB')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-hub-agent-resolutions-'))
  try {
    await chmod(directory, 0o700)
    const path = join(directory, 'choices.json')
    await writeFile(path, body, { mode: 0o600, flag: 'wx' })
    return await action([...values, '--resolutions', path])
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function reviewPlan(value) {
  if (value?.status !== 'planned' || !value.id) return value
  return { ...value, review: { required: true, planId: value.id,
    instruction: 'Present this exact plan: target Profile, source, runtime, package versions/order, inputs, conflicts and effects. Have the user inspect any redacted configuration locally before confirming this plan ID. Apply only after explicit confirmation; any change requires a new plan.' } }
}
function editArguments(args) {
  const action = args.action
  if (action === 'add') {
    const values = ['install', argument(args.packageName, 'packageName'), '--version', argument(args.version ?? 'latest', 'version')]
    if (args.position !== undefined) {
      if (!Number.isInteger(args.position) || args.position < 0) throw new Error('position must be a nonnegative integer')
      values.push('--position', String(args.position))
    }
    return values
  }
  if (['remove', 'enable', 'disable'].includes(action)) return ['profile', 'plugin', action, argument(args.packageName, 'packageName')]
  if (action === 'reorder') {
    if (!Array.isArray(args.order) || !args.order.length || new Set(args.order).size !== args.order.length) throw new Error('order must contain every enabled package once')
    return ['profile', 'plugin', 'reorder', ...args.order.map((name) => argument(name, 'package names in order'))]
  }
  if (action === 'configure') return ['profile', 'configure', '--file', argument(args.patchFile, 'a local patchFile path; keep its values out of tool arguments')]
  if (action === 'input-declare' || action === 'input-remove') {
    if (typeof args.inputKey !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(args.inputKey)) throw new Error('inputKey must be an uppercase environment key')
    const values = ['profile', 'inputs', action === 'input-declare' ? 'declare' : 'undeclare', args.inputKey]
    if (action === 'input-declare') {
      if (args.label !== undefined) values.push('--label', args.label)
      if (args.required === false) values.push('--optional')
      if (args.secret === false) values.push('--public-input')
    }
    return values
  }
  throw new Error('Choose a supported local edit action')
}

// Exported registration factory lets tests exercise actual defineTool validation.
export function createTools(runCli = run) {
  const tools = []
  function register(name, description, parameters, execute) {
    tools.push(defineTool({ name, description, parameters, output,
      async execute(args, exec) {
        // The host's root schema is open; reject unadvertised value/config args.
        if (Object.keys(args).some((key) => !Object.hasOwn(parameters, key))) throw new Error('Unexpected tool argument; input values and configuration content must stay local')
        return safeOutput(await execute(args, exec))
      },
    }))
  }
  async function invoke(args, exec, values, { plan = false, resolutions = false } = {}) {
    try {
      const events = resolutions
        ? await withResolutions(args, values, (command) => runCli(command, exec.signal))
        : await runCli(values, exec.signal)
      const result = events[0] ?? {}
      return plan ? reviewPlan(result) : result
    } catch (error) {
      if (error.code === 'RUNTIME_PREPARATION_REQUIRED') {
        return { status: 'blocked', error: error.code, message: error.message, nextStep: runtimeGuidance(args.runtimeVersion) }
      }
      if (error.code === 'RUNTIME_PIN_MISMATCH' || error.code === 'RUNTIME_SELECTION_REQUIRED') {
        return { status: 'blocked', error: error.code, message: error.message,
          nextStep: { tool: 'dsh_hub_profile_status', arguments: { profile: profileName(args) },
            message: error.code === 'RUNTIME_PIN_MISMATCH'
              ? 'Use the recorded runtime for this operation. To change it, review a local configure plan or a Hub Release with the desired runtime first.'
              : 'Inspect the Profile and choose an explicit exact runtimeVersion before retrying.' } }
      }
      throw error
    }
  }
  register('dsh_hub_search', 'Search the live Plugin Hub catalog. Read-only.', {
    query: { type: 'string', required: true, description: 'Plugin name, capability or task.' },
  }, (args, exec) => invoke(args, exec, ['search', argument(args.query, 'a search query'), '--json']))
  register('dsh_hub_plugin_info', 'Inspect a Plugin selected version, immutable source, compatibility and published security assessment. Read-only.', {
    packageName: { type: 'string', required: true }, version: { type: 'string' },
  }, (args, exec) => invoke(args, exec, ['info', argument(args.packageName, 'packageName'), '--version', argument(args.version ?? 'latest', 'version'), '--json']))
  register('dsh_hub_plugin_plan', 'Plan adding a Plugin to a new, existing local or author Profile, preserving personal changes. Review the exact source/version/security and target before applying. A cold runtime cache needs local preparation.', {
    packageName: { type: 'string', required: true }, profile: profileParameter, version: { type: 'string' },
    runtimeVersion: runtimeParameter, position: { type: 'integer', description: 'Zero-based enabled bundle position.' }, resolutions: resolutionsParameter,
  }, (args, exec) => invoke(args, exec, runtimeOptions(args, [...editArguments({ ...args, action: 'add' }), '--profile', profileName(args), '--plan', '--json']), { plan: true, resolutions: true }))
  register('dsh_hub_profile_edit_plan', 'Plan one local edit with the shared staged install and rollback transaction. Keeps author baseline intact. Configure accepts only a local file path; input declarations accept metadata, never values. Review the returned plan before applying.', {
    action: { type: 'string', required: true, enum: ['add', 'remove', 'enable', 'disable', 'reorder', 'configure', 'input-declare', 'input-remove'] },
    profile: profileParameter, runtimeVersion: runtimeParameter, resolutions: resolutionsParameter,
    packageName: { type: 'string' }, version: { type: 'string', description: 'Plugin selector for add; resolved to exact version/source.' },
    position: { type: 'integer' }, order: { type: 'array', items: { type: 'string' }, description: 'Every enabled bundle in desired order.' },
    patchFile: { type: 'string', description: 'Path to an existing local patch file, never its contents.' },
    inputKey: { type: 'string' }, label: { type: 'string', description: 'Public display label; never a secret value.' },
    required: { type: 'boolean', description: 'Input declaration is required by default.' },
    secret: { type: 'boolean', description: 'Input declaration is secret by default; author requirements cannot be weakened.' },
  }, (args, exec) => invoke(args, exec, runtimeOptions(args, [...editArguments(args), '--profile', profileName(args), '--plan', '--json']), { plan: true, resolutions: true }))

  for (const [name, command, requiredSlug, plan] of [
    ['dsh_hub_profile_plan', 'apply', true, true],
    ['dsh_hub_profile_diff', 'diff', false, false],
    ['dsh_hub_profile_upgrade_plan', 'upgrade', false, true],
  ]) register(name, `${plan ? 'Create a reviewed plan to' : 'Read-only preview to'} ${command} a public Hub Release while preserving local changes. Blocked results include safe conflicts and contextHash; pass reviewed resolutions to retry.`, {
    slug: { type: 'string', ...(requiredSlug ? { required: true } : {}), description: 'Hub Preset slug; otherwise use the installed author identity.' },
    profile: profileParameter, version: { type: 'string', description: 'Hub Release version, default latest.' }, resolutions: resolutionsParameter,
  }, (args, exec) => {
    const values = ['profile', command]
    if (args.slug) values.push(argument(args.slug, 'a Hub slug'))
    values.push('--profile', profileName(args), '--version', argument(args.version ?? 'latest', 'version'))
    if (plan) values.push('--plan')
    return invoke(args, exec, [...values, '--json'], { plan, resolutions: true })
  })

  register('dsh_hub_profile_list', 'List local Profiles with source (local, author or unmanaged), recorded runtime and readiness. Reads local state only.', {}, async (args, exec) => ({ profiles: await invoke(args, exec, ['profile', 'list', '--json']) }))
  register('dsh_hub_profile_status', 'Inspect one local Profile source, recorded runtime, drift and input readiness without configuration values. Reads local state only.', { profile: profileParameter },
    (args, exec) => invoke(args, exec, ['profile', 'status', '--profile', profileName(args), '--json']))
  register('dsh_hub_profile_inputs', 'Read local input readiness and precedence without values. To set a secret, give the user the local hidden-prompt command; never ask for its value in chat or tool arguments.', { profile: profileParameter }, async (args, exec) => ({
    ...await invoke(args, exec, ['profile', 'inputs', 'list', '--profile', profileName(args), '--json']),
    localEntry: { command: shellCommand(['profile', 'inputs', 'set', '<KEY>', '--profile', profileName(args)]),
      message: 'Run locally and enter the value at the hidden prompt. Never send it to the agent. Environment values override saved values; DSH_HOME is runtime-managed.' },
  }))
  register('dsh_hub_profile_run_preview', 'Preview launching the local Profile with its exact recorded runtime. Reads local status and required-input readiness; does not launch a process or prepare a runtime cache.', {
    profile: profileParameter, runtimeVersion: runtimeParameter,
  }, async (args, exec) => {
    const status = await invoke(args, exec, ['profile', 'status', '--profile', profileName(args), '--json'])
    const preview = await invoke(args, exec, runtimeOptions(args, ['profile', 'run', '--profile', profileName(args), '--dry-run', '--json']))
    if (preview.status === 'blocked') return { ...preview, ready: false, checks: status.checks, inputs: status.inputs }
    return { ...preview, ready: status.healthy === true, checks: status.checks, inputs: status.inputs,
      nextStep: { command: shellCommand(runtimeOptions(args, ['profile', 'run', '--profile', profileName(args)])), message: 'Run locally when ready; launching may prepare the exact runtime cache.' } }
  })
  register('dsh_hub_runtime_prepare_guidance', 'Give the local command to prepare an exact runtime cache. This tool never installs packages; runtime preparation downloads packages and may execute scripts and must be run locally by the user.', {
    runtimeVersion: { type: 'string', required: true, description: 'Exact DSH SemVer to prepare.' },
  }, async (args) => {
    exactRuntime(args.runtimeVersion)
    return runtimeGuidance(args.runtimeVersion)
  })
  register('dsh_hub_profile_doctor', 'Diagnose local files, installed dependencies and inputs, optionally comparing the selected Hub Release. Configuration snapshots are redacted; use status for an entirely local check.', {
    slug: { type: 'string' }, profile: profileParameter, version: { type: 'string' },
  }, (args, exec) => {
    const values = ['profile', 'doctor']
    if (args.slug) values.push(argument(args.slug, 'a Hub slug'))
    return invoke(args, exec, [...values, '--profile', profileName(args), '--version', argument(args.version ?? 'latest', 'version'), '--json'])
  })
  register('dsh_hub_operation_apply', 'Apply a previously reviewed, single-use plan. Set confirmed=true only after the user explicitly confirms this exact plan ID, target and effects. Changed targets or choices require replanning.', {
    planId: { type: 'string', required: true }, confirmed: { type: 'boolean', required: true },
  }, async (args, exec) => {
    if (args.confirmed !== true) throw new Error('Explicit user confirmation is required')
    const events = await runCli(['operation', 'apply', argument(args.planId, 'planId'), '--json'], exec.signal)
    if (events.at(-1)?.status === 'blocked') return events.at(-1)
    return { planId: args.planId, events }
  })
  register('dsh_hub_profile_share_plan', 'Plan publishing the current enabled bundles and their fixed sources, runtime, patch and input declarations as an immutable Hub Release. Extra files, ordinary/disabled dependencies and manifest overrides are excluded. Inspect configuration locally before confirming; saved input values are never published.', {
    slug: { type: 'string', required: true }, version: { type: 'string', required: true }, profile: profileParameter,
    displayName: { type: 'string' }, description: { type: 'string' },
    runtimeVersion: { type: 'string', description: 'Defaults to the recorded Profile runtime. Required if unrecorded; an explicit different version is rejected. Never inferred from global dsh.' },
  }, (args, exec) => {
    const values = ['profile', 'share', argument(args.slug, 'a Hub slug'), '--profile', profileName(args), '--version', argument(args.version, 'an exact Release version'), '--plan', '--json']
    if (args.displayName) values.push('--display-name', args.displayName)
    if (args.description) values.push('--description', args.description)
    return invoke(args, exec, runtimeOptions(args, values), { plan: true })
  })
  register('dsh_hub_profile_rollback_plan', 'Plan restoring a complete local revision, including return to unmanaged state. Review the exact target revision before applying; private configuration snapshots stay local.', {
    profile: profileParameter, revision: { type: 'string' },
  }, (args, exec) => {
    const values = ['profile', 'rollback']
    if (args.revision) values.push(argument(args.revision, 'revision'))
    return invoke(args, exec, [...values, '--profile', profileName(args), '--plan', '--json'], { plan: true })
  })
  register('dsh_hub_profile_history', 'List recoverable local revisions. Configuration snapshots are redacted.', { profile: profileParameter },
    async (args, exec) => ({ revisions: await invoke(args, exec, ['profile', 'history', '--profile', profileName(args), '--json']) }))
  return tools
}

export function apply(ctx) {
  for (const tool of createTools()) ctx.tools.register(tool)
}
