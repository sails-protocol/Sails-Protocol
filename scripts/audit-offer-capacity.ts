// M-1b audit (GK v4.2 item 3(b), Despacho 029): re-verifies EVERY persisted capacity declaration and FAILS LOUD.
// The database cannot check Ed25519, so a signature written by direct SQL could be invalid; this reads all of offer_capacity,
// rebuilds the canonical bytes ('sails-offer-capacity-v1') and verifies the signature with the row's own ownerPublicKey.
// Exit 0 = every configured row verifies (and every reservation is covered by its capacity); any failure => exit 1 with the rows.
//
// usage: DATABASE_URL=... SAILS_NETWORK_ID=testnet ts-node scripts/audit-offer-capacity.ts
import { Client } from 'pg'
import { verifyOfferCapacity, SignedOfferCapacityDeclaration } from '../src/modules/open-liquidity/offer-capacity-declaration'

export interface CapacityAuditFinding { ownerPublicKey: string; logicalOfferId: string; problem: string }

export async function auditOfferCapacity(client: Client, networkId: string): Promise<CapacityAuditFinding[]> {
  const findings: CapacityAuditFinding[] = []
  const rows = (await client.query(
    `SELECT "ownerPublicKey","logicalOfferId","capacityTotal"::text AS total,"capacityRevision","declaration","declarationSignature" FROM "offer_capacity"`)).rows
  for (const r of rows) {
    const id = { ownerPublicKey: r.ownerPublicKey as string, logicalOfferId: r.logicalOfferId as string }
    if (r.total === null) continue // unconfigured: nothing executable, nothing to verify
    const d = r.declaration as Partial<SignedOfferCapacityDeclaration> | null
    if (!d || typeof d !== 'object') { findings.push({ ...id, problem: 'configured capacity without a declaration' }); continue }
    const declared: SignedOfferCapacityDeclaration = { ...(d as SignedOfferCapacityDeclaration), signature: r.declarationSignature }
    const v = verifyOfferCapacity(declared, networkId)
    if (!v.valid) { findings.push({ ...id, problem: `declaration does not verify: ${v.reason}` }); continue }
    // the row must be exactly what was signed (a valid declaration pasted next to different columns is also a failure)
    if (declared.ownerPublicKey !== id.ownerPublicKey || declared.logicalOfferId !== id.logicalOfferId) findings.push({ ...id, problem: 'declaration names another identity' })
    if (Number(declared.capacityTotal) !== Number(r.total)) findings.push({ ...id, problem: `capacityTotal ${r.total} differs from the signed ${declared.capacityTotal}` })
    if (declared.capacityRevision !== r.capacityRevision) findings.push({ ...id, problem: `capacityRevision ${r.capacityRevision} differs from the signed ${declared.capacityRevision}` })
  }
  // an open reservation sum above the current total is only legal after a reduction (no retroactivity); report it, do not fail on it.
  return findings
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  const network = process.env.SAILS_NETWORK_ID
  if (!url || !network) { console.error('DATABASE_URL and SAILS_NETWORK_ID are required'); process.exit(2) }
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const findings = await auditOfferCapacity(client, network)
    if (findings.length === 0) { console.log('offer_capacity audit: every persisted declaration verifies'); return }
    for (const f of findings) console.error(`FAIL ${f.ownerPublicKey}/${f.logicalOfferId}: ${f.problem}`)
    process.exitCode = 1
  } finally { await client.end() }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2) })
