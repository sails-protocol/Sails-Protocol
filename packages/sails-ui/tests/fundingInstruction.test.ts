import { deriveFundingInstruction, deriveFundingRecordRows, lockRefusalMessage, bitcoinNetworkFromAddress, type FundingEscrow } from '../src/lib/fundingInstruction'
import type { EscrowStatus, EscrowType } from '../src/types'

const base: FundingEscrow = {
  type: 'MULTISIG', status: 'CREATED', asset: 'BTC', lockedAmount: '0.01', multisigAddr: 'tb1qexample',
  txLockId: null, txLockVout: null, fundedAmount: null,
  feePolicyVersionId: null, snapshotProtocolFeeRate: null, snapshotFeeCollectionWaivedPreFunding: null,
}
const policy = { feePolicyVersionId: 'p1', snapshotProtocolFeeRate: '0.005' }
const seller = (e: Partial<FundingEscrow> = {}) => deriveFundingInstruction({ escrow: { ...base, ...e }, isBuyer: false, isSeller: true, assetLabel: 'BTC' })
const STATUSES: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
const TYPES: EscrowType[] = ['MULTISIG', 'LIGHTNING_HODL', 'LIQUID_COVENANT', 'WDK_USDT_EVM', 'SAFE_GUARD_EVM', 'MOCK']
const FORBIDDEN = /confirmad|detectad|verificad|recebid|monitor/i

function allText(v: ReturnType<typeof seller>): string {
  return v ? [v.title, v.note, ...v.requirements, ...v.facts.flatMap((f) => [f.label, f.value])].join(' ') : ''
}

describe('funding instruction derivation (CTO 437 step 3)', () => {
  it('exists only for a MULTISIG escrow in CREATED, for a party', () => {
    for (const type of TYPES) {
      for (const status of STATUSES) {
        const v = seller({ type, status })
        expect(v !== null).toBe(type === 'MULTISIG' && status === 'CREATED')
      }
    }
    expect(deriveFundingInstruction({ escrow: base, isBuyer: false, isSeller: false, assetLabel: 'BTC' })).toBeNull()
  })

  it('gives deposit instructions only to the seller; the buyer gets the address read-only', () => {
    expect(seller()?.viewer).toBe('seller')
    const b = deriveFundingInstruction({ escrow: base, isBuyer: true, isSeller: false, assetLabel: 'BTC' })
    expect(b?.viewer).toBe('buyer')
    expect(b?.requirements).toEqual([])
    expect(allText(b)).not.toMatch(/Deposite/)
  })

  it('states the provider amount rule: at least for legacy, exact for fee-policy escrows', () => {
    expect(seller()?.title).toBe('Deposite pelo menos 0.01 BTC neste endereço')
    expect(seller({ ...policy, snapshotFeeCollectionWaivedPreFunding: true })?.title).toBe('Deposite exatamente 0.01 BTC neste endereço')
    // T + Fmax is not in the contract: never show lockedAmount as the exact total.
    const unknown = seller(policy)
    expect(unknown?.facts.find((f) => f.label === 'Valor exato')?.value).toBe('Não disponível nesta tela')
    expect(unknown?.title).not.toMatch(/0\.01/)
  })

  it('never claims a deposit was seen or confirmed, in any variant', () => {
    const variants = [seller(), seller(policy), seller({ ...policy, snapshotFeeCollectionWaivedPreFunding: true }), seller({ multisigAddr: null }),
      deriveFundingInstruction({ escrow: base, isBuyer: true, isSeller: false, assetLabel: 'BTC' })]
    for (const v of variants) expect(allText(v)).not.toMatch(FORBIDDEN)
  })

  it('without an address, says so and gives no amount instruction', () => {
    const v = seller({ multisigAddr: null })
    expect(v?.facts.find((f) => f.label === 'Endereço do escrow')?.value).toBe('Ainda não disponível')
    expect(v?.facts.some((f) => f.copy)).toBe(false)
    expect(v?.title).not.toMatch(/Deposite/)
  })

  it('reads the network only from the address prefix', () => {
    expect(bitcoinNetworkFromAddress('bc1qx')).toBe('Bitcoin mainnet')
    expect(bitcoinNetworkFromAddress('TB1QX')).toBe('Bitcoin testnet ou signet')
    expect(bitcoinNetworkFromAddress('bcrt1qx')).toBe('Bitcoin regtest')
    expect(bitcoinNetworkFromAddress('3Abc')).toBeNull()
  })
})

describe('recorded funding rows', () => {
  it('only from present fields, only for MULTISIG', () => {
    expect(deriveFundingRecordRows({ ...base, status: 'FUNDS_LOCKED' })).toEqual([])
    expect(deriveFundingRecordRows({ ...base, type: 'MOCK', status: 'FUNDS_LOCKED', txLockId: 'mock-tx' })).toEqual([])
    expect(deriveFundingRecordRows({ ...base, status: 'FUNDS_LOCKED', txLockId: 'abc' }).map((r) => r.label)).toEqual(['Depósito registrado pelo servidor'])
    const full = deriveFundingRecordRows({ ...base, status: 'FUNDS_LOCKED', txLockId: 'abc', txLockVout: 0, fundedAmount: '1005000' })
    // fundedAmount is never rendered until its unit is canonical in the backend
    expect(full.map((r) => r.value)).toEqual(['abc', '0'])
    for (const r of full) expect(`${r.label} ${r.value}`).not.toMatch(FORBIDDEN)
  })
})

describe('lock refusal message', () => {
  const escrowError = (message: string) => ({ code: 'ESCROW_ERROR', message })
  it('maps the two MULTISIG funding refusals and nothing else', () => {
    expect(lockRefusalMessage(escrowError('No funding UTXO of at least 1000000 sats found at tb1q yet.'))).toMatch(/ainda não encontrou o depósito/)
    expect(lockRefusalMessage(escrowError('No funding UTXO of EXACTLY 1005000 sats (trade amount + maximum Protocol Fee reserve) found at tb1q.'))).toMatch(/ainda não encontrou o depósito/)
    expect(lockRefusalMessage(escrowError('Funding UTXO t:0 at tb1q has 0 of the required 3 confirmation(s). Refusing to lock funds on insufficient confirmation depth'))).toMatch(/confirmações exigidas/)
    expect(lockRefusalMessage(escrowError('Escrow is not in CREATED status'))).toBeNull()
    expect(lockRefusalMessage({ code: 'FORBIDDEN', message: 'No funding UTXO' })).toBeNull()
    expect(lockRefusalMessage(new Error('No funding UTXO'))).toBeNull()
    expect(lockRefusalMessage(undefined)).toBeNull()
  })
})
