/**
 * Sails — Persistent Participant Transport Identity
 * (ADR-001 §7/§7.1/§7.2/§21 step (b))
 *
 * **Renamed from `node-identity.ts` (2026-09-09, CTO Gate B correction).**
 * The prior name and its doc comment described this as "Sails Node
 * identity," which this correction found to be imprecise. Confronted
 * directly against `pear.service.ts`'s own pre-existing header comment
 * ("PearNode → one DHT node for ONE user... PearNodeRegistry → owns a
 * `Map<userId, PearNode>`") and against `PearNode.start()`'s own
 * `prisma.user.update({ where: { id: this.ownerUserId }, data: { peerId } })`
 * call (the derived `peerId` is written directly onto the `User` row):
 * this module has always persisted, per `ownerUserId` (= `User.id`), the
 * exact artifact ADR-001 §7.1 defines as **Transport identity = Pears/
 * HyperDHT `peerId`** — i.e. **Participant Transport Identity**, scoped
 * to one economic participant. See `docs/adr/ADR-001-day0-multi-operator-network.md`
 * §7.2 for the full correction narrative, including the confirmed-empty
 * answer to "what identifies a Sails Node *operator/runtime* to other
 * Sails Nodes" (nothing does, today — no code path, model, or keypair
 * represents an operator/deployment distinct from its hosted `User`
 * rows; `prisma/schema.prisma`'s only "node operator" fields are
 * `Decimal` payout-share percentages in distribution-policy models, not
 * an identity of any kind). That is a real, currently-undesigned gap,
 * named and registered (`docs/BACKLOG.md`), not solved by this module.
 *
 * **Central property (unchanged by the rename):** a participant's own
 * Pears/HyperDHT transport identity must remain stable across ordinary
 * restarts, so that participant's own direct-connection relationships
 * (trade communication, reconnection) survive a restart. **Precision
 * (2026-09-09, CTO Gate B final pass):** this is a
 * participant-to-participant property only. It does not make, and this
 * module cannot make, any Sails Node gossip-relay peer relationship
 * (§4, operator-to-operator) survive a restart — no operator-level
 * identity for gossip to attach to exists yet (§21(d), §7.2).
 *
 * **Confirmed current gap, before this module existed** (`pear.service.ts`'s
 * `PearNode.start()`): every call to `HyperDHT.keyPair()` with no
 * argument generates a fresh, random Ed25519 keypair — regenerated on
 * every server restart (this repository's `PearNode`/`PearNodeRegistry`
 * hold all node state in process memory only). Reproduced directly,
 * empirically, not merely inferred from reading the source: calling
 * `HyperDHT.keyPair()` twice, back to back, in the real, installed
 * `hyperdht@6.33.2` package produces two different `publicKey` values
 * every time (`tests/participantTransportIdentity.test.ts`'s own
 * "CONFIRMED gap" test).
 *
 * **Mechanism (OFFICIAL IMPLEMENTATION evidence — read directly from
 * `node_modules/hyperdht/index.js` and `node_modules/hyperdht/lib/crypto.js`,
 * and confirmed by running the real library, not assumed):**
 * `HyperDHT.keyPair(seed)` calls libsodium's
 * `crypto_sign_seed_keypair(publicKey, secretKey, seed)` when a `seed` is
 * supplied — the STANDARD, official Ed25519 deterministic-keypair
 * derivation (the same primitive `tweetnacl`'s own `sign.keyPair.fromSeed()`
 * wraps). Confirmed empirically: the identical 32-byte seed always
 * produces the identical `{publicKey, secretKey}` pair; a seed of any
 * other length throws `"seed must be 'crypto_sign_SEEDBYTES' bytes"` —
 * `crypto_sign_SEEDBYTES` is exactly 32. No new cryptographic primitive
 * is introduced here — this module's entire job is generating,
 * persisting, and reloading that one 32-byte seed; the actual Ed25519
 * derivation is `hyperdht`'s own, official, already-in-use code path.
 *
 * **Node Identity ≠ Participant Identity (ADR-001 §7) is preserved, not
 * contradicted, by this being scoped per-participant:** that frozen
 * property is about ECONOMIC AUTHORITY, not about database association —
 * it forbids a node's own key from ever signing an Offer's economic
 * terms on a participant's behalf, not from being associated with a
 * specific `User` row for bookkeeping. This module never reads, writes,
 * or derives from `User.publicKey`/`User.secretKey` (the economic
 * identity — and `User.secretKey` does not even exist as a column; this
 * codebase is already non-custodial for economic keys, confirmed
 * directly against `prisma/schema.prisma`'s `User` model). The seed this
 * module persists is generated independently (`crypto.randomBytes(32)`,
 * a fresh random value with no relationship to any economic key), and
 * the resulting keypair is used by `PearNode` for HyperDHT/Hyperswarm
 * transport authentication ONLY — never to sign an `OfferEnvelope`, a
 * `Trade` action, or any settlement-authorizing message
 * (`src/modules/open-liquidity/offer-envelope.ts`'s `signOfferEnvelope()`/
 * `verifyOfferEnvelope()` — the only place any `Offer`-level signature is
 * produced or checked in this codebase — imports only `tweetnacl`,
 * `crypto`, and `@prisma/client`, confirmed by direct read; it never
 * imports this module, `PearNode`, or `hyperdht` at all). Economic
 * authority isolation is therefore structurally true, not merely
 * documented: there is no code path by which this identity's private key
 * could be used to create, cancel, or sign on behalf of an Offer owner,
 * buyer, seller, or settlement authority.
 *
 * **Storage:** a plain local directory
 * (`config.pear.participantTransportIdentityStorageDir`, default
 * `./data/participant-transport-identity`, the identical `./data/<name>`
 * + env-var-override convention already established by
 * `evidence-provider.ts`'s `LocalFilesystemEvidenceProvider`) —
 * deliberately NOT a cloud KMS or external secret-store dependency; none
 * is required to solve local persistence. One seed file per participant,
 * named by `ownerUserId`.
 *
 * **Concurrent first-initialization (2026-09-09, CTO Gate B correction):**
 * the original version of this module had a real race — two concurrent
 * callers for the same, not-yet-initialized `ownerUserId` (e.g. two
 * near-simultaneous requests both triggering `PearNodeRegistry.start()`
 * for a user with no prior seed) could each generate a *different*
 * random seed and both call a plain `writeFile`, with the last writer
 * silently winning while the OTHER caller's in-memory `PearNode` kept
 * running under its own, never-actually-persisted-long-term losing seed
 * — exactly the "one runtime continues with a losing transient identity"
 * defect named in the correction. Fixed with a filesystem atomic
 * primitive, no new dependency: `fs.writeFile(seedPath, seed, {flag:
 * 'wx'})` maps to POSIX `O_CREAT|O_EXCL` (and NTFS `CREATE_NEW` on
 * Windows) — an exclusive create that fails with `EEXIST` if the file
 * already exists, atomically at the OS/filesystem level, not merely
 * within one Node.js process. On `EEXIST`, the loser reads back the
 * actual on-disk winner and returns THAT — never its own candidate.
 * Because the winner's `open`-then-`write` is not a single atomic step,
 * a loser could in principle observe a torn (short/empty) read if it
 * reads in the sub-millisecond window between the winner's file creation
 * and its write completing; `readWinnerAfterLosingRace()` retries a
 * bounded, tiny number of times specifically to tolerate that window
 * before concluding real corruption. See
 * `tests/participantTransportIdentity.test.ts`'s `Promise.all` test for
 * the executed evidence, and its own comment for the exact boundary of
 * what that evidence does and does not prove (same-process concurrent
 * async calls, not literal separate OS processes). **Durability
 * boundary, disclosed narrowly, not solved:** exclusive creation
 * (`O_CREAT|O_EXCL`) proves only that two concurrent initializers cannot
 * both become the persisted winner — it is a concurrency-correctness
 * primitive, not a crash/power-loss durability guarantee. No `fsync` is
 * performed; a seed reported as successfully created could, in
 * principle, still be lost to an OS crash or power loss before the
 * filesystem itself durably commits it. This pass adds no `fsync`,
 * transactional storage, new dependency, or additional mechanism to
 * close that gap — it is named as an unproven boundary, not solved
 * here.
 *
 * **Corruption / missing-secret behavior, both deliberately explicit
 * rather than silently permissive:**
 * - Seed file **absent entirely** → treated as first initialization only:
 *   a new seed is generated and an attempt is made to persist it via
 *   exclusive create; if that attempt wins the race, a WARN-level log
 *   line is emitted naming the newly-derived `peerId` — an operator who
 *   did NOT expect a new identity (e.g. their data directory was lost)
 *   has a concrete, loud signal to notice, even though this module
 *   cannot cryptographically distinguish "genuine first boot" from "the
 *   file was lost" by itself (named explicitly as a residual, not solved
 *   here).
 * - Seed file **present but the wrong length** (whether found on the
 *   initial read, or after losing a creation race and exhausting the
 *   torn-read retry budget) → thrown as
 *   `ParticipantTransportIdentityCorruptedError`, loudly, never silently
 *   discarded or silently regenerated.
 * - Ordinary restart (file present, correct length) → the identical seed
 *   is reloaded, byte for byte, producing the identical keypair.
 *
 * **Rotation is a separate, not-yet-authorized operation.** This module
 * does not provide a "rotate this identity" API — the only way to force
 * a new one today is to delete the seed file, indistinguishable, from
 * this module's own perspective, from data loss.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import HyperDHT from 'hyperdht'
import { config } from '../../config'
import { childLogger } from '../../common/logger'

const log = childLogger('participant-transport-identity')

/** `crypto_sign_SEEDBYTES` — confirmed directly against the real, installed `hyperdht`/libsodium: a seed of any other length throws. */
export const PARTICIPANT_TRANSPORT_IDENTITY_SEED_BYTES = 32

/** Bounded, dependency-free retry for the torn-read window described above — not a general retry policy. */
const RACE_READ_MAX_ATTEMPTS = 5
const RACE_READ_RETRY_DELAY_MS = 10

export class ParticipantTransportIdentityCorruptedError extends Error {
  constructor(seedPath: string, actualLength: number) {
    super(
      `Participant transport identity seed at "${seedPath}" is corrupted: expected ${PARTICIPANT_TRANSPORT_IDENTITY_SEED_BYTES} bytes, found ${actualLength}. ` +
        `This is never silently regenerated — doing so would create a new transport identity while the operator believes it is ` +
        `the same one. Restore the correct seed file from backup, or deliberately delete it to accept a new identity.`
    )
    this.name = 'ParticipantTransportIdentityCorruptedError'
  }
}

function seedPathFor(ownerUserId: string, storageDir: string): string {
  return path.join(storageDir, `${ownerUserId}.seed`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Called only after this process's own exclusive-create attempt lost
 * (EEXIST) — some other concurrent caller is the winner. Reads back
 * their persisted seed, tolerating a short, bounded number of retries in
 * case that caller's own write has not fully landed yet.
 */
async function readWinnerAfterLosingRace(seedPath: string): Promise<Buffer> {
  let lastLength = -1
  for (let attempt = 1; attempt <= RACE_READ_MAX_ATTEMPTS; attempt++) {
    const contents = await fs.readFile(seedPath)
    if (contents.length === PARTICIPANT_TRANSPORT_IDENTITY_SEED_BYTES) {
      return contents
    }
    lastLength = contents.length
    if (attempt < RACE_READ_MAX_ATTEMPTS) {
      await sleep(RACE_READ_RETRY_DELAY_MS)
    }
  }
  throw new ParticipantTransportIdentityCorruptedError(seedPath, lastLength)
}

/**
 * Loads this participant's persisted transport identity seed, generating
 * and persisting a new one only if none exists yet. Two concurrent
 * callers for the same `ownerUserId`/`storageDir` with no prior seed
 * converge on the same winning seed — see the module doc comment above.
 */
export async function loadOrCreateParticipantTransportIdentitySeed(
  ownerUserId: string,
  storageDir: string = config.pear.participantTransportIdentityStorageDir
): Promise<Buffer> {
  const seedPath = seedPathFor(ownerUserId, storageDir)

  let existing: Buffer | undefined
  try {
    existing = await fs.readFile(seedPath)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      // Anything other than "file does not exist" (permission denied,
      // I/O error, etc.) is a real problem this module does not know how
      // to safely recover from — propagate it rather than silently
      // treating it as "absent" and fabricating a new identity.
      throw err
    }
  }

  if (existing) {
    if (existing.length !== PARTICIPANT_TRANSPORT_IDENTITY_SEED_BYTES) {
      throw new ParticipantTransportIdentityCorruptedError(seedPath, existing.length)
    }
    return existing
  }

  // Genuinely absent, as of the read above — attempt to become the
  // creator via an atomic, exclusive filesystem create (POSIX
  // O_CREAT|O_EXCL / Windows CREATE_NEW). Two concurrent callers racing
  // here must converge on ONE on-disk seed; the loser must never return
  // its own generated-but-unpersisted candidate.
  const candidateSeed = randomBytes(PARTICIPANT_TRANSPORT_IDENTITY_SEED_BYTES)
  await fs.mkdir(storageDir, { recursive: true })

  try {
    await fs.writeFile(seedPath, candidateSeed, { mode: 0o600, flag: 'wx' })
  } catch (err: any) {
    if (err?.code !== 'EEXIST') {
      throw err
    }
    // Lost the race — do not return candidateSeed, it was never persisted.
    return readWinnerAfterLosingRace(seedPath)
  }

  // Won the race — candidateSeed is now exclusively created and
  // persisted to the local filesystem. Exclusive creation is what
  // prevents two concurrent initializers from both becoming the
  // persisted winner; it is not a crash/power-loss durability guarantee
  // (no fsync is performed here) — that boundary is disclosed, not
  // solved, in this module's own header comment.
  const peerId = HyperDHT.keyPair(candidateSeed).publicKey.toString('hex')
  log.warn({
    msg: 'New participant transport identity created — this ownerUserId had no prior persisted seed. ' +
      'If a prior identity was expected (this data directory should already have one), this indicates data loss, not a genuine first boot.',
    ownerUserId,
    peerId,
    seedPath,
  })

  return candidateSeed
}
