/**
 * scripts/scan-high-s-signatures.ts - D1 (GK-594, Issue #299): read-only, pre-deploy sweep of every MULTISIG
 * partial signature already stored, for the high-S signatures the live check (multisig-round-proofs.ts) now refuses
 * but that were persisted before it existed. Covers both places a partial signature is kept: each signer's
 * submitted PSBT and the round's own PSBT (an arbiter's pre-signature). Same trust boundary as the other operator
 * scripts: shell + DATABASE_URL access to the target environment. It never writes.
 *
 * Prints one JSON report. Exits 1 when anything was found or could not be read (fail-closed: an unreadable PSBT is
 * a finding, not a pass), 0 only when every stored signature is low-S.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/scan-high-s-signatures.ts
 */
import { prisma } from '../src/common/database'
import { findHighSPartialSignatures } from '../src/modules/open-settlement/multisig-round-proofs'

const PAGE = 500

type Finding = { source: 'signature' | 'round'; id: string; escrowId: string; input?: number; pubkey?: string; reason: string }

function inspect(source: Finding['source'], id: string, escrowId: string, psbt: string, findings: Finding[]): void {
  try {
    for (const f of findHighSPartialSignatures(psbt)) findings.push({ source, id, escrowId, ...f })
  } catch (err) {
    findings.push({ source, id, escrowId, reason: `UNREADABLE: ${err instanceof Error ? err.message : String(err)}` })
  }
}

export async function scanHighSSignatures(): Promise<{ scanned: { signatures: number; rounds: number }; findings: Finding[] }> {
  const findings: Finding[] = []
  const scanned = { signatures: 0, rounds: 0 }
  const multisig = { escrow: { type: 'MULTISIG' as const } }

  for (let cursor: string | undefined; ;) {
    const page = await prisma.escrowTransactionSignature.findMany({
      where: { pendingTx: multisig }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, signedPsbtBase64: true, pendingTx: { select: { escrowId: true } } },
    })
    for (const s of page) inspect('signature', s.id, s.pendingTx.escrowId, s.signedPsbtBase64, findings)
    scanned.signatures += page.length
    if (page.length < PAGE) break
    cursor = page[page.length - 1].id
  }

  for (let cursor: string | undefined; ;) {
    const page = await prisma.escrowPendingTransaction.findMany({
      where: multisig, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, escrowId: true, unsignedPsbtBase64: true },
    })
    for (const r of page) inspect('round', r.id, r.escrowId, r.unsignedPsbtBase64, findings)
    scanned.rounds += page.length
    if (page.length < PAGE) break
    cursor = page[page.length - 1].id
  }

  return { scanned, findings }
}

if (require.main === module) {
  scanHighSSignatures()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.findings.length > 0 ? 1 : 0
    })
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
