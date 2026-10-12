/**
 * S3EvidenceProvider — Issue #265. The production-capable implementation
 * of `EvidenceProvider` (`evidence-provider.ts`). Generic S3-compatible
 * object storage, not Cloudflare-only/AWS-only: `@aws-sdk/client-s3`
 * against a configurable `endpoint` works unmodified against real AWS
 * S3, Cloudflare R2 (S3-compatible API), MinIO, or any other
 * S3-compatible vendor — the mission's own explicit requirement to
 * prefer a standard, replaceable object-storage interface over vendor
 * lock-in. `LocalFilesystemEvidenceProvider` remains the dev/reference
 * implementation; this is the deployment target for production (see
 * `config/index.ts`'s own FATAL boot guard, which refuses to start a
 * production process without this provider fully configured).
 *
 * Encryption posture (mission Step 7): requests SSE-S3
 * (`ServerSideEncryption: 'AES256'`) on every `PutObjectCommand` — the
 * baseline every S3-compatible vendor supports without extra KMS setup
 * or cost, and the honest floor the mission asks for ("at minimum
 * production provider must support encryption at rest... do NOT invent
 * client-side encryption/key custody"). This is provider-managed
 * encryption at rest, not end-to-end/client-side encryption — do not
 * overclaim it as the latter.
 *
 * Privacy (mission "Required provider behavior"): no public bucket ACLs
 * are ever set, and no permanent public URL is constructed or returned
 * — `store()`/`retrieve()` only ever use the authenticated SDK client
 * boundary, never a signed/unsigned public link.
 */
import { createHash } from 'crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  type S3ClientConfig,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import type { EvidenceProvider, EvidenceProviderHealth, EvidenceObjectMetadata, StoredMedia } from './evidence-provider'
import { EvidenceStorageError } from '../../common/errors'

export interface S3EvidenceProviderConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  /** Optional deployment-owned bound for one SDK operation. No Sails default is invented here. */
  requestTimeoutMs?: number
}

export class S3EvidenceProvider implements EvidenceProvider {
  providerName = 's3'

  private readonly client: S3Client
  private readonly bucket: string
  private readonly requestTimeoutMs?: number

  constructor(cfg: S3EvidenceProviderConfig) {
    this.bucket = cfg.bucket
    if (cfg.requestTimeoutMs !== undefined && (!Number.isFinite(cfg.requestTimeoutMs) || cfg.requestTimeoutMs <= 0)) {
      throw new Error('S3 evidence requestTimeoutMs must be a positive finite number when configured')
    }
    this.requestTimeoutMs = cfg.requestTimeoutMs
    const clientConfig: S3ClientConfig = {
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle,
    }
    // Real AWS S3 resolves its own regional endpoint from `region` alone
    // — only set `endpoint` for an S3-compatible vendor (R2, MinIO) that
    // needs one. An empty string here would otherwise override the SDK's
    // own endpoint resolution with a broken empty-string URL.
    if (cfg.endpoint !== '') clientConfig.endpoint = cfg.endpoint
    this.client = new S3Client(clientConfig)
  }

  /**
   * Execute one SDK operation with an optional deployment-owned deadline.
   * Abort is cancellation of the local request, not evidence that a remote
   * write/delete did not commit. Callers therefore still receive UNAVAILABLE
   * and must reconcile ambiguous mutation outcomes rather than safe-retry them.
   */
  private async send<T>(command: unknown): Promise<T> {
    if (this.requestTimeoutMs === undefined) {
      return this.client.send(command as never) as Promise<T>
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Invoke the SDK first so the request has installed its abort listener
      // before the deadline can fire. This also keeps very small configured
      // bounds deterministic under scheduler pressure.
      const operation = this.client.send(command as never, { abortSignal: controller.signal }) as Promise<T>
      timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
      return await operation
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async store(media: Uint8Array, mimeType: string): Promise<StoredMedia> {
    const sha256 = createHash('sha256').update(media).digest('hex')
    // Content-addressed key — same identity scheme as
    // LocalFilesystemEvidenceProvider (mimeTypeExtension there), so
    // switching providers doesn't change what a stored reference's `uri`
    // looks like in kind, only where it resolves.
    const extension = mimeTypeExtension(mimeType)
    const key = `${sha256}${extension}`
    try {
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: media,
          ServerSideEncryption: 'AES256',
        })
      )
    } catch (err) {
      throw new EvidenceStorageError(`Evidence storage unavailable while storing ${key}: ${(err as Error).message}`, 'UNAVAILABLE')
    }
    return { provider: this.providerName, uri: key, sha256 }
  }

  async retrieve(uri: string): Promise<Uint8Array> {
    try {
      const result = await this.send<GetObjectCommandOutput>(new GetObjectCommand({ Bucket: this.bucket, Key: uri }))
      if (!result.Body) {
        throw new EvidenceStorageError(`Evidence storage returned no body for ${uri}`, 'UNAVAILABLE')
      }
      return await result.Body.transformToByteArray()
    } catch (err) {
      if (err instanceof EvidenceStorageError) throw err
      if (err instanceof NoSuchKey || isNotFoundError(err)) {
        throw new EvidenceStorageError(`Evidence not found at ${uri}`, 'NOT_FOUND')
      }
      throw new EvidenceStorageError(`Evidence storage unavailable for ${uri}: ${(err as Error).message}`, 'UNAVAILABLE')
    }
  }

  // CTO Delta — R1 Finding #4, completion. `HeadObjectCommand` is S3's
  // real object-metadata operation — it never downloads the body, only
  // headers (Content-Length among them), the correct primitive for
  // "does this exist / how big is it" without paying for retrieval.
  // S3 returns a genuine 404 `NotFound` for HeadObject specifically
  // (distinct from GetObject's `NoSuchKey`) — `isNotFoundError()` below
  // already covers both names plus the raw status-code fallback.
  async stat(uri: string): Promise<EvidenceObjectMetadata> {
    try {
      const result = await this.send<HeadObjectCommandOutput>(new HeadObjectCommand({ Bucket: this.bucket, Key: uri }))
      return { size: result.ContentLength ?? 0 }
    } catch (err) {
      if (err instanceof NotFound || isNotFoundError(err)) {
        throw new EvidenceStorageError(`Evidence not found at ${uri}`, 'NOT_FOUND')
      }
      throw new EvidenceStorageError(`Evidence storage unavailable for ${uri}: ${(err as Error).message}`, 'UNAVAILABLE')
    }
  }

  async delete(uri: string): Promise<void> {
    try {
      // S3's own DeleteObject is already idempotent — deleting an
      // already-absent key returns success (204), not an error — so no
      // NOT_FOUND special-casing is needed here, matching
      // LocalFilesystemEvidenceProvider's own idempotent delete()
      // contract.
      await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: uri }))
    } catch (err) {
      throw new EvidenceStorageError(`Evidence storage unavailable while deleting ${uri}: ${(err as Error).message}`, 'UNAVAILABLE')
    }
  }

  // Issue #265 CTO Gate R2, CONTRACT DELTA 4 — `HeadBucketCommand` is
  // the standard, cheap S3 reachability check: confirms the bucket
  // exists and is reachable with these credentials, without listing or
  // touching any object. Never throws — reported via `healthy: false`.
  async health(): Promise<EvidenceProviderHealth> {
    try {
      await this.send(new HeadBucketCommand({ Bucket: this.bucket }))
      return { healthy: true }
    } catch (err) {
      return { healthy: false, detail: (err as Error).message }
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404
}

function mimeTypeExtension(mimeType: string): string {
  const known: Record<string, string> = {
    image: '.bin',
    video: '.bin',
    document: '.bin',
    ocr: '.txt',
    external_reference: '.bin',
  }
  return known[mimeType] ?? '.bin'
}
