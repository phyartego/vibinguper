const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

// Explicit .cjs extension: extension-less require() does not resolve .cjs files.
const { assertPackagedSerialport } = require('./assert-packaged-serialport.cjs')

const REQUIRED_TRAY_ASSETS = [
  'vibing-16.png',
  'vibing-32.png',
  'vibing-white-16.png',
  'vibing-white-32.png',
  'vibingTemplate-16.png',
  'vibingTemplate-32.png'
]

function packagedResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return join(context.appOutDir, 'resources')
  }
  const appBundle = readdirSync(context.appOutDir).find((name) =>
    name.endsWith('.app')
  )
  if (!appBundle) throw new Error('Packaged macOS app bundle was not found')
  return join(context.appOutDir, appBundle, 'Contents', 'Resources')
}

// build.afterPack entry: verifies the packaged tray assets and the packaged
// serialport native module (see assert-packaged-serialport.cjs).
exports.default = async function afterPack(context) {
  const resourcesDir = packagedResourcesDir(context)

  const trayDir = join(resourcesDir, 'tray')
  const missing = REQUIRED_TRAY_ASSETS.filter(
    (filename) => !existsSync(join(trayDir, filename))
  )
  if (missing.length > 0) {
    throw new Error(`Packaged tray assets are missing: ${missing.join(', ')}`)
  }

  assertPackagedSerialport({
    resourcesDir,
    platform: context.electronPlatformName,
    arch: context.arch
  })
}
