import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
)

function run(args) {
  return spawnSync(bin, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: root,
    shell: process.platform === 'win32'
  })
}

const pty = run(['-f', '-o', 'node-pty'])
if (pty.status !== 0) {
  console.warn(
    '[postinstall] node-pty electron-rebuild skipped (no MSVC toolchain); keep a previously built binary or install VS Build Tools'
  )
}

const serial = run(['-f', '-o', '@serialport/bindings-cpp'])
if (serial.status !== 0) {
  console.warn(
    '[postinstall] serialport electron-rebuild skipped (no MSVC toolchain); using @serialport/bindings-cpp N-API prebuilds'
  )
}
