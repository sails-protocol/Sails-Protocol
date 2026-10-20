/**
 * Issue #265 — S3EvidenceProvider adapter tests: mocked
 * `S3Client.prototype.send` boundary, verifying the SDK request shapes
 * S3EvidenceProvider builds and the error-taxonomy mapping it applies —
 * distinct from evidenceProviderContract.test.ts, which proves
 * behavioral parity with LocalFilesystemEvidenceProvider. This file
 * proves the S3-specific wiring: correct upload/retrieval requests,
 * not-found vs. outage mapping, deletion, no secret leakage, and
 * endpoint/region/path-style config mapping.
 */
import { createHash } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, NoSuchKey, NotFound } from '@aws-sdk/client-s3'
import { S3EvidenceProvider } from '../src/modules/open-proof/s3-evidence-provider'
import { EvidenceStorageError } from '../src/common/errors'

afterEach(() => jest.restoreAllMocks())

const TEST_CONFIG = {
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'sails-evidence-test',
  accessKeyId: 'TEST_ACCESS_KEY_ID',
  secretAccessKey: 'TEST_SECRET_ACCESS_KEY_DO_NOT_LOG',
  forcePathStyle: true,
}

describe('S3EvidenceProvider — request shape', () => {
  it('store() sends a PutObjectCommand with the correct bucket, content-addressed key, body, and server-side encryption', async () => {
    const sendMock = jest.fn().mockResolvedValue({})
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)
    const media = new Uint8Array(Buffer.from('evidence bytes'))
    const expectedSha256 = createHash('sha256').update(media).digest('hex')

    const result = await provider.store(media, 'document')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const command = sendMock.mock.calls[0][0]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input.Bucket).toBe('sails-evidence-test')
    expect(command.input.Key).toBe(`${expectedSha256}.bin`)
    expect(command.input.Body).toBe(media)
    expect(command.input.ServerSideEncryption).toBe('AES256')
    expect(result.uri).toBe(`${expectedSha256}.bin`)
    expect(result.sha256).toBe(expectedSha256)
    expect(result.provider).toBe('s3')
  })

  it('retrieve() sends a GetObjectCommand for the correct bucket/key and returns the real bytes', async () => {
    const media = new Uint8Array(Buffer.from('round trip me'))
    const sendMock = jest.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        expect(command.input.Bucket).toBe('sails-evidence-test')
        expect(command.input.Key).toBe('some-key.bin')
        return { Body: { transformToByteArray: async () => media } }
      }
      throw new Error('unexpected command')
    })
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)
    const retrieved = await provider.retrieve('some-key.bin')

    expect(Buffer.from(retrieved).equals(Buffer.from(media))).toBe(true)
  })

  it('delete() sends a DeleteObjectCommand for the correct bucket/key', async () => {
    const sendMock = jest.fn().mockResolvedValue({})
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)
    await provider.delete('key-to-delete.bin')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const command = sendMock.mock.calls[0][0]
    expect(command).toBeInstanceOf(DeleteObjectCommand)
    expect(command.input.Bucket).toBe('sails-evidence-test')
    expect(command.input.Key).toBe('key-to-delete.bin')
  })
})

describe('S3EvidenceProvider — error-taxonomy mapping', () => {
  it('maps a NoSuchKey SDK error to EvidenceStorageError with storageReason NOT_FOUND, never UNAVAILABLE', async () => {
    const sendMock = jest.fn().mockRejectedValue(new NoSuchKey({ message: 'not found', $metadata: {} }))
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.retrieve('missing.bin')).rejects.toBeInstanceOf(EvidenceStorageError)
    await expect(provider.retrieve('missing.bin')).rejects.toMatchObject({ storageReason: 'NOT_FOUND' })
  })

  it('maps a 404-status generic SDK error to NOT_FOUND', async () => {
    const notFoundLikeError = Object.assign(new Error('Not Found'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    })
    const sendMock = jest.fn().mockRejectedValue(notFoundLikeError)
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.retrieve('missing.bin')).rejects.toMatchObject({ storageReason: 'NOT_FOUND' })
  })

  it('maps a network/timeout/outage-style SDK error to UNAVAILABLE, never NOT_FOUND — missing bytes != evidence never existed', async () => {
    const outageError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'NetworkingError' })
    const sendMock = jest.fn().mockRejectedValue(outageError)
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.retrieve('some-key.bin')).rejects.toMatchObject({ storageReason: 'UNAVAILABLE' })
  })

  it('maps a store() failure (outage) to EvidenceStorageError with storageReason UNAVAILABLE', async () => {
    const sendMock = jest.fn().mockRejectedValue(new Error('connection reset'))
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.store(new Uint8Array(Buffer.from('x')), 'document')).rejects.toMatchObject({
      storageReason: 'UNAVAILABLE',
    })
  })

  it('maps a delete() failure (outage) to EvidenceStorageError with storageReason UNAVAILABLE', async () => {
    const sendMock = jest.fn().mockRejectedValue(new Error('connection reset'))
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)

    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.delete('some-key.bin')).rejects.toMatchObject({ storageReason: 'UNAVAILABLE' })
  })
})

describe('S3EvidenceProvider — no secret leakage', () => {
  it('never retains the access key or secret as an own property of the provider itself — only the underlying SDK client holds them', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    // A stray `logger.info({ provider })` or error-context dump would
    // serialize the provider's OWN enumerable properties — not
    // `JSON.stringify` the whole (circular, SDK-internal) S3Client
    // object graph, which this test deliberately never touches. Proves
    // the constructor doesn't stash cfg.accessKeyId/cfg.secretAccessKey
    // anywhere on `this`.
    expect(Object.keys(provider)).not.toContain('accessKeyId')
    expect(Object.keys(provider)).not.toContain('secretAccessKey')
    for (const [key, value] of Object.entries(provider)) {
      if (typeof value !== 'string') continue
      expect(value).not.toBe(TEST_CONFIG.accessKeyId)
      expect(value).not.toBe(TEST_CONFIG.secretAccessKey)
      expect(key).not.toMatch(/secret|accessKey/i)
    }
  })
})

describe('S3EvidenceProvider — endpoint/config mapping', () => {
  it('maps region, endpoint, and forcePathStyle onto the underlying S3Client exactly as configured', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    const client = (provider as unknown as { client: S3Client }).client
    expect(client.config.forcePathStyle).toBe(true)
    await expect(client.config.region()).resolves.toBe('auto')
    const endpoint = await client.config.endpoint?.()
    expect(endpoint?.hostname).toBe('abc123.r2.cloudflarestorage.com')
  })

  it('lets the real AWS S3 endpoint resolve on its own when endpoint is empty (not overridden with a broken empty-string URL)', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    const provider = new S3EvidenceProvider({ ...TEST_CONFIG, endpoint: '' })

    const client = (provider as unknown as { client: S3Client }).client
    // AWS S3's own SDK-resolved endpoint for real regions always
    // contains 's3' — this only guards against the empty string being
    // passed through as a literal (unusable) endpoint override.
    const endpoint = await client.config.endpoint?.()
    if (endpoint) expect(endpoint.hostname).not.toBe('')
  })
})

// CTO Delta — R1 Finding #4, direct regression evidence for health().
// Mocked-SDK-boundary only: proves the request S3EvidenceProvider sends
// and how it maps outcomes, never a claim of live bucket reachability
// (no real S3/R2/MinIO credentials are available in this environment).
describe('S3EvidenceProvider — health()', () => {
  it('sends a HeadBucketCommand for the configured bucket and reports healthy on success', async () => {
    const sendMock = jest.fn().mockResolvedValue({})
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    const health = await provider.health()

    expect(health.healthy).toBe(true)
    const command = sendMock.mock.calls[0][0]
    expect(command).toBeInstanceOf(HeadBucketCommand)
    expect(command.input.Bucket).toBe('sails-evidence-test')
  })

  it('reports unhealthy, with a detail, when the bucket is unreachable — never throws out of health()', async () => {
    const sendMock = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    const health = await provider.health()

    expect(health.healthy).toBe(false)
    expect(health.detail).toBeTruthy()
  })
})

// CTO Delta — R1 Finding #4, completion. `stat()` uses HeadObjectCommand
// (never GetObjectCommand) — real object metadata without downloading
// the body. Same error-taxonomy discipline as retrieve(): a provider
// failure must never be reported as "object doesn't exist."
describe('S3EvidenceProvider — stat()', () => {
  it('sends a HeadObjectCommand for the correct bucket/key and returns the real ContentLength as size', async () => {
    const sendMock = jest.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        expect(command.input.Bucket).toBe('sails-evidence-test')
        expect(command.input.Key).toBe('some-key.bin')
        return { ContentLength: 1234 }
      }
      throw new Error('unexpected command')
    })
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    const result = await provider.stat('some-key.bin')

    expect(result.size).toBe(1234)
  })

  it('maps a NotFound HeadObject response to EvidenceStorageError with storageReason NOT_FOUND', async () => {
    const sendMock = jest.fn().mockRejectedValue(new NotFound({ message: 'not found', $metadata: {} }))
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.stat('missing.bin')).rejects.toBeInstanceOf(EvidenceStorageError)
    await expect(provider.stat('missing.bin')).rejects.toMatchObject({ storageReason: 'NOT_FOUND' })
  })

  it('maps a network/outage-style failure to storageReason UNAVAILABLE, never NOT_FOUND — a provider failure is never silently reported as object absence', async () => {
    const outageError = Object.assign(new Error('connect ETIMEDOUT'), { name: 'TimeoutError' })
    const sendMock = jest.fn().mockRejectedValue(outageError)
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await expect(provider.stat('some-key.bin')).rejects.toMatchObject({ storageReason: 'UNAVAILABLE' })
  })
})


describe('S3EvidenceProvider — bounded request / cancellation truth', () => {
  it('passes an AbortSignal to the SDK when a deployment timeout is configured', async () => {
    const sendMock = jest.fn().mockResolvedValue({})
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider({ ...TEST_CONFIG, requestTimeoutMs: 1000 })

    await provider.store(new Uint8Array(Buffer.from('bounded')), 'document')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const options = sendMock.mock.calls[0][1] as { abortSignal?: AbortSignal }
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(options.abortSignal?.aborted).toBe(false)
  })

  it('aborts a hung SDK operation at the configured bound and reports mutation outcome as UNAVAILABLE, never as a proven failed write', async () => {
    const sendMock = jest.fn((_command: unknown, options?: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = options?.abortSignal
        const rejectAborted = () => {
          const err = Object.assign(new Error('request aborted at local deadline'), { name: 'AbortError' })
          reject(err)
        }
        if (signal?.aborted) {
          rejectAborted()
          return
        }
        signal?.addEventListener('abort', rejectAborted, { once: true })
      })
    )
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider({ ...TEST_CONFIG, requestTimeoutMs: 25 })

    const startedAt = Date.now()
    const operation = provider.store(new Uint8Array(Buffer.from('ambiguous-write')), 'document')

    await expect(operation).rejects.toMatchObject({ storageReason: 'UNAVAILABLE' })
    expect(Date.now() - startedAt).toBeLessThan(1000)
    const options = sendMock.mock.calls[0][1] as { abortSignal?: AbortSignal }
    expect(options.abortSignal?.aborted).toBe(true)
  })

  it('does not invent a protocol timeout when none is configured', async () => {
    const sendMock = jest.fn().mockResolvedValue({})
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock as never)
    const provider = new S3EvidenceProvider(TEST_CONFIG)

    await provider.delete('unbounded-by-sails-default.bin')

    expect(sendMock.mock.calls[0][1]).toBeUndefined()
  })

  it('rejects invalid configured timeout values at construction', () => {
    expect(() => new S3EvidenceProvider({ ...TEST_CONFIG, requestTimeoutMs: 0 })).toThrow(/positive finite/)
    expect(() => new S3EvidenceProvider({ ...TEST_CONFIG, requestTimeoutMs: Number.NaN })).toThrow(/positive finite/)
  })
})
