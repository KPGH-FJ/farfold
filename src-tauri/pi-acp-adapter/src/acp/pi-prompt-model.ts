import { RequestError } from '@agentclientprotocol/sdk'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { PiPromptModel } from '../pi-rpc/process.js'

const expectation = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(200),
    sessionFile: z.string().min(1).max(8192).refine(isAbsolute),
    provider: z
      .string()
      .min(1)
      .max(200)
      .refine(value => !value.includes('/')),
    modelId: z.string().min(1).max(512)
  })
  .strict()
  .refine(value => `${value.provider}/${value.modelId}`.length <= 512)

export function parsePromptModel(value: unknown, sessionId: string): PiPromptModel | undefined {
  if (value === undefined) return undefined
  const parsed = expectation.safeParse(value)
  if (!parsed.success || parsed.data.sessionId !== sessionId)
    throw RequestError.invalidParams('Pi prompt model expectation is invalid')
  const { version: _version, ...model } = parsed.data
  return model
}
