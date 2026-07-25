/** Thrown when worker / lifecycle option values are invalid. */
export class InvalidWorkerOptionError extends Error {
    override readonly name = 'InvalidWorkerOptionError'

    constructor(message: string) {
        super(message)
    }
}
