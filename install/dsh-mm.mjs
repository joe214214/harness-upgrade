#!/usr/bin/env node
// dsh-mm [web|headless] [args...] — DeepSeek Harness with the multimodal and memory packages.
// Setup copies this file next to dsh-mm.json, which names the patched checkout and the overlay.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { dsh, overlay } = JSON.parse(readFileSync(join(here, 'dsh-mm.json'), 'utf8'))
const args = process.argv.slice(2)
const profile = ['web', 'headless'].includes(args[0]) ? args.shift() : 'web'

const child = spawn(process.execPath, [
  '--import', pathToFileURL(join(dsh, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
  join(dsh, 'apps', 'cli', 'src', 'bin.ts'), profile, '--patch', overlay, ...args,
], { stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json') } })
// The child owns the terminal and handles interrupts itself.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {})
child.on('exit', (code, signal) => { process.exit(code ?? (signal === null ? 0 : 1)) })
