import { expect, test } from 'claude-code/testing'

import { classify } from './hooks/advisor-logic'

test('a design choice gets the standard tier', () => {
  const v = classify('Should we use a monolith or microservices for the new architecture?', 'medium')
  expect(v?.category).toBe('architecture')
  expect(v?.tier).toBe('standard')
})

test('contract and commercial risk gets the deep tier', () => {
  const v = classify('Review the contract clause on liquidated damages and our margin before we sign', 'medium')
  expect(v?.category).toBe('commercial')
  expect(v?.tier).toBe('deep')
})

test('security gets the deep tier', () => {
  const v = classify('Check this auth flow for a security hole in how the token is stored', 'medium')
  expect(v?.tier).toBe('deep')
})

test('an explicit sanity check is a quick one', () => {
  const v = classify('Can you sanity check this regex for me please', 'medium')
  expect(v?.category).toBe('check')
  expect(v?.tier).toBe('quick')
})

test('everyday prompts and talk about the advisor itself are left alone', () => {
  expect(classify('rename this variable to total and fix the import', 'high')).toBe(null)
  expect(classify('How do I use /advisor with the security contract thing', 'high')).toBe(null)
})

test('sensitivity moves the line', () => {
  const text = 'Please read the variation notice and the claim'
  expect(classify(text, 'low')).toBe(null)
  expect(classify(text, 'high')?.category).toBe('commercial')
})

test('a long numbered plan counts as a plan', () => {
  const steps = [1, 2, 3, 4, 5, 6].map(n => `${n}. do step number ${n} of the plan and then check it carefully with the whole crew on site`).join('\n')
  expect(classify(`Here is the plan:\n${steps}`, 'medium')?.category).toBe('plan')
})

test('a stuck run raises one toast and the tool result is passed on untouched', async ($, on) => {
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'decision-support' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ isError: true, result: 'boom' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let last
  for (let i = 0; i < 4; i += 1) last = await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(last?.isError).toBe(true)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/advisor claude-opus-5-5')
})

test('the model mapping follows userConfig', { options: { standardModel: 'claude-sonnet-5-5', stuckThreshold: 1 } }, async ($, on) => {
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'decision-support' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ isError: true, result: 'boom' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(toasts[0]).toContain('/advisor claude-sonnet-5-5')
})
