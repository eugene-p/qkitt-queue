/**
 * Stable, application-owned envelope for work placed on a queue.
 *
 * The core queue deliberately accepts any payload. Use this envelope when a
 * persisted job needs an application id, enqueue timestamp, or correlation
 * metadata without mixing those concerns into the payload itself.
 */
export type Job<T, TMetadata = Record<string, unknown>> = {
    /** Stable application id. Use it as the idempotency key at side effects. */
    id: string
    payload: T
    /** Milliseconds since Unix epoch when the job was created. */
    enqueuedAt: number
    /** Optional application-owned correlation, tracing, or routing metadata. */
    metadata?: TMetadata
}

export type CreateJobOptions<TMetadata = Record<string, unknown>> = {
    /** Required application id; queue row ids remain an internal concern. */
    id: string
    metadata?: TMetadata
    /** Override the clock for imports or deterministic tests. */
    enqueuedAt?: number
}

export class InvalidJobOptionError extends Error {
    override readonly name = 'InvalidJobOptionError'

    constructor(message: string) {
        super(message)
    }
}

const isEpochMs = (value: number): boolean =>
    Number.isFinite(value) && value >= 0

/** Create a validated job envelope for `buildQueue<Job<T>>()`. */
export const createJob = <T, TMetadata = Record<string, unknown>>(
    payload: T,
    options: CreateJobOptions<TMetadata>,
): Job<T, TMetadata> => {
    if (options === null || typeof options !== 'object') {
        throw new InvalidJobOptionError('job options must include a string id')
    }
    if (typeof options.id !== 'string') {
        throw new InvalidJobOptionError('job id must be a non-empty string')
    }
    const id = options.id.trim()
    if (id.length === 0) {
        throw new InvalidJobOptionError('job id must be a non-empty string')
    }

    const enqueuedAt = options.enqueuedAt ?? Date.now()
    if (!isEpochMs(enqueuedAt)) {
        throw new InvalidJobOptionError(
            'job enqueuedAt must be a finite number >= 0',
        )
    }

    return {
        id,
        payload,
        enqueuedAt,
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    }
}

/** Narrow an unknown value to the envelope's stable structural fields. */
export const isJob = (value: unknown): value is Job<unknown, unknown> => {
    if (value === null || typeof value !== 'object') return false
    const job = value as Partial<Job<unknown, unknown>>
    return (
        typeof job.id === 'string' &&
        job.id.trim().length > 0 &&
        typeof job.enqueuedAt === 'number' &&
        isEpochMs(job.enqueuedAt) &&
        'payload' in job
    )
}
