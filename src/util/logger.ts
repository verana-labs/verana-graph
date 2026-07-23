import { pino } from 'pino'

export function createLogger(level: string) {
  return pino({ level, name: 'verana-graph' })
}

export type Logger = ReturnType<typeof createLogger>
