// Structural guarantees for MULTISIG disputed settlement: the arbiter key signs in exactly one place, and no round
// builder signs anything (comments stripped before matching).
import * as fs from 'fs'
import * as path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const provider = read('src/modules/open-settlement/multisig.provider.ts')
const body = (name: string) => {
  const i = provider.search(new RegExp(`\\n  (?:async )?${name}\\(`))
  if (i < 0) throw new Error(`method ${name} not found`)
  const next = provider.slice(i + 1).search(/\n  (?:async |private |export )?[a-zA-Z]+\(/)
  return provider.slice(i, next < 0 ? undefined : i + 1 + next)
}

describe('arbiter signing happens only at execution (structure)', () => {
  it('signInput() with the arbiter key appears only in signAsArbiterAtExecution()', () => {
    const calls = provider.match(/\.signInput\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(body('signAsArbiterAtExecution')).toMatch(/\.signInput\(0, arbiterKey/)
  })

  it.each(['buildUnsignedRelease', 'buildUnsignedRefund', 'buildUnsignedSplit'])('%s() never derives the arbiter key and never signs', (name) => {
    const b = body(name)
    expect(b).not.toMatch(/deriveArbiterKey\(/)
    expect(b).not.toMatch(/\.signInput\(/)
  })

  it('deriveArbiterKey() is called only to commit the pubkey at creation, to expose it, and to sign at execution', () => {
    const callers = ['getDepositAddress', 'getArbiterPubkeyHex', 'signAsArbiterAtExecution']
    const total = (provider.match(/this\.deriveArbiterKey\(/g) ?? []).length
    const inAllowed = callers.reduce((n, c) => n + (body(c).match(/this\.deriveArbiterKey\(/g) ?? []).length, 0)
    expect(total).toBe(inAllowed)
  })

  it('every HTTP response carrying a round strips partial signatures', () => {
    const routes = read('src/modules/open-settlement/settlement.routes.ts')
    expect(routes).not.toMatch(/reply\.code\(201\)\.send\(success\(pending\)\)/)
    expect((routes.match(/withoutPartialSignatures\(pending\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(routes).toMatch(/const \{ signatures, \.\.\.round \} = withoutPartialSignatures\(pending\)/)
  })
})
