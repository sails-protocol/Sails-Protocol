import { readFileSync } from 'fs'
import { join } from 'path'
import { assertMultisigSigningAllowed, checkMultisigPending, MultisigSigningIntentError, MULTISIG_SIGNING_HOLD, multisigSigningHoldMessage } from '../src/lib/multisigSigningIntent'

const SRC = join(__dirname, '..', 'src')
const codeOnly = (p: string) => readFileSync(join(SRC, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
/** Code from the function's declaration onward; the gate must appear before the guarded calls in it. */
const bodyOf = (code: string, marker: string) => {
  const start = code.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  return code.slice(start)
}

describe('MULTISIG signing HOLD (CTO 28 Despacho 033): one gate on every signing entry point', () => {
  it('the HOLD is on and the gate refuses with the hold message', () => {
    expect(MULTISIG_SIGNING_HOLD).toBe(true)
    expect(() => assertMultisigSigningAllowed({ id: 'e1' })).toThrow(MultisigSigningIntentError)
    let message = ''
    try { assertMultisigSigningAllowed({ id: 'e1' }) } catch (e) { message = (e as MultisigSigningIntentError).userMessage }
    expect(message).toBe(multisigSigningHoldMessage())
  })

  it('entry point 1, checkMultisigPending: refuses to verify any release while fundedAmount is unresolved, even with complete data', () => {
    const escrow = { id: 'e1', type: 'MULTISIG', multisigAddr: 'bc1qexample', txLockId: 'a'.repeat(64), txLockVout: 0, fundedAmount: '0.01' }
    const pending = { kind: 'release', minerFeeSats: '500', unsignedPsbtBase64: 'x', requiredSigners: [] }
    expect(checkMultisigPending(escrow as never, pending as never)).toEqual({ status: 'cannotVerify', reason: multisigSigningHoldMessage() })
  })

  it('entry point 1, structurally: the gate runs before the intent is built', () => {
    const body = bodyOf(codeOnly('lib/multisigSigningIntent.ts'), 'export function checkMultisigPending')
    const gate = body.indexOf('assertMultisigSigningAllowed(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('buildMultisigSigningIntent('))
  })

  it('entry point 2, useEscrowKey.signVerifiedMultisigPending: the gate runs before the escrow key is decrypted and before signing', () => {
    const body = bodyOf(codeOnly('hooks/useEscrowKey.ts'), 'const signVerifiedMultisigPending')
    const gate = body.indexOf('assertMultisigSigningAllowed(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('loadOrCreateEscrowKeypair('))
    expect(gate).toBeLessThan(body.indexOf('verifyAndSignEscrowPsbt('))
  })

  it('no parameter or environment variable bypasses the HOLD', () => {
    const code = codeOnly('lib/multisigSigningIntent.ts')
    expect(code).toMatch(/export const MULTISIG_SIGNING_HOLD = true\b/)
    expect(code).not.toMatch(/process\.env|import\.meta\.env/)
    expect(code).toMatch(/export function assertMultisigSigningAllowed\(escrow: Pick<Escrow, 'id'>\): void/)
  })
})
