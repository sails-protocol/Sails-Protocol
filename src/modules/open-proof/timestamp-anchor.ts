/**
 * TimestampAnchor — Sails OpenProof, RFC-008 D1. Closed 2026-08-04, real
 * submission verified against a live public OpenTimestamps calendar
 * server before writing this file (not assumed from documentation):
 *
 *   POST https://a.pool.opentimestamps.org/digest
 *   Content-Type: application/vnd.opentimestamps.v1
 *   body: <raw 32-byte SHA-256 digest>
 *   -> 200, same content-type, a real binary OpenTimestamps proof blob
 *
 * RFC-008 D1's own Reference Implementation Plan names `opentimestamps`
 * (Bitcoin-anchored) as the first real implementation, not `rfc3161` — a
 * deliberate choice this file follows, made concrete here rather than
 * left as a plan.
 *
 * Real deviation, disclosed: the npm packages for this
 * (`javascript-opentimestamps`, and its non-deprecated successor
 * `opentimestamps`) depend on `request`/`request-promise` — both
 * long-deprecated, unmaintained, with known vulnerabilities — plus a
 * heavy, partly-unrelated dependency tree (`bitcore-lib`, `web3`). This
 * file talks to the calendar server directly through the same bounded
 * transport (`boundedFetch()`) this codebase uses for `mempool.space`
 * (`multisig.provider.ts`) rather than pull in a vulnerable dependency for
 * one HTTP POST — the
 * calendar protocol itself is a simple, stable, documented wire format,
 * not something that needs a client library to speak correctly.
 *
 * Real, disclosed limitation: **submission only.** A pending OpenTimestamps
 * proof only becomes a fully verifiable Bitcoin-anchored timestamp once
 * the calendar server's own aggregation attests it into a real Bitcoin
 * block — typically up to a few hours later — and *verifying* that
 * (parsing the proof's Merkle path, checking it against a real block
 * header via a Bitcoin RPC/explorer) needs a real OTS binary-format
 * parser, which does not exist in this codebase. `upgrade()` below
 * throws a specific, honest error rather than faking a verified result —
 * the same "never fabricate a value" discipline `CODE_STYLE.md` §2
 * states for this whole codebase. `anchor()` itself is fully real: a
 * genuine submission to a live calendar server, not a stub.
 */

import { boundedFetch } from '../open-settlement/bounded-rpc'

export interface AnchorProof {
  anchorType: 'opentimestamps'
  // Base64 of the raw pending proof blob the calendar server returned —
  // opaque until a real OTS parser exists to walk it (see this file's
  // own header comment on upgrade()).
  anchorId: string
  submittedAt: string
  upgraded: false // always false — see upgrade()'s own disclosed limitation
}

export interface TimestampAnchor {
  anchorType: string
  anchor(sha256Hex: string): Promise<AnchorProof>
  upgrade(proof: AnchorProof): Promise<AnchorProof>
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

// CTO_DECISION_314A: one calendar submission is bounded by 30 s, end to end (connection, headers and the
// whole proof body, boundedFetch()'s own contract). One attempt, never retried: a POST that timed out may
// still have been aggregated by the calendar, and nothing here proves resubmitting it is harmless.
export const OTS_CALENDAR_TIMEOUT_MS = 30_000

// Most proof-body bytes a calendar answer may have. A calendar's answer to POST /digest is one serialized
// pending timestamp for one digest: a short chain of commitment operations (a nonce append, hashes, and
// one append/prepend of a 32-byte sibling per level of the calendar's aggregation tree) ending in a
// pending attestation naming the calendar's URL. Even a tree of 2^32 digests is 32 levels of ~34 bytes,
// about 1.1 KiB in all with the attestation; 16 KiB is over ten times that. More is not a proof this
// node can use: it fails the read (boundedFetch() counts the bytes actually received).
export const OTS_CALENDAR_MAX_RESPONSE_BYTES = 16 * 1024

export class OpenTimestampsAnchor implements TimestampAnchor {
  anchorType = 'opentimestamps' as const

  constructor(private readonly calendarUrl = 'https://a.pool.opentimestamps.org') {}

  async anchor(sha256Hex: string): Promise<AnchorProof> {
    if (!SHA256_HEX_PATTERN.test(sha256Hex)) {
      throw new Error(`TimestampAnchor: expected a 32-byte SHA-256 digest as hex, got "${sha256Hex}"`)
    }
    const digest = Buffer.from(sha256Hex, 'hex')

    const res = await boundedFetch(`${this.calendarUrl}/digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.opentimestamps.v1' },
      body: digest,
    }, {
      timeoutMs: OTS_CALENDAR_TIMEOUT_MS,
      maxResponseBytes: OTS_CALENDAR_MAX_RESPONSE_BYTES,
    })
    if (!res.ok) {
      throw new Error(`OpenTimestamps calendar server (${this.calendarUrl}) returned ${res.status} — refusing to fabricate an anchor`)
    }
    const proofBytes = Buffer.from(await res.arrayBuffer())

    return {
      anchorType: 'opentimestamps',
      anchorId: proofBytes.toString('base64'),
      submittedAt: new Date().toISOString(),
      upgraded: false,
    }
  }

  async upgrade(_proof: AnchorProof): Promise<AnchorProof> {
    throw new Error(
      'TimestampAnchor.upgrade() is not implemented — verifying a pending OpenTimestamps proof against a real ' +
      'Bitcoin block needs a real OTS binary-format parser (walking the Merkle path in the proof blob), which ' +
      'this codebase does not have. anchor() itself is real and already submitted to a live calendar server; ' +
      'only confirming that submission against Bitcoin is unbuilt.'
    )
  }
}

export const timestampAnchor: TimestampAnchor = new OpenTimestampsAnchor()
