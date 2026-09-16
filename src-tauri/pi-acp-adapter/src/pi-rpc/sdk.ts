import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve only inside the verified capability-runtime distribution, including packaged launches.
export async function loadPiSdk(nodePath = process.execPath) {
  try {
    const root = join(dirname(nodePath), '..', 'node_modules', '@earendil-works/pi-coding-agent')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg.version !== '0.84.3') throw new Error()
    const sdk = await import(pathToFileURL(join(root, 'dist/index.js')).href)
    if (typeof sdk.ModelRuntime?.create !== 'function') throw new Error()
    return sdk
  } catch {
    throw new Error('The pinned Pi assistance SDK is unavailable')
  }
}
