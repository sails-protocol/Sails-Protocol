import { execSync } from 'child_process'
import nacl from 'tweetnacl'

const BASE_URL = process.env.SAILS_BASE_URL ?? 'http://127.0.0.1:3000'
const HEALTH_URL = `${BASE_URL}/health`
const PARTICIPANTS_URL = `${BASE_URL}/v1/identity/participants`
// Issue #302 — registration now requires proof of possession via its
// own, separate challenge namespace (never CHALLENGE_URL below, a
// different security domain — see common/middleware/auth.ts's own
// REGISTER_CHALLENGE_PREFIX/REGISTRATION_PROOF_DOMAIN comments).
const REGISTER_CHALLENGE_URL = `${BASE_URL}/v1/identity/register-challenge`
const REGISTRATION_PROOF_DOMAIN = 'sails-registration-proof-of-possession:v1'
const CHALLENGE_URL = `${BASE_URL}/v1/identity/challenge`
const AUTH_URL = `${BASE_URL}/v1/identity/authenticate`
const OFFER_URL = `${BASE_URL}/v1/liquidity/offers`

function run(command: string): string {
  return execSync(command, { encoding: 'utf-8' }).trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  let body
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { status: res.status, body }
}

async function assertOk(url: string, init: RequestInit = {}): Promise<void> {
  const { status, body } = await request(url, init)
  if (status < 200 || status >= 300) {
    throw new Error(`Request failed ${url} ${status}: ${JSON.stringify(body)}`)
  }
}

async function fetchJson(url: string, data: unknown, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  return request(url, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify(data),
  })
}

function dockerComposeService(service: 'postgres' | 'redis', action: 'stop' | 'start'): void {
  console.log(`[docker] ${action} ${service}`)
  run(`docker compose ${action} ${service}`)
}

async function waitForHealth(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await request(HEALTH_URL)
      if (res.status === 200) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`Health check did not become ready within ${timeoutMs}ms`)
}

async function main(): Promise<void> {
  console.log('=== SDK failure-injection script ===')
  console.log('Base URL:', BASE_URL)

  console.log('Checking app health...')
  await waitForHealth()
  console.log('App is healthy')

  const keypair = nacl.sign.keyPair()
  const publicKey = bytesToHex(keypair.publicKey)

  console.log('Requesting registration challenge...')
  const displayName = 'failure-injection'
  const registerChallengeRes = await fetchJson(REGISTER_CHALLENGE_URL, { publicKey })
  if (registerChallengeRes.status !== 200) {
    throw new Error(`Registration challenge request failed: ${JSON.stringify(registerChallengeRes.body)}`)
  }
  const registerChallenge = registerChallengeRes.body.data.challenge as string
  const registrationProofMessage = new TextEncoder().encode(`${REGISTRATION_PROOF_DOMAIN}:${registerChallenge}:${displayName}`)
  const registrationSignature = bytesToHex(nacl.sign.detached(registrationProofMessage, keypair.secretKey))

  console.log('Registering participant...')
  const createRes = await fetchJson(PARTICIPANTS_URL, { publicKey, signature: registrationSignature, displayName })
  if (createRes.status !== 201) {
    throw new Error(`Participant registration failed: ${JSON.stringify(createRes.body)}`)
  }

  console.log('Requesting auth challenge...')
  const challengeRes = await fetchJson(CHALLENGE_URL, { publicKey })
  if (challengeRes.status !== 200) {
    throw new Error(`Challenge request failed: ${JSON.stringify(challengeRes.body)}`)
  }

  const challenge = challengeRes.body.data.challenge as string
  const signature = bytesToHex(nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey))

  console.log('Authenticating...')
  const authRes = await fetchJson(AUTH_URL, { publicKey, signature })
  if (authRes.status !== 200) {
    throw new Error(`Authenticate failed: ${JSON.stringify(authRes.body)}`)
  }

  const token = authRes.body.data.sessionToken as string
  const headers = { Authorization: `Bearer ${token}` }

  console.log('Verified authenticated session with /v1/identity/me')
  await assertOk(`${BASE_URL}/v1/identity/me`, { headers })

  console.log('Stopping Redis to simulate session store failure...')
  dockerComposeService('redis', 'stop')
  await sleep(3000)

  console.log('Calling /v1/identity/me with Redis down...')
  const authFail = await request(`${BASE_URL}/v1/identity/me`, { headers })
  console.log('Result:', authFail.status, JSON.stringify(authFail.body))

  console.log('Restarting Redis...')
  dockerComposeService('redis', 'start')
  await waitForHealth()
  console.log('Redis restarted and app healthy again')

  console.log('Performing a DB-backed offer creation to establish state before Postgres failure...')
  const offerBody = {
    asset: 'BTC',
    side: 'SELL',
    priceUsd: '1.23',
    minAmount: '0.001',
    maxAmount: '0.005',
    paymentMethod: 'PIX',
    paymentDetails: 'failure-injection-test',
  }
  const offerRes = await fetchJson(OFFER_URL, offerBody, { headers })
  if (offerRes.status !== 201) {
    throw new Error(`Offer creation failed: ${JSON.stringify(offerRes.body)}`)
  }
  console.log('DB-backed offer created, now stopping Postgres...')

  dockerComposeService('postgres', 'stop')
  await sleep(3000)

  console.log('Calling /v1/liquidity/offers/mine with Postgres down...')
  const dbFail = await request(`${BASE_URL}/v1/liquidity/offers/mine`, { headers })
  console.log('Result:', dbFail.status, JSON.stringify(dbFail.body))

  console.log('Restarting Postgres...')
  dockerComposeService('postgres', 'start')
  await waitForHealth()
  console.log('Postgres restarted and app healthy again')

  console.log('=== Failure injection completed ===')
  console.log('Redis-down result:', JSON.stringify(authFail.body))
  console.log('Postgres-down result:', JSON.stringify(dbFail.body))
}

main().catch((err) => {
  console.error('Failure injection script failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
