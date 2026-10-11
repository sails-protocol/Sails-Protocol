/**
 * AUD1X-H1 - structural guarantees of the bearer-capability correction (no database, no network).
 *
 * The behaviour is proved on real PostgreSQL (tests/integration/aud1xBearerCapability.test.ts) and on real PSBTs
 * (tests/multisigProvider.test.ts). What a behavioural test cannot say is "no OTHER code path produces the
 * signature": that is a property of the source, and it is the one a later refactor is most likely to break by
 * adding a convenient `signInput` or by threading the execution identity into a builder. These tests read the
 * source and fail if the shape of the boundary changes.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.join(__dirname, '..', 'src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
const PROVIDER = read('modules/open-settlement/multisig.provider.ts')

/** The name of the class method (2-space-indented declaration) that encloses the character at `index`. */
function enclosingMethod(source: string, index: number): string | undefined {
  const before = source.slice(0, index)
  const declarations = [...before.matchAll(/\n  (?:private |public |protected )?(?:async )?([A-Za-z0-9_]+)\(/g)]
  return declarations.length ? declarations[declarations.length - 1][1] : undefined
}
const occurrences = (source: string, needle: string | RegExp): number[] => {
  const out: number[] = []
  const re = typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(needle.source, 'g')
  for (const m of source.matchAll(re)) out.push(m.index!)
  return out
}

describe('AUD1X-H1 - where the platform arbiter signature can come from', () => {
  it('the provider signs a PSBT in exactly one place: addArbiterSignatureAtExecution()', () => {
    const calls = occurrences(PROVIDER, '.signInput(')
    expect(calls).toHaveLength(1)
    expect(enclosingMethod(PROVIDER, calls[0])).toBe('addArbiterSignatureAtExecution')
  })

  it('the arbiter private key is derived only for its public key (getArbiterPubkeyHex, getDepositAddress) and by the execution-time signer - never by a builder', () => {
    const callers = occurrences(PROVIDER, 'this.deriveArbiterKey(').map((i) => enclosingMethod(PROVIDER, i))
    expect(new Set(callers)).toEqual(new Set(['getArbiterPubkeyHex', 'getDepositAddress', 'addArbiterSignatureAtExecution']))
    for (const builder of ['buildUnsignedRelease', 'buildUnsignedRefund', 'buildUnsignedSplit', 'buildUnsignedSpend']) {
      expect(callers).not.toContain(builder)
    }
  })

  it('addArbiterSignatureAtExecution() is reached from buildFinalizedTransaction() alone', () => {
    const calls = occurrences(PROVIDER, 'this.addArbiterSignatureAtExecution(').map((i) => enclosingMethod(PROVIDER, i))
    expect(calls).toEqual(['buildFinalizedTransaction'])
  })

  it('buildFinalizedTransaction() signs BEFORE combining any client copy (the arbiter signs the stored round only)', () => {
    const start = PROVIDER.indexOf('private buildFinalizedTransaction(')
    const body = PROVIDER.slice(start, PROVIDER.indexOf('\n  }\n', start))
    const sign = body.indexOf('this.addArbiterSignatureAtExecution(')
    const combine = body.indexOf('merged.combine(')
    expect(sign).toBeGreaterThan(-1)
    expect(combine).toBeGreaterThan(sign)
  })

  it('the execution identity is only ever supplied by a caller that has just passed (or re-read) the gate: never by construction', () => {
    const holders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('arbiterExecutionIdentity')) {
          holders.push(path.relative(SRC, full).replace(/\\/g, '/'))
        }
      }
    }
    walk(SRC)
    expect(holders.sort()).toEqual([
      'modules/open-settlement/escrow-pending-tx.ts',
      'modules/open-settlement/escrow-settlement-reconciliation.service.ts',
      'modules/open-settlement/multisig.provider.ts',
    ])

    // in escrow-pending-tx.ts it appears only in the signature path, after the gate's return value exists
    const pendingTx = read('modules/open-settlement/escrow-pending-tx.ts')
    const construction = pendingTx.slice(pendingTx.indexOf('async function initiateSignatureCollectionCore('), pendingTx.indexOf('export async function initiateRelease('))
    expect(construction).not.toContain('arbiterExecutionIdentity')
    const submit = pendingTx.slice(pendingTx.indexOf('export async function submitTransactionSignature('))
    expect(submit.indexOf('arbiterExecutionIdentity')).toBeGreaterThan(submit.indexOf('const economicAuthorization = await authorizeDisputedPendingExecution(pending)'))
  })

  it('in the reconciliation service the identity comes from exactly two places: the C8 gate hook and PASS 1\'s committed authorization - never the output-only catch-up', () => {
    const recon = read('modules/open-settlement/escrow-settlement-reconciliation.service.ts')
    const uses = occurrences(recon, 'arbiterExecutionIdentity').map((i) => recon.slice(Math.max(0, i - 60), i + 90).replace(/\s+/g, ' '))
    // the C8 hook's return, PASS 1's input, and the comments that say the catch-up has none
    expect(occurrences(recon, 'committedExecutionIdentity(')).toHaveLength(2) // the definition and PASS 1's single use
    expect(occurrences(recon, 'return economicAuthorization ? { arbiterExecutionIdentity: economicAuthorization.arbiterId }')).toHaveLength(1)
    const catchUp = recon.slice(recon.indexOf('pendingForCorrespondence = await prisma.escrowPendingTransaction.findUnique'), recon.indexOf('await recordLiveCorrespondenceIfApplicable(escrow.id, escrow.tradeId, escrow.type, rawTxHex)'))
    expect(catchUp).not.toMatch(/arbiterExecutionIdentity:\s*await/)
    void uses
  })

  it('the three builders never set it and never read the arbiter private key', () => {
    for (const name of ['buildUnsignedRelease', 'buildUnsignedRefund', 'buildUnsignedSplit']) {
      const start = PROVIDER.indexOf(`async ${name}(`)
      expect(start).toBeGreaterThan(-1)
      const body = PROVIDER.slice(start, PROVIDER.indexOf('\n  }\n', start))
      expect(body).not.toContain('arbiterExecutionIdentity')
      expect(body).not.toContain('signInput')
      expect(body).not.toContain('deriveArbiterKey')
    }
  })

  it('construction and the dispute lock: the disputed MULTISIG write passes the dispute lock id, and the helper takes it before the escrow lock', () => {
    const pendingTx = read('modules/open-settlement/escrow-pending-tx.ts')
    expect(pendingTx).toMatch(/disputedMultisig \? \{ disputeLockId: disputedDispute!\.id \} : undefined/)
    const lifecycle = read('modules/open-settlement/escrow-lifecycle.ts')
    const helper = lifecycle.slice(lifecycle.indexOf('export async function withEscrowFundingLock'), lifecycle.indexOf('export async function loadEscrowWithAuthorization'))
    expect(helper.indexOf('economicDispositionLockKey(opts.disputeLockId)')).toBeGreaterThan(-1)
    expect(helper.indexOf('economicDispositionLockKey(opts.disputeLockId)')).toBeLessThan(helper.indexOf('hashtext(${escrowId})'))
  })
})
