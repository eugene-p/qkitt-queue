/** Base constraint for typed event maps. Avoids a string index signature so intersections stay precise. */
export type EventMap = Record<never, never>

/**
 * Merge event maps. Extra keys overwrite base keys (no `A[K] & B[K]` intersection).
 * Needed so generic decorator emit payloads stay assignable.
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
    /**
     * Emit an event to all current listeners (snapshot taken before dispatch).
     * Listener errors are isolated: one throw does not skip remaining listeners.
     * Failures are swallowed at emit time — listeners should handle their own errors
     * (critical paths like worker pump must not die because of a user handler).
     */
    emit: <K extends keyof TEvents>(eventName: K, data: TEvents[K]) => void
    /**
     * Like {@link EventEmitter.emit}, but `create` runs only when at least one
     * listener is registered. Use on hot paths to skip payload allocation when
     * nobody is subscribed.
     */
    emitLazy: <K extends keyof TEvents>(
        eventName: K,
        create: () => TEvents[K],
    ) => void
    /** Whether any listeners are registered for `eventName`. */
    hasListeners: <K extends keyof TEvents>(eventName: K) => boolean
}

export const buildEventEmitter = <
    TEvents extends EventMap = EventMap,
>(): EventEmitter<TEvents> => {
    const listenersByEvent = new Map<
        keyof TEvents,
        EventCallback<TEvents[keyof TEvents]>[]
    >()

    const remove = <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ): void => {
        const listeners = listenersByEvent.get(eventName)
        if (!listeners) return

        const next = listeners.filter((cb) => cb !== callback)
        if (next.length === 0) {
            listenersByEvent.delete(eventName)
        } else {
            listenersByEvent.set(eventName, next)
        }
    }

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

        return () => remove(eventName, callback)
    }

    const once = <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ): (() => void) => {
        const wrapper: EventCallback<TEvents[K]> = (data) => {
            remove(eventName, wrapper)
            callback(data)
        }

        return on(eventName, wrapper)
    }

    const dispatchTo = <K extends keyof TEvents>(
        listeners: EventCallback<TEvents[keyof TEvents]>[],
        data: TEvents[K],
    ): void => {
        // Single listener: no snapshot alloc (still isolate throws).
        if (listeners.length === 1) {
            try {
                listeners[0]!(data as TEvents[keyof TEvents])
            } catch {
                // Isolate: e.g. a throwing user handler must not skip worker pump.
            }
            return
        }

        // Snapshot so subscribe/unsubscribe during emit cannot skip or double-fire listeners.
        for (const callback of [...listeners]) {
            try {
                callback(data as TEvents[keyof TEvents])
            } catch {
                // Isolate: e.g. a throwing user handler must not skip worker pump.
            }
        }
    }

    const emit = <K extends keyof TEvents>(
        eventName: K,
        data: TEvents[K],
    ): void => {
        const listeners = listenersByEvent.get(eventName)
        if (!listeners?.length) return
        dispatchTo(listeners, data)
    }

    const emitLazy = <K extends keyof TEvents>(
        eventName: K,
        create: () => TEvents[K],
    ): void => {
        const listeners = listenersByEvent.get(eventName)
        if (!listeners?.length) return
        dispatchTo(listeners, create())
    }

    const hasListeners = <K extends keyof TEvents>(eventName: K): boolean => {
        const listeners = listenersByEvent.get(eventName)
        return !!listeners?.length
    }

    return {
        on,
        once,
        emit,
        emitLazy,
        hasListeners,
    }
}
