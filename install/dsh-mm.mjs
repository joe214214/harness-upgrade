#!/usr/bin/env node
// dsh-mm [web|headless] [args...] — DeepSeek Harness with the multimodal and memory packages.
// Setup copies this file next to dsh-mm.json, which names the harness, the overlay, and the DSH_HOME folder.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { dsh, overlay, home, local } = JSON.parse(readFileSync(join(here, 'dsh-mm.json'), 'utf8'))
// overlay.local.yml holds the user's own changes and is applied last, so they win.
const patches = ['--patch', overlay, ...local && existsSync(local) ? ['--patch', local] : []]
const args = process.argv.slice(2)
const profile = ['web', 'headless'].includes(args[0]) ? args.shift() : 'web'

const child = spawn(process.execPath, [
  '--import', pathToFileURL(join(dsh, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
  join(dsh, 'apps', 'cli', 'src', 'bin.ts'), profile, ...patches, ...args,
], { stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'), ...home ? { DSH_HOME: home } : {} } })
// The child owns the terminal and handles interrupts itself.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {})
child.on('exit', (code, signal) => { process.exit(code ?? (signal === null ? 0 : 1)) })
