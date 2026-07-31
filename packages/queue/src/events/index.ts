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
    /**
     * Emit an event to all current listeners (snapshot taken before dispatch).
     * Listener errors are isolated: one throw does not skip remaining listeners.
     */
    emit: <K extends keyof TEvents>(eventName: K, data: TEvents[K]) => void
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

        // Remove one registration (indexOf + splice). Safe during emit because
        // dispatchTo snapshots the listener list before dispatch.
        const idx = listeners.indexOf(
            callback as EventCallback<TEvents[keyof TEvents]>,
        )
        if (idx === -1) return
        if (listeners.length === 1) {
            listenersByEvent.delete(eventName)
        } else {
            // Copy on subscription changes so an in-flight emit can iterate
            // its captured array without allocating a snapshot per emission.
            const next = listeners.slice()
            next.splice(idx, 1)
            listenersByEvent.set(eventName, next)
        }
    }

    const on = <K extends keyof TEvents>(
        eventName: K,
        callback: EventCallback<TEvents[K]>,
    ): (() => void) => {
        const listeners = listenersByEvent.get(eventName)
        if (listeners) {
            // Copy on write preserves emit snapshot semantics.
            listenersByEvent.set(eventName, [
                ...listeners,
                callback as EventCallback<TEvents[keyof TEvents]>,
            ])
        } else {
            listenersByEvent.set(eventName, [
                callback as EventCallback<TEvents[keyof TEvents]>,
            ])
        }

        return () => remove(eventName, callback)
    }

    const dispatchTo = <K extends keyof TEvents>(
        listeners: EventCallback<TEvents[keyof TEvents]>[],
        data: TEvents[K],
    ): void => {
        // Listener arrays are immutable while published, so this captured
        // array is the emit snapshot without a per-emission clone.
        for (const callback of listeners) {
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

    return {
        on,
        emit,
    }
}
