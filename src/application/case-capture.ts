import { artifactBytes, caseArtifactKey } from '../domain/records.js'
import type {
  GuardianCaseArtifactV1,
  GuardianCaseCaptureConfigV1,
} from '../domain/records.js'

export interface CaseCaptureSink {
  enqueue(artifact: GuardianCaseArtifactV1): void
  drain(): Promise<void>
}

export interface InMemoryCaseCaptureStats {
  readonly mode: 'off' | 'full'
  readonly count: number
  readonly totalBytes: number
  readonly skipped: number
  readonly evicted: number
}

/**
 * In-memory case-capture sink implementing the H4 quota rules for tests and
 * pre-Storage-Domain development. It is NOT durable; a real DSH Storage Domain
 * backend must replace it for production full-capture.
 */
export class InMemoryCaseCaptureSink implements CaseCaptureSink {
  private readonly items = new Map<string, { artifact: GuardianCaseArtifactV1; bytes: number; expiresAt: number; insertedAt: number }>()
  private skipped = 0
  private evicted = 0

  constructor(private readonly config: GuardianCaseCaptureConfigV1) {}

  enqueue(artifact: GuardianCaseArtifactV1): void {
    if (this.config.mode !== 'full') {
      this.skipped += 1
      return
    }
    const key = caseArtifactKey(artifact.session, artifact.artifactId)
    const bytes = artifactBytes(key, artifact)
    if (bytes > this.config.maxArtifactBytes || bytes > this.config.maxTotalBytes) {
      this.skipped += 1
      return
    }
    const insertedAt = Date.now()
    this.items.set(key, { artifact, bytes, expiresAt: artifact.expiresAt, insertedAt })
    this.evictOverQuota()
  }

  async drain(): Promise<void> {
    // In-memory enqueue is synchronous; no flush needed.
  }

  stats(): InMemoryCaseCaptureStats {
    return {
      mode: this.config.mode,
      count: this.items.size,
      totalBytes: [...this.items.values()].reduce((sum, item) => sum + item.bytes, 0),
      skipped: this.skipped,
      evicted: this.evicted,
    }
  }

  private evictOverQuota(): void {
    while (
      this.items.size > this.config.maxCases
      || [...this.items.values()].reduce((sum, item) => sum + item.bytes, 0) > this.config.maxTotalBytes
    ) {
      const oldest = [...this.items.entries()].sort((a, b) =>
        a[1].expiresAt - b[1].expiresAt || a[1].insertedAt - b[1].insertedAt)[0]
      if (oldest === undefined) break
      this.items.delete(oldest[0])
      this.evicted += 1
    }
  }
}
