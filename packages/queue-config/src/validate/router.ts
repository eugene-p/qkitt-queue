import type { BindingConfig, RouterConfig } from '../types'
import { configError } from '../errors'
import { expectString } from '../parse.util'
import { expectPlainObject } from './expect'

export const parseBindingConfig = (
    value: unknown,
    path: string,
): BindingConfig => {
    const obj = expectPlainObject(value, path)
    return {
        pattern: expectString(obj.pattern, `${path}.pattern`),
        queue: expectString(obj.queue, `${path}.queue`),
    }
}

export const parseRouterConfig = (
    value: unknown,
    path: string,
): RouterConfig => {
    const obj = expectPlainObject(value, path)
    const router: RouterConfig = {}

    if (obj.bindings !== undefined) {
        if (!Array.isArray(obj.bindings)) {
            return configError(
                'INVALID_TYPE',
                `${path}.bindings must be an array`,
                `${path}.bindings`,
            )
        }
        router.bindings = obj.bindings.map((binding, index) =>
            parseBindingConfig(binding, `${path}.bindings[${index}]`),
        )
    }

    if (obj.unmatchedQueue !== undefined) {
        router.unmatchedQueue = expectString(
            obj.unmatchedQueue,
            `${path}.unmatchedQueue`,
        )
    }

    return router
}
