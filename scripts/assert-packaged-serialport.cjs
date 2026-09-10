'use strict'

// afterPack assertion: the packaged app must ship the serialport module and its
// native binding, otherwise `import('serialport')` fails at runtime and the
// settings-page USB device list (USB CDC) stays empty.
//
// Invoked by scripts/assert-packaged-tray-assets.cjs (the build.afterPack entry):
//   assertPackagedSerialport({ resourcesDir, platform, arch })
//
// Standalone check against an existing build output:
//   node scripts/assert-packaged-serialport.cjs win-unpacked [--platform win32] [--arch x64]
//
// appOutDir is electron-builder's output directory (e.g. win-unpacked); on
// macOS the .app bundle path works too.

const { closeSync, existsSync, openSync, readSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')

const BINDINGS_MODULE = join('node_modules', '@serialport', 'bindings-cpp')
// electron-rebuild output (node-gyp-build loads it first) or the shipped prebuilds.
const BUILT_BINDING_DIRS = [join('build', 'Release'), join('build', 'Debug')]
// asar layout: [4-byte pickle size][4-byte header size][4-byte json length][json]
const ASAR_JSON_OFFSET = 16

function listNativeBinaries(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.node'))
  } catch (error) {
    return []
  }
}

function prebuildDirNames(platform, arch) {
  switch (platform) {
    case 'win32':
      return [`win32-${arch}`]
    case 'darwin':
      return ['darwin-x64+arm64', `darwin-${arch}`]
    case 'linux':
      return [`linux-${arch}`]
    default:
      return []
  }
}

// dlopen can only load real files, so the binding must exist on disk under
// app.asar.unpacked even when serialport's JS sources stay inside app.asar.
function findPackagedBinding(resourcesDir, platform, arch) {
  const bindingsDir = join(resourcesDir, 'app.asar.unpacked', BINDINGS_MODULE)
  const candidates = [
    ...BUILT_BINDING_DIRS.map((rel) => join(bindingsDir, rel)),
    ...prebuildDirNames(platform, arch).map((name) => join(bindingsDir, 'prebuilds', name))
  ]
  return candidates.find((dir) => listNativeBinaries(dir).length > 0) || null
}

// Minimal asar header reader (no third-party deps).
function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const prefix = Buffer.alloc(ASAR_JSON_OFFSET)
    readSync(fd, prefix, 0, ASAR_JSON_OFFSET, 0)
    if (prefix.readUInt32LE(0) !== 4) {
      throw new Error(`Not a valid asar archive: ${asarPath}`)
    }
    const jsonSize = prefix.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(jsonSize)
    readSync(fd, jsonBuf, 0, jsonSize, ASAR_JSON_OFFSET)
    return JSON.parse(jsonBuf.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

function asarHasSerialport(asarPath) {
  const nodeModules = readAsarHeader(asarPath).files.node_modules
  return Boolean(nodeModules && nodeModules.files && nodeModules.files.serialport)
}

function expectedBindingPaths(platform, arch) {
  return [
    ...BUILT_BINDING_DIRS,
    ...prebuildDirNames(platform, arch).map((name) => join('prebuilds', name))
  ]
    .map((rel) => `${BINDINGS_MODULE}/${rel}`.replace(/\\/g, '/'))
    .join(' or ')
}

function assertPackagedSerialport({ resourcesDir, platform = process.platform, arch = process.arch }) {
  const appAsar = join(resourcesDir, 'app.asar')
  if (!existsSync(appAsar)) {
    throw new Error(`Packaged app.asar was not found: ${appAsar}`)
  }
  if (!asarHasSerialport(appAsar)) {
    throw new Error(
      'Packaged app.asar is missing node_modules/serialport; import(\'serialport\') will fail and the ' +
        'settings-page USB device list (USB CDC) will be empty. Keep serialport in "dependencies" and ' +
        'in build.files so electron-builder collects it.'
    )
  }
  const bindingDir = findPackagedBinding(resourcesDir, platform, arch)
  if (!bindingDir) {
    throw new Error(
      `No ${platform}-${arch} serialport native binding in app.asar.unpacked (expected ${expectedBindingPaths(platform, arch)}); ` +
        'USB CDC devices will be unusable in the packaged app. Run npm install so @serialport/bindings-cpp ' +
        'ships its prebuilds, and keep build.asarUnpack covering **/*.node.'
    )
  }
  return bindingDir
}

function resolveResourcesDir(appOutDir) {
  if (appOutDir.endsWith('.app') && existsSync(appOutDir)) {
    return join(appOutDir, 'Contents', 'Resources')
  }
  if (existsSync(join(appOutDir, 'app.asar'))) {
    return appOutDir
  }
  return join(appOutDir, 'resources')
}

function parseArgs(argv) {
  const options = { appOutDir: null, platform: process.platform, arch: process.arch }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inlineValue] = arg.split('=', 2)
    if (flag === '--platform' || flag === '--arch') {
      const key = flag.slice(2)
      options[key] = inlineValue !== undefined ? inlineValue : argv[++i]
      if (options[key] === undefined) throw new Error(`Missing value for ${flag}`)
    } else if (!flag.startsWith('--') && options.appOutDir === null) {
      options.appOutDir = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  return options
}

module.exports = { assertPackagedSerialport, readAsarHeader }

if (require.main === module) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(
      'Usage: node scripts/assert-packaged-serialport.cjs <appOutDir> [--platform win32] [--arch x64]'
    )
    process.exit(1)
  }
  if (!options.appOutDir) {
    console.error(
      'Usage: node scripts/assert-packaged-serialport.cjs <appOutDir> [--platform win32] [--arch x64]'
    )
    process.exit(1)
  }
  try {
    const resourcesDir = resolveResourcesDir(options.appOutDir)
    const bindingDir = assertPackagedSerialport({
      resourcesDir,
      platform: options.platform,
      arch: options.arch
    })
    console.log(
      `serialport packaged OK (${options.platform}-${options.arch} binding: ${relative(resourcesDir, bindingDir)})`
    )
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
