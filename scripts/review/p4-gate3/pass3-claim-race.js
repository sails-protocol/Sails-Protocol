// PASS 3 claim race probe (SQL level, no application code). Reproduces claimTransitionRecoveryBatch() (src/common/events/event-projection.ts)
// with two concurrent connections over the same queue and counts how often the two batches overlap.
//   node pass3-claim-race.js <repo-with-pg-in-node_modules> <database-url> [trials=300] [variant=production|advisory|delay]
// variant=production : the statement as shipped.
// variant=advisory   : the same statement preceded, in one transaction, by a transaction-level advisory lock (the proposed fix).
// variant=delay      : the shipped statement with a 150 ms sleep per scanned row in its WHERE (deterministic demonstration that the
//                      window exists: B's snapshot is taken, A commits, B locks rows A already took).
const path = require('path')
const { Client } = require(path.join(process.argv[2], 'node_modules', 'pg'))
const url = process.argv[3]
const trials = Number(process.argv[4] || 300)
const variant = process.argv[5] || 'production'

const CLAIM = (delay) => `WITH picked AS (
  SELECT c.id FROM event_projection_claims c
  WHERE c."projectionKey" = 'transition.claimed' AND c."transitionProjectedAt" IS NULL AND c."appliedAt" < $2
    ${delay ? 'AND pg_sleep(0.15) IS NOT NULL' : ''}
  ORDER BY COALESCE(c."projectionRecoveryAttemptedAt", c."appliedAt"), c.id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE event_projection_claims c SET "projectionRecoveryAttemptedAt" = $3
FROM picked WHERE c.id = picked.id
RETURNING c."eventId"`

async function claim(client, limit, delay) {
  const claimedBefore = new Date(), stamped = new Date()
  if (variant === 'advisory') {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('pass3-transition-claim')::bigint)`)
    const r = await client.query(CLAIM(false), [limit, claimedBefore, stamped])
    await client.query('COMMIT')
    return r.rows.map(x => x.eventId)
  }
  return (await client.query(CLAIM(delay), [limit, claimedBefore, stamped])).rows.map(x => x.eventId)
}

;(async () => {
  const a = new Client({ connectionString: url }), b = new Client({ connectionString: url }), admin = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), admin.connect()])
  let overlaps = 0, short = 0, lostSlots = 0
  for (let t = 0; t < trials; t++) {
    await admin.query(`DELETE FROM event_projection_claims WHERE "projectionKey" = 'transition.claimed'`)
    await admin.query(`INSERT INTO event_projection_claims (id, "eventId", "projectionKey", "subjectId", "appliedAt")
      SELECT 'race-' || g, 'ev-' || g, 'transition.claimed', 'sub-' || g, timestamp '2000-01-01' + (g * interval '1 second') FROM generate_series(1, 16) g`)
    const delay = variant === 'delay'
    const [r1, r2] = await Promise.all([claim(a, 8, false), claim(b, 8, delay)])
    const inter = r1.filter(x => r2.includes(x))
    if (inter.length) { overlaps++; lostSlots += inter.length }
    if (new Set([...r1, ...r2]).size < 16) short++
  }
  console.log(JSON.stringify({ variant, trials, trialsWithOverlap: overlaps, overlapRate: +(overlaps / trials).toFixed(3), slotsWastedInTotal: lostSlots, trialsWhereUnionIsLessThan16: short }))
  await Promise.all([a.end(), b.end(), admin.end()])
})().catch(e => { console.error(e.message); process.exit(1) })
