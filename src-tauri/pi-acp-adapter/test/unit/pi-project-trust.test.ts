import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('Host project trust maps only to the official Pi CLI flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-trust-'))
  const command = join(root, 'pi-fixture')
  const saved = process.env.FARFOLD_PI_PROJECT_TRUST
  writeFileSync(
    command,
    `#!/usr/bin/python3
import sys,json
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'type':'response','id':request['id'],'success':True,'data':sys.argv[1:]}),flush=True)
`
  )
  chmodSync(command, 0o700)
  try {
    for (const trust of [undefined, 'saved', 'approve', 'ignore']) {
      if (trust === undefined) delete process.env.FARFOLD_PI_PROJECT_TRUST
      else process.env.FARFOLD_PI_PROJECT_TRUST = trust
      const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: command })
      try {
        const extra = trust === 'approve' ? ['--approve'] : trust === 'ignore' ? ['--no-approve'] : []
        const args = (await proc.getState()) as string[]
        assert.deepEqual(args.slice(0, -2), ['--mode', 'rpc', '--no-themes', ...extra])
        assert.equal(args.at(-2), '--extension')
        assert.match(args.at(-1)!, /farfold-pi-profile-[^/]+\/profile\.mjs$/)
      } finally {
        proc.dispose()
      }
    }
    process.env.FARFOLD_PI_PROJECT_TRUST = 'unsafe-other-value'
    await assert.rejects(PiRpcProcess.spawn({ cwd: root, piCommand: command }), /Invalid Pi project trust choice/)
  } finally {
    if (saved === undefined) delete process.env.FARFOLD_PI_PROJECT_TRUST
    else process.env.FARFOLD_PI_PROJECT_TRUST = saved
    rmSync(root, { recursive: true, force: true })
  }
})
