import type { Tool } from '../types.ts'

/**
 * Gives the model a clock. Without this it has no idea what "now" is, which
 * matters for anything time-relative.
 */
export const currentTimeTool: Tool<Record<string, never>> = {
  name: 'current_time',
  description: 'Get the current date and time, in ISO 8601 (UTC) and local time.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute() {
    const now = new Date()
    const offsetMinutes = -now.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0')
    const offset = `UTC${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`
    return [
      `ISO (UTC):  ${now.toISOString()}`,
      `Local:      ${now.toString()}`,
      `Timezone:   ${offset}`,
    ].join('\n')
  },
}
