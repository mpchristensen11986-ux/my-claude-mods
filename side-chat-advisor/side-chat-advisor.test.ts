import { expect, test } from 'claude-code/testing'

import { classify, suggestion } from './hooks/register'

const BUSY = {
  recent: 'I updated the project schedule for the bridge job and ran the cost spreadsheet against the quantities file.',
  messageCount: 8,
  hasAttachments: false,
}

test('a short unrelated lookup is suggested', async () => {
  const v = classify('What does MSA stand for?', BUSY, 'medium')
  expect(v.isSuggested).toBe(true)
  expect(v.reason.length > 0).toBe(true)
})

test('an explicit tangent marker is suggested even when sensitivity is low', async () => {
  const v = classify('btw, quick question: how do you pronounce Worcestershire?', BUSY, 'low')
  expect(v.isSuggested).toBe(true)
})

test('work on the current task is not suggested', async () => {
  expect(classify('Fix the bug in this file and run the tests', BUSY, 'high').isSuggested).toBe(false)
  expect(classify('Update hooks/register.tsx to add a cooldown?', BUSY, 'high').isSuggested).toBe(false)
})

test('continuations, commands, attachments and empty chats are never suggested', async () => {
  expect(classify('yes, go ahead', BUSY, 'high').isSuggested).toBe(false)
  expect(classify('/status', BUSY, 'high').isSuggested).toBe(false)
  expect(classify('What does MSA stand for?', { ...BUSY, hasAttachments: true }, 'high').isSuggested).toBe(false)
  expect(classify('What does MSA stand for?', { ...BUSY, messageCount: 0, recent: '' }, 'high').isSuggested).toBe(false)
})

test('long prompts are not suggested', async () => {
  const long = `What is a bridge? ${'Please consider the following background detail. '.repeat(20)}`
  expect(classify(long, BUSY, 'high').isSuggested).toBe(false)
})

test('sensitivity moves the line and the verdict is deterministic', async () => {
  const prompt = 'Where is Paris?'
  const low = classify(prompt, BUSY, 'low')
  const high = classify(prompt, BUSY, 'high')
  expect(high.score).toBe(low.score)
  expect(high.isSuggested).toBe(true)
  expect(classify(prompt, BUSY, 'high')).toEqual(high)
})

test('the suggestion says to open a Side Chat in Split View', async () => {
  expect(suggestion('a quick lookup or definition')).toMatch(/open a Side Chat in Split View/i)
})

test('the prompt passes through unchanged and is never dropped', async ($, on) => {
  on('command.register', () => ({ value: { command: 'sidechat-advisor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Update the project schedule', toolUses: [] },
      { role: 'assistant', text: 'Done, the schedule is updated.', toolUses: [] },
    ],
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await $.prompt.submit({ text: 'btw what does MSA stand for?' })

  expect(result.drop).toBe(undefined)
  expect(result.text).toBe('btw what does MSA stand for?')
})
