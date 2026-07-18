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

/** Lazy proxy so storage is resolved on each call (SSR / late availability). */
export const lazyGlobalStorage = (
    name: 'localStorage' | 'sessionStorage',
): WebStorageLike => ({
    getItem: (key) => getGlobalStorage(name).getItem(key),
    setItem: (key, value) => getGlobalStorage(name).setItem(key, value),
    removeItem: (key) => getGlobalStorage(name).removeItem(key),
})

export const resolveStorage = (storage?: WebStorageLike): WebStorageLike => {
    if (storage) return storage
    return lazyGlobalStorage('localStorage')
}
