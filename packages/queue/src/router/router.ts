import {
    buildEventEmitter,
    createTypedEmit,
    type EventEmitter,
    type EventMap,
} from '../events'
import {
    isValidPattern,
    isValidTopicParts,
    matchTopicParts,
    TOPIC_SEPARATOR,
} from './match.util'

/**
 * Envelope enqueued into bound queues.
 * `topic` is the concrete published topic (wildcards resolved).
 */
export type RouteMessage<T = unknown> = {
    topic: string
    data: T
}

/** Minimal queue surface the router needs. */
export type RouteTarget<T = unknown> = {
    enqueue: (item: RouteMessage<T>) => void
}

/** Snapshot of the most recent unrouted publish. */
export type UnmatchedRecord = {
    topic: string
    data: unknown
}

export type BuildRouterOptions = {
    /**
     * When a publish matches **no** bindings, enqueue a {@link RouteMessage}
     * here (same shape as a normal route). Optional — stats + events still
     * track unmatched publishes without a sink.
     */
    unmatchedTarget?: RouteTarget
}

export type RouterEvents = {
    'router:bound': { pattern: string }
    'router:unbound': { pattern: string; removed: number }
    'router:published': {
        topic: string
        data: unknown
        matched: number
    }
    /**
     * Fired when no binding matched.
     * `delivered` is true only if {@link BuildRouterOptions.unmatchedTarget}
     * (or a target set via {@link Router.setUnmatchedTarget}) accepted the message.
     */
    'router:unmatched': {
        topic: string
        data: unknown
        delivered: boolean
    }
    'router:error': {
        operation: 'publish' | 'bind' | 'unmatched'
        error: unknown
        topic?: string
        pattern?: string
    }
}

export type Binding<T = unknown> = {
    pattern: string
    target: RouteTarget<T>
}

export type Router<TEvents extends EventMap = RouterEvents> = {
    /**
     * Bind a queue (or any `enqueue` target) to a topic pattern.
     * Returns an unbind function for this binding only.
     *
     * Patterns use `.` segments:
     * - `orders.created` exact
     * - `orders.*` one segment
     * - `orders.#` zero or more trailing segments
     */
    bind: <T = unknown>(
        pattern: string,
        target: RouteTarget<T>,
    ) => () => void
    /** Remove one binding, or all bindings for a pattern if target omitted. */
    unbind: <T = unknown>(pattern: string, target?: RouteTarget<T>) => void
    /**
     * Publish an event on a concrete topic. Enqueues a {@link RouteMessage}
     * into every matching target. Returns the number of matched bindings
     * (0 when unrouted; the unmatched sink does not count as a match).
     */
    publish: <T = unknown>(topic: string, data: T) => number
    /** Snapshot of current pattern → target bindings. */
    bindings: () => Binding[]
    /** Clear all bindings (does not clear unmatched stats or the sink target). */
    clear: () => void

    /**
     * Optional sink for unrouted publishes (`matched === 0`).
     * Pass `undefined` to clear.
     */
    setUnmatchedTarget: (target: RouteTarget | undefined) => void
    /** Current unmatched sink, if any. */
    getUnmatchedTarget: () => RouteTarget | undefined
    /** How many publishes have been unrouted since the last {@link clearUnmatched}. */
    unmatchedCount: () => number
    /** Most recent unrouted publish, if any. */
    lastUnmatched: () => UnmatchedRecord | undefined
    /** Reset unmatched count and last record (does not drain the sink queue). */
    clearUnmatched: () => void

    on: EventEmitter<TEvents>['on']
    emit: EventEmitter<TEvents>['emit']
}

/**
 * Topic router / controller: publish events, route into queues by pattern.
 */
export const buildRouter = (options: BuildRouterOptions = {}): Router => {
    const events = buildEventEmitter<RouterEvents>()
    const emitRouter = createTypedEmit<RouterEvents>(
        events.emit as (eventName: string, data: unknown) => void,
    )

    /** Internal binding: public shape + pre-split pattern for publish. */
    type InternalBinding = Binding & {
        readonly patternParts: readonly string[]
    }

    const routes: InternalBinding[] = []
    /** Bumped on bind / unbind / clear so publish can skip a full snapshot. */
    let routeVersion = 0
    let unmatchedTarget: RouteTarget | undefined = options.unmatchedTarget
    let unmatchedTotal = 0
    let lastUnmatchedRecord: UnmatchedRecord | undefined

    const bind = <T = unknown>(
        pattern: string,
        target: RouteTarget<T>,
    ): (() => void) => {
        if (!isValidPattern(pattern)) {
            const error = new Error(`Invalid route pattern: ${pattern}`)
            emitRouter('router:error', { operation: 'bind', error, pattern })
            throw error
        }

        const binding: InternalBinding = {
            pattern,
            patternParts: pattern.split(TOPIC_SEPARATOR),
            target: target as RouteTarget,
        }
        routes.push(binding)
        routeVersion += 1
        emitRouter('router:bound', { pattern })

        return () => {
            unbind(pattern, target as RouteTarget)
        }
    }

    const unbind = <T = unknown>(
        pattern: string,
        target?: RouteTarget<T>,
    ): void => {
        let removed = 0
        for (let i = routes.length - 1; i >= 0; i -= 1) {
            const route = routes[i]!
            if (route.pattern !== pattern) continue
            if (target !== undefined && route.target !== target) continue
            routes.splice(i, 1)
            removed += 1
        }
        if (removed > 0) {
            routeVersion += 1
            emitRouter('router:unbound', { pattern, removed })
        }
    }

    const deliverUnmatched = <T>(topic: string, data: T): boolean => {
        if (unmatchedTarget === undefined) {
            return false
        }

        try {
            unmatchedTarget.enqueue({ topic, data })
            return true
        } catch (error) {
            emitRouter('router:error', {
                operation: 'unmatched',
                error,
                topic,
            })
            return false
        }
    }

    const deliverToRoute = <T>(
        route: InternalBinding,
        message: RouteMessage<T>,
        topic: string,
    ): void => {
        try {
            route.target.enqueue(message as RouteMessage)
        } catch (error) {
            emitRouter('router:error', {
                operation: 'publish',
                error,
                topic,
                pattern: route.pattern,
            })
        }
    }

    const publish = <T = unknown>(topic: string, data: T): number => {
        // Split once: validate parts and match without a second split.
        const topicParts = topic.split(TOPIC_SEPARATOR)
        if (!isValidTopicParts(topicParts)) {
            const error = new Error(`Invalid publish topic: ${topic}`)
            emitRouter('router:error', { operation: 'publish', error, topic })
            throw error
        }

        const message: RouteMessage<T> = { topic, data }
        let matched = 0
        const startVersion = routeVersion

        // Fast path: iterate in place when bindings are stable. If bind/unbind
        // runs mid-publish, snapshot the *unprocessed* tail and finish safely.
        //
        // Intentional departure from strict snapshot-at-start (`[...routes]`):
        // - A route unbound before it is reached is skipped (old: still matched).
        // - A route bound mid-publish can still match if appended before the
        //   version bump is observed (old: not in the start snapshot).
        // Both require re-entrant bind/unbind from a target's enqueue — rare.
        for (let i = 0; ; ) {
            if (i >= routes.length) break

            if (routeVersion !== startVersion) {
                const snapshot = routes.slice(i)
                for (const route of snapshot) {
                    if (!matchTopicParts(route.patternParts, topicParts)) {
                        continue
                    }
                    matched += 1
                    deliverToRoute(route, message, topic)
                }
                break
            }

            const route = routes[i]!
            i += 1
            if (!matchTopicParts(route.patternParts, topicParts)) continue
            matched += 1
            deliverToRoute(route, message, topic)
        }

        if (matched === 0) {
            unmatchedTotal += 1
            lastUnmatchedRecord = { topic, data }
            const delivered = deliverUnmatched(topic, data)
            emitRouter('router:unmatched', { topic, data, delivered })
        } else {
            emitRouter('router:published', { topic, data, matched })
        }

        return matched
    }

    const bindings = (): Binding[] =>
        routes.map((route) => ({
            pattern: route.pattern,
            target: route.target,
        }))

    const clear = (): void => {
        if (routes.length === 0) return
        routes.length = 0
        routeVersion += 1
    }

    const setUnmatchedTarget = (target: RouteTarget | undefined): void => {
        unmatchedTarget = target
    }

    const getUnmatchedTarget = (): RouteTarget | undefined => unmatchedTarget

    const unmatchedCount = (): number => unmatchedTotal

    const lastUnmatched = (): UnmatchedRecord | undefined => lastUnmatchedRecord

    const clearUnmatched = (): void => {
        unmatchedTotal = 0
        lastUnmatchedRecord = undefined
    }

    const api: Router = {
        bind,
        unbind,
        publish,
        bindings,
        clear,
        setUnmatchedTarget,
        getUnmatchedTarget,
        unmatchedCount,
        lastUnmatched,
        clearUnmatched,
        on: events.on,
        emit: events.emit,
    }

    return api
}
