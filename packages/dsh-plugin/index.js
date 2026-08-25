import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-plugin-hub-tools'
export const inject = ['tools']

const cli = fileURLToPath(import.meta.resolve('@dsh-plugin-hub/cli/bin'))

function run(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 100_000) stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `dsh-hub exited ${code}`))
      else resolve(stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    })
  })
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dsh_hub_profile_plan',
    description: 'Create a non-mutating, exact and preconditioned plan to install or upgrade a public DSH Hub Profile. Present the plan to the user before applying it.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Hub Profile slug.' },
      profile: { type: 'string', description: 'Local target Profile name (default web).' },
      version: { type: 'string', description: 'Profile Release version (default latest).' },
    },
    output,
    async execute(args, exec) {
      const values = ['profile', 'apply', args.slug, '--profile', args.profile ?? 'web', '--version', args.version ?? 'latest', '--plan', '--json']
      const events = await run(values, exec.signal)
      return events[0] ?? {}
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_hub_operation_apply',
    description: 'Apply a previously reviewed DSH Hub install, share, or rollback plan. Set confirmed=true only after the user explicitly confirms that exact plan.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan UUID returned by any DSH Hub planning tool.' },
      confirmed: { type: 'boolean', required: true, description: 'Must reflect explicit user confirmation of this plan.' },
    },
    output,
    async execute(args, exec) {
      if (args.confirmed !== true) throw new Error('Explicit user confirmation is required')
      const events = await run(['operation', 'apply', args.planId, '--json'], exec.signal)
      return { planId: args.planId, events }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_hub_profile_share_plan',
    description: 'Create a non-mutating plan to publish the exact current local Profile as an immutable Hub Release. Review the captured layers and local input contract before applying it.',
    parameters: {
      slug: { type: 'string', required: true, description: 'New or owned Hub Profile slug.' },
      version: { type: 'string', required: true, description: 'Exact SemVer for the immutable Release.' },
      profile: { type: 'string', description: 'Local source Profile name (default web).' },
      displayName: { type: 'string', description: 'Public Profile name.' },
      description: { type: 'string', description: 'Public Profile description.' },
      runtimeVersion: { type: 'string', description: 'Exact DSH runtime; auto-detected when omitted.' },
    },
    output,
    async execute(args, exec) {
      const values = ['profile', 'share', args.slug, '--profile', args.profile ?? 'web', '--version', args.version, '--plan', '--json']
      if (args.displayName) values.push('--display-name', args.displayName)
      if (args.description) values.push('--description', args.description)
      if (args.runtimeVersion) values.push('--runtime-version', args.runtimeVersion)
      const events = await run(values, exec.signal)
      return events[0] ?? {}
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_hub_profile_rollback_plan',
    description: 'Create a non-mutating plan to restore one complete local Profile revision. Review the exact target revision before applying it.',
    parameters: {
      profile: { type: 'string', description: 'Local Profile name (default web).' },
      revision: { type: 'string', description: 'Revision ID; defaults to the newest recoverable revision.' },
    },
    output,
    async execute(args, exec) {
      const values = ['profile', 'rollback']
      if (args.revision) values.push(args.revision)
      values.push('--profile', args.profile ?? 'web', '--plan', '--json')
      const events = await run(values, exec.signal)
      return events[0] ?? {}
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_hub_profile_history',
    description: 'List locally recoverable revisions for a DSH Profile. This is read-only.',
    parameters: { profile: { type: 'string', description: 'Local Profile name (default web).' } },
    output,
    async execute(args, exec) {
      const events = await run(['profile', 'history', '--profile', args.profile ?? 'web', '--json'], exec.signal)
      return { revisions: events[0] ?? [] }
    },
  }))
}
