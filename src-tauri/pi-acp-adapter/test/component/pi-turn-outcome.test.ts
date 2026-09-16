import assert from 'node:assert/strict'
import test from 'node:test'
import { PiTurnOutcome } from '../../src/acp/pi-turn-outcome.js'

const ended = (stopReason: string) => ({ type: 'message_end', message: { role: 'assistant', stopReason } })

test('native failure remains failure after agent_settled', () => {
  const outcome = new PiTurnOutcome()
  outcome.event(ended('error'))
  assert.equal(outcome.result(), null)
  outcome.event({ type: 'agent_settled' })
  assert.equal(outcome.result(), 'error')
})

test('successful native retry replaces the earlier failure only at settled', () => {
  const outcome = new PiTurnOutcome()
  outcome.event(ended('error'))
  outcome.event({ type: 'auto_retry_start' })
  outcome.event(ended('stop'))
  assert.equal(outcome.result(), null)
  outcome.event({ type: 'agent_settled' })
  assert.equal(outcome.result(), 'end_turn')
})

test('cancel intent alone cannot confirm cancellation', () => {
  const outcome = new PiTurnOutcome()
  outcome.cancelling()
  outcome.event({ type: 'agent_settled' })
  assert.equal(outcome.result(), null)
  outcome.cancelFailed()
  assert.throws(() => outcome.result())
})

test('confirmed native abort with settled can resolve cancellation', () => {
  const outcome = new PiTurnOutcome()
  outcome.cancelling()
  outcome.cancelled()
  assert.equal(outcome.result(), null)
  outcome.event({ type: 'agent_settled' })
  assert.equal(outcome.result(), 'cancelled')
})

test('native completed answer is not relabelled merely because cancel was requested', () => {
  const outcome = new PiTurnOutcome()
  outcome.cancelling()
  outcome.event(ended('stop'))
  outcome.event({ type: 'agent_settled' })
  outcome.cancelled()
  assert.equal(outcome.result(), 'end_turn')
})

test('pure extension requires its separate native completion evidence', () => {
  const outcome = new PiTurnOutcome()
  assert.equal(outcome.result(), null)
  outcome.extensionCompleted()
  assert.equal(outcome.result(), 'end_turn')
})

test('settled without a native answer or extension evidence remains unknown', () => {
  const outcome = new PiTurnOutcome()
  outcome.event({ type: 'agent_settled' })
  assert.throws(() => outcome.result())
})
