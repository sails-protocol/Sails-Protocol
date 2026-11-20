import type { Dispute, Escrow } from '@satsails/p2p-trading-sdk'
import { decisionOptions, multisigPendingSigner, parseEvidence, partyIdFor, partyRole, safeHttpHref, selectableOption, splitUnavailableHere, SPLIT_UNAVAILABLE_REASON } from '../src/lib/disputeCase'

const dispute = (patch: Partial<Dispute> = {}): Dispute => ({
  id: 'd1', tradeId: 't1', escrowId: 'e1', openedBy: 'u1', reason: 'r', evidence: [], arbiterId: 'a1', status: 'OPENED',
  ruling: null, resolvedAt: null, appealRound: 0, previousRuling: null, previousArbiterId: null,
  autoResolutionRecommendation: null, autoResolutionConfidence: null, autoResolutionReasoning: null, autoResolutionDeadline: null,
  autoResolved: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...patch,
})

describe('arbiter decision options', () => {
  it('offers SPLIT only where the escrow type supports it', () => {
    expect(decisionOptions(dispute(), 'MULTISIG').map((o) => o.value)).toEqual(['RELEASE', 'REFUND', 'SPLIT'])
    expect(decisionOptions(dispute(), 'LIGHTNING_HODL').map((o) => o.value)).toEqual(['RELEASE', 'REFUND'])
    expect(decisionOptions(dispute(), 'SAFE_GUARD_EVM').map((o) => o.value)).toEqual(['RELEASE', 'REFUND'])
    expect(decisionOptions(dispute(), null).map((o) => o.value)).toEqual(['RELEASE', 'REFUND'])
  })
  it('shows MULTISIG SPLIT disabled with a reason, never selectable', () => {
    const opts = decisionOptions(dispute(), 'MULTISIG')
    expect(opts.find((o) => o.value === 'SPLIT')?.unavailableReason).toBe(SPLIT_UNAVAILABLE_REASON)
    expect(selectableOption(opts, 'SPLIT')).toBeNull()
    expect(selectableOption(opts, 'RELEASE')?.ruling).toBe('RELEASE')
    for (const t of ['MOCK', 'WDK_USDT_EVM'] as const) {
      const o = decisionOptions(dispute(), t)
      expect(o.find((x) => x.value === 'SPLIT')?.unavailableReason).toBeUndefined()
      expect(selectableOption(o, 'SPLIT')?.ruling).toBe('SPLIT')
    }
  })
  it('blocks accepting a SPLIT suggestion on MULTISIG with the same reason', () => {
    const d = dispute({ status: 'AUTO_PROPOSED', autoResolutionRecommendation: 'SPLIT' })
    const multisig = decisionOptions(d, 'MULTISIG')
    expect(multisig.find((o) => o.value === 'SUGGESTION')).toMatchObject({ ruling: 'SPLIT', unavailableReason: SPLIT_UNAVAILABLE_REASON })
    expect(selectableOption(multisig, 'SUGGESTION')).toBeNull()
    expect(splitUnavailableHere('SPLIT', 'MULTISIG')).toBe(true)
    expect(selectableOption(decisionOptions(d, 'MOCK'), 'SUGGESTION')?.ruling).toBe('SPLIT')
    const refund = decisionOptions(dispute({ status: 'AUTO_PROPOSED', autoResolutionRecommendation: 'REFUND' }), 'MULTISIG')
    expect(selectableOption(refund, 'SUGGESTION')?.ruling).toBe('REFUND')
  })
  it('names the party that still signs a MULTISIG ruling', () => {
    expect(multisigPendingSigner('RELEASE')).toBe('o comprador')
    expect(multisigPendingSigner('REFUND')).toBe('o vendedor')
    expect(multisigPendingSigner('SPLIT')).toBeNull()
  })
  it('adds the automatic suggestion only while it is pending', () => {
    const auto = decisionOptions(dispute({ status: 'AUTO_PROPOSED', autoResolutionRecommendation: 'REFUND' }), 'MOCK')
    expect(auto[auto.length - 1]).toEqual({ value: 'SUGGESTION', ruling: 'REFUND', label: 'Aceitar a sugestão automática', detail: 'Devolver ao vendedor' })
    expect(decisionOptions(dispute({ status: 'EVIDENCE_SUBMITTED', autoResolutionRecommendation: 'REFUND' }), 'MOCK').some((o) => o.value === 'SUGGESTION')).toBe(false)
  })
  it('offers nothing once resolved', () => {
    expect(decisionOptions(dispute({ status: 'RESOLVED', ruling: 'RELEASE' }), 'MOCK')).toEqual([])
  })
})

describe('party role', () => {
  const escrow = { participantKeys: [{ participantId: 'b', role: 'buyer', publicKeyHex: '' }, { participantId: 'x', role: 'arbiter', publicKeyHex: '' }] } as unknown as Escrow
  it('comes only from the escrow participant keys', () => {
    expect(partyRole('b', escrow)).toBe('buyer')
    expect(partyRole('x', escrow)).toBeNull()
    expect(partyRole('b', null)).toBeNull()
    expect(partyIdFor('buyer', escrow)).toBe('b')
    expect(partyIdFor('seller', escrow)).toBeNull()
  })
})

describe('evidence', () => {
  it('links only http(s) and keeps the uri as given', () => {
    expect(safeHttpHref('https://example.org/a?b=1')).toBe('https://example.org/a?b=1')
    expect(safeHttpHref('javascript:alert(1)')).toBeNull()
    expect(safeHttpHref('ipfs://cid')).toBeNull()
    expect(safeHttpHref('not a url')).toBeNull()
  })
  it('reads descriptors defensively', () => {
    const items = parseEvidence([
      { type: 'text', note: 'n', submittedBy: 'u', submittedAt: '2026-11-01T00:00:00Z' },
      { type: 'screenshot', uri: 'javascript:x', externalReference: true },
      null,
      'junk',
      { evidenceReferenceId: 'ref1' },
    ])
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ type: 'text', note: 'n', submittedBy: 'u', href: null, uri: null })
    expect(items[1]).toMatchObject({ uri: 'javascript:x', href: null })
    expect(items[2]).toMatchObject({ type: 'desconhecido', referenceId: 'ref1' })
    expect(parseEvidence(undefined)).toEqual([])
  })
})
