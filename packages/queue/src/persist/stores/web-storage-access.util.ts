/** Minimal Web Storage surface (`localStorage` / `sessionStorage` / mocks). */
export type WebStorageLike = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
}

const getGlobalStorage = (
    name: 'localStorage' | 'sessionStorage',
): WebStorageLike => {
    const storage = (
        globalThis as unknown as Record<string, WebStorageLike | undefined>
    )[name]
    if (!storage) {
        throw new Error(
            `${name} is not available; pass an explicit \`storage\` option`,
        )
    }
    return storage
}

/**
 * Lazy proxy so storage is resolved on first successful access (SSR / late
 * availability). Failed lookups are not cached so a later-injected global still
 * works; once resolved, the handle is reused.
 */
export const lazyGlobalStorage = (
    name: 'localStorage' | 'sessionStorage',
): WebStorageLike => {
    let cached: WebStorageLike | undefined
    const resolve = (): WebStorageLike => {
        if (cached) return cached
        cached = getGlobalStorage(name)
        return cached
    }
    return {
        getItem: (key) => resolve().getItem(key),
        setItem: (key, value) => resolve().setItem(key, value),
        removeItem: (key) => resolve().removeItem(key),
    }
}

export const resolveStorage = (storage?: WebStorageLike): WebStorageLike => {
    if (storage) return storage
    return lazyGlobalStorage('localStorage')
}
