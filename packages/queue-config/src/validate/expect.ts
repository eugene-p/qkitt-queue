import { configError } from '../errors'
import { isPlainObject } from '../parse.util'

export const expectPlainObject = (
    value: unknown,
    path: string,
): Record<string, unknown> => {
    if (!isPlainObject(value)) {
        return configError('INVALID_TYPE', `${path} must be an object`, path)
    }
    return value
}
