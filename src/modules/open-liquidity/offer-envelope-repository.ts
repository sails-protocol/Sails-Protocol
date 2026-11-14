/**
 * Sails OpenLiquidity — OfferEnvelope local persistence
 *
 * ADR-001 §3/§21(a) (docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md). Local,
 * non-authoritative storage of independently-verified OfferEnvelopes —
 * this table is a cache of facts this node has itself re-derived from
 * raw envelope bytes, never a source of trust on its own ("não
 * transformar o banco local em protocol truth"). `ingest()` always
 * re-verifies the signature before writing anything; nothing here ever
 * stores a "trusted: true" flag in place of the real signature.
 *
 * No propagation, bootstrap, or cross-node transport is implemented or
 * called here — this module only accepts an envelope already in hand
 * (however it arrived) and decides, locally, whether to keep it.
 */
import { prisma } from '../../common/database'
import {
  verifyOfferEnvelope,
  hashOfferEnvelope,
  formatCanonicalDecimal,
  formatCanonicalTimestamp,
  isOfferEnvelopeEconomicallyActive,
  type SignedOfferEnvelope,
  type OfferEnvelopeContent,
} from './offer-envelope'

/**
 * CTO Gate correction (2026-09-09, Seventh Pass, Property S):
 * `equivocationDetected` is **advisory / best-effort only** — it is
 * NOT reliable equivocation detection and must never be treated as
 * authoritative. Reproduced directly against real Postgres:
 * `Promise.all([ingest(E1 rev5), ingest(E2 rev5)])` — E1/E2 distinct
 * content, same owner, same identity, same revision — can result in
 * BOTH callers receiving `equivocationDetected: undefined` (confirmed,
 * reproducibly: `findMany()`'s pre-insert read in each concurrent call
 * can both observe "no siblings yet," since neither write has landed at
 * read time — a genuine TOCTOU window, not a hypothesis). The database
 * itself is NEVER wrong in this race: both distinct facts are still
 * durably stored (Property M's own uniqueness constraint keys on
 * `contentDigest`, so two genuinely different facts never collide), and
 * a subsequent `getLatest()` call correctly reports `EQUIVOCATED`
 * naming both, confirmed in the identical reproduction. **Authority for
 * "did this identity equivocate" is `getLatest()` (or the stored fact
 * set directly), never this return value.** `equivocationDetected` is
 * kept only as a same-call convenience hint for the common, non-racing
 * case — deliberately NOT hardened into a reliable signal (no
 * transaction-level serialization, no global lock, no retry loop), per
 * explicit instruction not to add complexity purely to preserve a
 * convenience flag's accuracy.
 */
export type IngestResult =
  | { accepted: true; id: string; equivocationDetected?: true }
  | { accepted: false; reason: string }

/** Shape common to a Prisma `OfferEnvelope` row and this file's own in-memory test doubles. */
export interface OfferEnvelopeRow {
  id: string
  logicalOfferId: string
  ownerPublicKey: string
  asset: OfferEnvelopeContent['asset']
  side: OfferEnvelopeContent['side']
  priceUsd: Parameters<typeof formatCanonicalDecimal>[0]
  minAmount: Parameters<typeof formatCanonicalDecimal>[0]
  maxAmount: Parameters<typeof formatCanonicalDecimal>[0]
  paymentMethod: OfferEnvelopeContent['paymentMethod']
  revision: number
  createdAt: Date
  revisedAt: Date
  expiresAt: Date
  status: OfferEnvelopeContent['status']
  signature: string
  contentDigest: string
}

/**
 * The result of asking "what is this offer identity's CURRENT
 * economic state?" (CTO Gate correction 2026-09-09, Property J.)
 * Deliberately NOT just "a row or null" — a single, unconditionally-
 * winning "latest" row cannot express owner equivocation without either
 * (a) silently picking an arbitrary winner (the exact defect this
 * correction closes) or (b) hiding that a conflict exists. `RESOLVED` is
 * the normal case; `EQUIVOCATED` means the owner produced two-or-more
 * genuinely different signed envelopes at the identical, currently-
 * highest revision for this identity — every conflicting row is
 * returned, and NONE of them should be treated as economically
 * authoritative until a later, unambiguous revision arrives (see
 * `getLatest()` below).
 *
 * **Scope, precise (CTO Gate correction 2026-09-09, Sixth Pass):** this
 * answers the CURRENT-STATE question only — "what is economically
 * active right now." It is NOT the historical signed-fact set (that is
 * simply every row this table holds for the identity, queried directly
 * — see Property P) and it is NOT a complete equivocation-history
 * report (a past, superseded revision can also have been equivocated;
 * `getLatest()` only surfaces equivocation at the CURRENT highest
 * revision, since only that revision affects current economic state).
 * These three questions are answered separately on purpose, per the
 * Sixth Pass mission's own instruction not to force them into one
 * verdict.
 */
export type LatestOfferState =
  | { status: 'NOT_FOUND' }
  | { status: 'RESOLVED'; row: OfferEnvelopeRow }
  | { status: 'EQUIVOCATED'; revision: number; rows: OfferEnvelopeRow[] }

/**
 * C9 - a stored row at an identity's highest revision no longer verifies: its signature fails, or its stored
 * `contentDigest` is not the digest of its own content. Only a writer outside `ingest()` can produce this (the
 * table is append-only by trigger, migration 20261111120000), so the current state is unknown, not "inactive by
 * the owner's choice": `getLatest()` throws instead of returning a state, and no economic read gets past it.
 */
export class OfferEnvelopeIntegrityError extends Error {
  constructor(readonly ownerPublicKey: string, readonly logicalOfferId: string, readonly revision: number, readonly rowIds: string[]) {
    super(`OfferEnvelope integrity failure for (${ownerPublicKey}, ${logicalOfferId}) at revision ${revision}: stored row(s) ${rowIds.join(', ')} do not verify`)
    this.name = 'OfferEnvelopeIntegrityError'
  }
}

export class OfferEnvelopeRepository {
  /**
   * Verify, then store. CURRENT-STATE selection (ADR-001 §5: highest
   * `revision` wins, scoped to the offer identity `(ownerPublicKey,
   * logicalOfferId)`, Property H) is entirely `getLatest()`'s job, not
   * this method's — `ingest()` no longer rejects an envelope merely for
   * carrying a revision lower than one already stored (see Property P
   * below). What `ingest()` still guards against: malformed/invalid
   * envelopes (`verifyOfferEnvelope()`), and duplicate storage of a fact
   * this node already has (Properties M/O below).
   *
   * **CTO Gate correction (2026-09-09), Sixth Pass, Property M —
   * concurrent identical-fact ingestion.** Reproduced directly against
   * real Postgres, before this fix: two concurrent `ingest(E1)` calls
   * (`Promise.all`) for the exact same signed envelope — both read
   * "no existing row" (a real TOCTOU race: neither write had landed yet
   * when either read happened), both attempted `create()`; the DB's own
   * unique constraint let exactly one succeed and threw a raw, uncaught
   * `PrismaClientKnownRequestError` (P2002) out of the SECOND caller's
   * `ingest()` call — an unhandled exception, not a graceful result.
   * Forbidden outcome, confirmed exactly as named. Fixed by relying on
   * the database's own ATOMIC uniqueness check as the actual
   * concurrency control (no global lock, no serialization — both
   * explicitly out of scope): `create()` is attempted directly, and a
   * P2002 on this table's own uniqueness constraint is caught and
   * converted into the identical graceful "already known, here is its
   * id" result the non-racing caller would have received from a
   * pre-check. Concurrent identical-fact ingestion is now idempotent:
   * one stored row, both callers receive an `accepted: true` result.
   *
   * **CTO Gate correction (2026-09-09), Sixth Pass, Property O —
   * `signature` is not a sound identity.** Confirmed directly (a
   * controlled test against the real `tweetnacl` verifier, not a guess):
   * given one valid Ed25519 signature `(R, S)` over a message, the
   * byte-different signature `(R, S + L)` (where `L` is the Ed25519
   * group order, `2^252 + 27742317777372353535851937790883648493`) also
   * verifies successfully against the identical message and public key
   * — with NO knowledge of the secret key required (classic Ed25519
   * signature malleability; `tweetnacl`'s verifier does not reject a
   * non-canonical `S`). Consequence: the Fifth Pass's own "different
   * signature at the same revision means equivocation" rule was
   * exploitable by a mere OBSERVER (not even the offer's owner) —
   * anyone who has seen one valid envelope can derive a second, valid,
   * byte-different signature over the IDENTICAL content and inject it,
   * falsely triggering `EQUIVOCATED` (a fail-closed, economically-inert
   * state) as a griefing vector against an offer the owner never
   * actually double-signed. Fixed: fact identity is now `contentDigest`
   * — `hashOfferEnvelope()`'s sha256 hex digest of the canonical
   * serialization, a pure function of the signed CONTENT fields only,
   * excluding `signature` — used both for the DB uniqueness constraint
   * (`prisma/schema.prisma`) and for `getLatest()`'s distinctness check
   * below. `signature` remains stored in full and is still what
   * `verifyOfferEnvelope()` re-checks on every call — it is demoted from
   * "identity" to "authorization evidence," never removed.
   *
   * **CTO Gate correction (2026-09-09, Sixth Pass, Property P —
   * historical-evidence convergence).** Reproduced directly: "History A"
   * (E1 rev5, E2 rev5, then rev6) and "History B" (rev6 arrives FIRST,
   * then E1 rev5, then E2 rev5) both eventually see the identical three
   * signed facts, and both converge on the identical CURRENT state
   * (rev6) — but, under the Fifth Pass's own "revision < highest is
   * stale, reject" rule, History B's own E1/E2 (arriving after rev6 was
   * already known) would have been rejected outright as stale, so
   * History B would end up with ZERO evidence that this owner ever
   * equivocated, while History A retains both rev5 rows — **the
   * historical-fact set and equivocation evidence a node ends up
   * holding depended on arrival order**, even though current-state
   * selection did not. Decision, evaluated explicitly (property first,
   * mechanism second): **Option B — all valid signed facts are
   * retained as historical/equivocation evidence, regardless of whether
   * their revision is lower than one already known.** Rejected Option A
   * (drop stale facts, document that absence of local equivocation
   * evidence proves nothing) because: reputation/abuse/dispute evidence
   * is a named ADR-001 concern this protocol already cares about, and
   * losing it purely as an artifact of arrival order undermines that for
   * free; Property O's own content-digest-based idempotency bounds
   * REPLAY of an already-known fact to zero additional storage — that
   * part genuinely is a cryptographic guarantee (an attacker cannot make
   * the SAME fact cost more than one row). **Corrected (2026-09-09,
   * Seventh Pass, Property R):** this decision's own reasoning
   * originally over-claimed "storage/bandwidth cost is bounded by
   * cryptography" for GENUINELY NEW facts too — that is false.
   * Cryptographic authenticity limits WHO can produce a valid fact for a
   * given offer identity; it does NOT bound HOW MANY distinct valid
   * facts that same authorized owner chooses to sign, nor how many
   * separate offer identities (Sybil `logicalOfferId`s, or Sybil
   * `ownerPublicKey`s entirely) a single real-world operator controls.
   * **Authenticity ≠ resource boundedness.** This is a genuine,
   * disclosed residual of Option B, not solved here: an owner's own
   * signed history can grow without a cryptographic quantity bound;
   * many Sybil identities can amplify storage/gossip pressure further
   * still; step (a) has no propagation, so network-bandwidth mitigation
   * is not designed here at all; propagation/storage resource-abuse
   * controls (rate limiting, stake/bond, proof-of-work, quotas,
   * reputation penalties, or any gossip-layer control) belong to their
   * own later CTO Gate — none is authorized or implemented here. Pruning
   * is deliberately NOT used to paper over this residual: pruning could
   * silently destroy exactly the equivocation/history evidence Option B
   * exists to preserve, trading a disclosed residual for a hidden one.
   * replay-abuse resistance (of an already-known fact specifically) is
   * unaffected either way (idempotent under both options); this remains
   * local persistence only (no gossip/bandwidth relaying implemented in
   * step (a) at all); and implementing Option B costs LESS code than
   * Option A here, not more — it is the absence of a special case ("if
   * this revision is lower than the current highest, reject before
   * storing"), not an added one. Implemented as the minimum step (a)
   * requires: the `revision < highest → reject` branch is removed;
   * storage and equivocation-detection apply uniformly to every valid
   * envelope regardless of its revision relative to whatever else is
   * already known. `getLatest()`'s CURRENT-STATE semantics are
   * completely unchanged by this — it already only ever looks at the
   * actual highest revision present in storage, independent of
   * insertion order.
   */
  async ingest(envelope: SignedOfferEnvelope): Promise<IngestResult> {
    const verdict = verifyOfferEnvelope(envelope)
    if (!verdict.valid) {
      return { accepted: false, reason: verdict.reason }
    }

    const contentDigest = hashOfferEnvelope(envelope).toString('hex')

    // Equivocation is a per-revision fact, independent of whether this
    // revision happens to be the identity's current highest (Property P)
    // — checked before the insert purely to label the *response*
    // accurately; the insert itself (and its own atomic uniqueness
    // guard, Property M) is what actually decides storage. This
    // pre-read is a genuine TOCTOU window under real concurrency —
    // Property S, `IngestResult`'s own doc comment above — so the
    // resulting `equivocationDetected` flag is advisory only, never
    // authoritative; `getLatest()` is.
    const siblingsAtThisRevision = await prisma.offerEnvelope.findMany({
      where: {
        ownerPublicKey: envelope.ownerPublicKey,
        logicalOfferId: envelope.logicalOfferId,
        revision: envelope.revision,
      },
    })
    const isNewDistinctFactAtThisRevision =
      siblingsAtThisRevision.length > 0 && !siblingsAtThisRevision.some((row) => row.contentDigest === contentDigest)

    try {
      const created = await prisma.offerEnvelope.create({ data: this.toRowData(envelope, contentDigest) })
      return isNewDistinctFactAtThisRevision
        ? { accepted: true, id: created.id, equivocationDetected: true }
        : { accepted: true, id: created.id }
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Property M: a concurrent caller (or a plain resend, malleated
        // signature included per Property O) already stored this exact
        // (ownerPublicKey, logicalOfferId, revision, contentDigest) —
        // idempotent, not an error.
        const existing = await prisma.offerEnvelope.findFirst({
          where: {
            ownerPublicKey: envelope.ownerPublicKey,
            logicalOfferId: envelope.logicalOfferId,
            revision: envelope.revision,
            contentDigest,
          },
        })
        if (existing) {
          return { accepted: true, id: existing.id }
        }
      }
      throw err
    }
  }

  private toRowData(envelope: SignedOfferEnvelope, contentDigest: string) {
    return {
      logicalOfferId: envelope.logicalOfferId,
      ownerPublicKey: envelope.ownerPublicKey,
      asset: envelope.asset,
      side: envelope.side,
      priceUsd: envelope.priceUsd,
      minAmount: envelope.minAmount,
      maxAmount: envelope.maxAmount,
      paymentMethod: envelope.paymentMethod,
      revision: envelope.revision,
      createdAt: new Date(envelope.createdAt),
      revisedAt: new Date(envelope.revisedAt),
      expiresAt: new Date(envelope.expiresAt),
      status: envelope.status,
      signature: envelope.signature,
      contentDigest,
    }
  }

  /**
   * The CURRENT economic state of a given offer identity
   * `(ownerPublicKey, logicalOfferId)` — `Property H` (2026-09-09)
   * explains why both parameters are required (`logicalOfferId` alone
   * does not name a unique offer). As of `Property J` (2026-09-09), this
   * can no longer be a single row-or-null: if the owner equivocated at
   * the current highest revision, EVERY conflicting row is returned,
   * tagged `EQUIVOCATED` — a caller MUST treat that state as
   * economically inactive (fail-closed), never pick one of the rows
   * arbitrarily. This verdict is order-independent by construction: it
   * is computed fresh, every call, from whatever this identity's
   * currently-stored rows are — never cached from whichever fact
   * happened to be ingested most recently.
   *
   * **CTO Gate correction (2026-09-09, Sixth Pass, Property O):**
   * distinctness among rows at the highest revision is now judged by
   * `contentDigest`, not `signature` — see `ingest()`'s own comment for
   * why `signature` is not sound for this.
   *
   * **CTO Gate correction (2026-09-09, Sixth Pass — deterministic
   * `EQUIVOCATED` representation):** `rows` is sorted by `contentDigest`
   * (ascending, lexicographic) before being returned. This is not
   * cosmetic — `contentDigest` is the one stable, content-derived
   * identity every conformant node can compute independently, so a
   * deterministic ordering means two nodes comparing an `EQUIVOCATED`
   * result (e.g. in a test, or a future evidence/audit consumer) can
   * rely on array order matching whenever the underlying row SET
   * matches — no accidental dependency on the database's own unordered
   * row-return order, and no dependency on insertion order.
   */
  async getLatest(ownerPublicKey: string, logicalOfferId: string): Promise<LatestOfferState> {
    const highest = await prisma.offerEnvelope.findFirst({
      where: { ownerPublicKey, logicalOfferId },
      orderBy: { revision: 'desc' },
    })
    if (!highest) {
      return { status: 'NOT_FOUND' }
    }

    const rowsAtHighestRevision = await prisma.offerEnvelope.findMany({
      where: { ownerPublicKey, logicalOfferId, revision: highest.revision },
    })
    // C9 - every row deciding the current state is re-verified on read: the table is a local cache, never trusted
    // on its own. One altered or forged row fails the whole identity closed; it is never skipped (that would fall
    // back to an older revision) and never folded into another row by its stored digest (that would hide it).
    const tampered = rowsAtHighestRevision.filter((row) => {
      const envelope = this.reconstructSignedEnvelope(row)
      return !verifyOfferEnvelope(envelope).valid || hashOfferEnvelope(envelope).toString('hex') !== row.contentDigest
    })
    if (tampered.length > 0) {
      throw new OfferEnvelopeIntegrityError(ownerPublicKey, logicalOfferId, highest.revision, tampered.map((row) => row.id))
    }
    const distinctByContentDigest = new Map(rowsAtHighestRevision.map((row) => [row.contentDigest, row]))
    const sortedRows = [...distinctByContentDigest.values()].sort((a, b) => a.contentDigest.localeCompare(b.contentDigest))

    if (sortedRows.length > 1) {
      return { status: 'EQUIVOCATED', revision: highest.revision, rows: sortedRows }
    }
    return { status: 'RESOLVED', row: sortedRows[0] }
  }

  /**
   * Property E — persistence round-trip. Reconstructs a `SignedOfferEnvelope`
   * from a stored row, re-deriving the exact canonical lexical form for
   * every amount/timestamp field rather than trusting Prisma's own
   * `.toString()` (which strips trailing zeros off a `Decimal` and would
   * silently break signed-byte identity — confirmed directly:
   * `new Prisma.Decimal('1.00000000').toString()` returns `"1"`, while
   * `.toFixed(8)` returns `"1.00000000"`). A row that was stored via
   * `ingest()` — which only ever stores an already-verified envelope —
   * must always reconstruct to bytes whose signature still verifies;
   * `tests/integration/offerEnvelopePersistenceRoundTrip.test.ts` checks
   * exactly this against a real database, not a mock.
   */
  reconstructSignedEnvelope(row: {
    logicalOfferId: string
    ownerPublicKey: string
    asset: OfferEnvelopeContent['asset']
    side: OfferEnvelopeContent['side']
    priceUsd: Parameters<typeof formatCanonicalDecimal>[0]
    minAmount: Parameters<typeof formatCanonicalDecimal>[0]
    maxAmount: Parameters<typeof formatCanonicalDecimal>[0]
    paymentMethod: OfferEnvelopeContent['paymentMethod']
    revision: number
    createdAt: Date
    revisedAt: Date
    expiresAt: Date
    status: OfferEnvelopeContent['status']
    signature: string
  }): SignedOfferEnvelope {
    return {
      logicalOfferId: row.logicalOfferId,
      ownerPublicKey: row.ownerPublicKey,
      asset: row.asset,
      side: row.side,
      priceUsd: formatCanonicalDecimal(row.priceUsd),
      minAmount: formatCanonicalDecimal(row.minAmount),
      maxAmount: formatCanonicalDecimal(row.maxAmount),
      paymentMethod: row.paymentMethod,
      revision: row.revision,
      createdAt: formatCanonicalTimestamp(row.createdAt),
      revisedAt: formatCanonicalTimestamp(row.revisedAt),
      expiresAt: formatCanonicalTimestamp(row.expiresAt),
      status: row.status,
      signature: row.signature,
    }
  }
}

/**
 * Property J's fail-closed rule made concrete and testable: an
 * `EQUIVOCATED` or `NOT_FOUND` offer state is never economically
 * active, full stop — regardless of what `expiresAt` any of the
 * conflicting rows might individually claim. Only `RESOLVED` (a single,
 * unambiguous signed fact at the current highest revision) can ever be
 * active, and only if that one row also passes the ordinary
 * `isOfferEnvelopeEconomicallyActive()` check (Property, unchanged).
 * Step (a) has no HTTP route yet to call this from, but the property
 * itself — equivocation must never resolve to picking one of the
 * conflicting prices — needs to be an actual, testable function now,
 * not a claim left implicit.
 */
export function isOfferStateEconomicallyActive(state: LatestOfferState, now: Date = new Date()): boolean {
  if (state.status !== 'RESOLVED') {
    return false
  }
  return isOfferEnvelopeEconomicallyActive(
    { status: state.row.status, expiresAt: formatCanonicalTimestamp(state.row.expiresAt) },
    now
  )
}

export const offerEnvelopeRepository = new OfferEnvelopeRepository()
