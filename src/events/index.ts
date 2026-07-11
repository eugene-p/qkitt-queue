/** Base constraint for typed event maps. Avoids a string index signature so intersections stay precise. */
export type EventMap = Record<never, never>

/**
 * Merge event maps. Extra keys overwrite base keys (no `A[K] & B[K]` intersection).
 * Needed so generic expand/withWorker emit payloads stay assignable.
 */
export type MergeEventMaps<
    TBase extends EventMap,
    TExtra extends EventMap,
> = Omit<TBase, keyof TExtra> & TExtra

export type EventCallback<T> = (data: T) => void

/**
 * Typed emit bridge over a loosely typed `emit`.
 * Avoids `TBase[K] & TExtra[K]` from generic map merges making concrete
 * payloads unassignable under a free `TEvents`.
 */
export const createTypedEmit = <TEvents extends EventMap>(
    emit: (eventName: string, data: unknown) => void,
) => {
    return <K extends keyof TEvents>(
        eventName: K,
        data: TEvents[K],
    ): void => {
        emit(eventName as string, data)
    }
}

export type EventEmitter<TEvents extends EventMap = EventMap> = {
    /** Subscribe to an event. Returns an unsubscribe function. */
    on: <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ) => () => void
    /** Subscribe for a single emission, then auto-unsubscribe. Returns an unsubscribe function. */
    once: <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ) => () => void
    /** Remove a specific listener, or all listeners for the event if no callback is given. */
    off: <K extends keyof TEvents>(
        eventName: K,
        callback?: EventCallback<TEvents[K]>,
    ) => void
    /**
     * Emit an event to all current listeners (snapshot taken before dispatch).
     * Listener errors are isolated: one throw does not skip remaining listeners.
     * Failures are swallowed at emit time — listeners should handle their own errors
     * (critical paths like worker pump must not die because of a user handler).
     */
    emit: <K extends keyof TEvents>(eventName: K, data: TEvents[K]) => void
    /** Remove all listeners for all events. */
    clear: () => void
    /** Number of listeners registered for an event. */
    listenerCount: <K extends keyof TEvents>(eventName: K) => number
    /** Event names that currently have at least one listener. */
    eventNames: () => (keyof TEvents)[]
    /**
     * Widen the event map with additional event types.
     * Returns the same instance (listeners preserved), typed as the merged map.
     * Extra keys overwrite base keys (see {@link MergeEventMaps}).
     *
     * @example
     * const base = buildEventEmitter<{ job: { id: string } }>()
     * const events = base.expand<{ drained: undefined; error: Error }>()
     * events.on('drained', () => {})
     */
    expand: <TExtra extends EventMap>() => EventEmitter<MergeEventMaps<TEvents, TExtra>>
}

export const buildEventEmitter = <
    TEvents extends EventMap = EventMap,
>(): EventEmitter<TEvents> => {
    const listenersByEvent = new Map<
        keyof TEvents,
        EventCallback<TEvents[keyof TEvents]>[]
    >()

    const on = <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ): (() => void) => {
        const listeners = listenersByEvent.get(eventName)
        if (listeners) {
            listeners.push(callback as EventCallback<TEvents[keyof TEvents]>)
        } else {
            listenersByEvent.set(eventName, [
                callback as EventCallback<TEvents[keyof TEvents]>,
            ])
        }

        return () => off(eventName, callback)
    }

    const once = <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ): (() => void) => {
        const wrapper: EventCallback<TEvents[K]> = (data) => {
            off(eventName, wrapper)
            callback(data)
        }

        return on(eventName, wrapper)
    }

    const off = <K extends keyof TEvents>(
        eventName: K,
        callback?: EventCallback<TEvents[K]>,
    ): void => {
        const listeners = listenersByEvent.get(eventName)
        if (!listeners) return

        if (!callback) {
            listenersByEvent.delete(eventName)
            return
        }

        const next = listeners.filter((cb) => cb !== callback)
        if (next.length === 0) {
            listenersByEvent.delete(eventName)
        } else {
            listenersByEvent.set(eventName, next)
        }
    }

    const emit = <K extends keyof TEvents>(
        eventName: K,
        data: TEvents[K],
    ): void => {
        const listeners = listenersByEvent.get(eventName)
        if (!listeners?.length) return

        // Snapshot so on/off during emit cannot skip or double-fire listeners.
        for (const callback of [...listeners]) {
            try {
                callback(data)
            } catch {
                // Isolate: e.g. a throwing user handler must not skip worker pump.
            }
        }
    }

    const clear = (): void => {
        listenersByEvent.clear()
    }

    const listenerCount = <K extends keyof TEvents>(eventName: K): number => {
        return listenersByEvent.get(eventName)?.length ?? 0
    }

    const eventNames = (): (keyof TEvents)[] => {
        return [...listenersByEvent.keys()]
    }

    const api: EventEmitter<TEvents> = {
        on,
        once,
        off,
        emit,
        clear,
        listenerCount,
        eventNames,
        expand: <TExtra extends EventMap>() =>
            api as unknown as EventEmitter<MergeEventMaps<TEvents, TExtra>>,
    }

    return api
}
