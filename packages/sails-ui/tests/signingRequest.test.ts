import { deriveSigningRequest, describeMismatches, roundSnapshotChanged, type PendingForView, type SigningVerification } from '../src/lib/signingRequest'

const base: PendingForView = {
  kind: 'release',
  toAddress: 'tb1qbuyer',
  requiredSigners: ['seller', 'buyer'],
  signedBy: [],
}
const verified: SigningVerification = { status: 'verified', outputs: [{ address: 'tb1qbuyer', sats: 99000n }], minerFeeSats: 1000n }
const label = (id: string) => id
const derive = (pending: Partial<PendingForView>, viewerId: string | null, verification: SigningVerification = verified) =>
  deriveSigningRequest({ pending: { ...base, ...pending }, viewerId, verification, signerLabel: label })

const NON_VERIFIED: SigningVerification[] = [
  { status: 'unsupported' },
  { status: 'mismatch', fields: ['outputs[0].address'] },
  { status: 'cannotVerify', reason: 'x' },
]

describe('signing request derivation (CTO 437 step 4)', () => {
  it('offers a sign action only to a pending required signer with a verified transaction', () => {
    const v = derive({}, 'seller')
    expect(v.state).toBe('sign')
    expect(v.primary).toBeDefined()
    expect(v.check?.tone).toBe('ok')
  })

  it('never offers a sign action for unsupported, mismatched or unverifiable transactions', () => {
    for (const verification of NON_VERIFIED) {
      const v = derive({}, 'seller', verification)
      expect(v.state).toBe('blocked')
      expect(v.primary).toBeUndefined()
    }
  })

  it('waits when the viewer already signed or is not a required signer', () => {
    for (const v of [derive({ signedBy: [{ participantId: 'seller', submittedAt: '' }] }, 'seller'), derive({}, 'outsider'), derive({}, null)]) {
      expect(v.state).toBe('waiting')
      expect(v.primary).toBeUndefined()
    }
    expect(derive({ signedBy: [{ participantId: 'seller', submittedAt: '' }] }, 'seller').description).toBe('Aguardando assinatura de 1 participante(s).')
  })

  it('counts progress from requiredSigners and signedBy only, keeping each signer recorded time', () => {
    const v = derive({ signedBy: [{ participantId: 'buyer', submittedAt: '2026-11-20T04:12:00.000Z' }, { participantId: 'stranger', submittedAt: '' }] }, 'seller')
    expect(v.progress).toEqual({ signed: 1, required: 2, text: '1 de 2 assinaturas' })
    expect(v.signers).toEqual([
      { label: 'seller', signed: false, statusText: 'Pendente', at: null },
      { label: 'buyer', signed: true, statusText: 'Assinou', at: '2026-11-20T04:12:00.000Z' },
    ])
  })

  it('reports completion without claiming broadcast or confirmation', () => {
    const v = derive({ signedBy: [{ participantId: 'seller', submittedAt: '' }, { participantId: 'buyer', submittedAt: '' }] }, 'seller')
    expect(v.state).toBe('complete')
    expect(v.primary).toBeUndefined()
    expect(v.description).toMatch(/não confirma a transmissão/)
  })

  it('shows both payout addresses for a split and the seller address for a refund', () => {
    expect(derive({ kind: 'split', toAddressSecondary: 'tb1qseller' }, 'seller').destinations.map((d) => d.address)).toEqual(['tb1qbuyer', 'tb1qseller'])
    expect(derive({ kind: 'refund', toAddress: 'tb1qseller' }, 'seller').destinations).toEqual([{ label: 'Endereço do vendedor', address: 'tb1qseller' }])
  })

  it('never offers signing while the escrow is disputed', () => {
    const v = derive({}, 'seller')
    const d = deriveSigningRequest({ pending: base, viewerId: 'seller', verification: verified, signerLabel: label, disputed: true })
    expect(v.primary).toBeDefined()
    expect(d.state).toBe('blocked')
    expect(d.primary).toBeUndefined()
    expect(d.cancel).toBeUndefined()
  })

  it('offers cancel only on a blocked round and only when allowed; otherwise says there is no way forward here', () => {
    const allowed = (verification: SigningVerification) => deriveSigningRequest({ pending: base, viewerId: 'seller', verification, signerLabel: label, canCancel: true })
    for (const verification of NON_VERIFIED) {
      expect(allowed(verification).cancel).toBeDefined()
      expect(derive({}, 'seller', verification).cancel).toBeUndefined()
      expect(derive({}, 'seller', verification).description).toBe('Você não pode prosseguir por esta interface.')
    }
    expect(allowed(verified).cancel).toBeUndefined()
  })

  it('names the buyer when the buyer is the only remaining signer', () => {
    const v = deriveSigningRequest({ pending: { ...base, signedBy: [{ participantId: 'seller', submittedAt: '' }] }, viewerId: 'seller', verification: verified, signerLabel: (id) => (id === 'buyer' ? 'Comprador' : 'Você') })
    expect(v.description).toBe('Aguardando a assinatura do comprador.')
  })

  it('describes the check as against the server-provided transaction, never as the trade terms or a signer check', () => {
    const v = derive({}, 'seller')
    expect(v.check?.title).toBe('Conferido com a transação informada pelo servidor para este escrow')
    const text = JSON.stringify(v.check)
    expect(text).not.toMatch(/termos do trade|assinantes/i)
    expect(describeMismatches(['requiredSigners'])).toEqual(['Um campo da transação não confere com o esperado.'])
  })

  it('labels the protocol fee output when its address is known', () => {
    const v = deriveSigningRequest({
      pending: base, viewerId: 'seller', signerLabel: label, protocolFeeAddress: 'tb1qfee',
      verification: { status: 'verified', outputs: [{ address: 'tb1qbuyer', sats: 99000n }, { address: 'tb1qfee', sats: 500n }], minerFeeSats: 500n },
    })
    expect(v.check?.items.map((i) => i.label)).toEqual(['Endereço do comprador', 'Taxa do protocolo', 'Taxa de rede'])
  })

  it('treats a round that differs from the reviewed snapshot as changed, so it is never signed', () => {
    const snap = { id: 'r1', unsignedPsbtBase64: 'AAA' }
    expect(roundSnapshotChanged(snap, { id: 'r1', unsignedPsbtBase64: 'AAA' })).toBe(false)
    expect(roundSnapshotChanged(snap, { id: 'r2', unsignedPsbtBase64: 'AAA' })).toBe(true)
    expect(roundSnapshotChanged(snap, { id: 'r1', unsignedPsbtBase64: 'BBB' })).toBe(true)
    expect(roundSnapshotChanged(snap, null)).toBe(true)
  })

  it('blocks a round whose payout address equals the protocol fee address, even if verified', () => {
    for (const pending of [{ toAddress: 'tb1qfee' }, { kind: 'split' as const, toAddressSecondary: 'tb1qfee' }]) {
      const v = deriveSigningRequest({ pending: { ...base, ...pending }, viewerId: 'seller', verification: verified, signerLabel: label, protocolFeeAddress: 'tb1qfee' })
      expect(v.state).toBe('blocked')
      expect(v.primary).toBeUndefined()
      expect(v.check?.tone).toBe('unavailable')
    }
  })

  it('keeps money-flow labels unique', () => {
    const v = deriveSigningRequest({
      pending: base, viewerId: 'seller', signerLabel: label, protocolFeeAddress: 'tb1qfee',
      verification: { status: 'verified', outputs: [{ address: 'tb1qbuyer', sats: 1n }, { address: 'tb1qbuyer', sats: 2n }], minerFeeSats: 1n },
    })
    const labels = v.check!.items.map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('describes SDK mismatch fields in plain language, deduplicated', () => {
    expect(describeMismatches(['outputs[0].value', 'outputs[1].value', 'minerFee'])).toEqual([
      'O valor enviado é diferente do esperado.',
      'A taxa de rede é diferente da registrada.',
    ])
  })
})
