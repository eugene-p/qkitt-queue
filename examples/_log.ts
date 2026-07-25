export const title = (name: string, fields?: string): void => {
  console.log(name)
  if (fields) console.log(fields)
}

export const phase = (name: string): void => {
  console.log()
  console.log(`--- ${name} ---`)
}

export const line = (kind: string, action: string, fields?: string): void => {
  const base = `${kind.padEnd(7)} ${action.padEnd(7)}`
  console.log(fields ? `${base} ${fields}` : base)
}

export const summary = (fields: string): void => {
  phase('summary')
  console.log(fields)
  console.log()
  console.log('==========')
  console.log()
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Prefer importing `whenIdle` from `@qkitt/queue` in new examples. */
export { whenIdle as waitIdle } from '@qkitt/queue'

export { sleep }
