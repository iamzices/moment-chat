// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { RoomEngine } from './lib/room'

beforeEach(() => { history.replaceState(null, '', '/'); vi.spyOn(RoomEngine.prototype, 'requestJoin').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('joining with the single code control', () => {
  it('cancels a pending join request with Escape', async () => {
    const user = userEvent.setup()
    const cancel = vi.spyOn(RoomEngine.prototype, 'cancel').mockImplementation(() => {})
    vi.mocked(RoomEngine.prototype.requestJoin).mockImplementation(function (this: any) { this.set({ screen: 'waiting' }) })
    render(<App />)
    await user.type(screen.getByRole('textbox', { name: 'Room Code or Invite Link' }), 'ab23cd{Enter}')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(cancel).toHaveBeenCalled()
  })

  it('submits a typed code with Enter and offers an editable, prefilled name', async () => {
    const user = userEvent.setup()
    render(<App />)
    const code = screen.getByRole('textbox', { name: 'Room Code or Invite Link' })
    await user.type(code, 'ab23cd{Enter}')
    expect(location.search).toBe('?room=AB23CD')
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(name.value).toMatch(/^User\d{4}$/)
    expect(document.activeElement).toBe(name)
    await user.keyboard('{Enter}')
    expect(RoomEngine.prototype.requestJoin).toHaveBeenCalledWith(name.value)
  })

  it('replaces a partial code with a pasted invite URL and submits it with Enter', async () => {
    const user = userEvent.setup()
    render(<App />)
    const code = screen.getByRole('textbox', { name: 'Room Code or Invite Link' }) as HTMLInputElement
    await user.type(code, 'xx')
    await user.paste('https://chat.zices.com/?room=HLMV2K')
    expect(code.value).toBe('https://chat.zices.com/?room=HLMV2K')
    await user.keyboard('{Enter}')
    expect(location.search).toBe('?room=HLMV2K')
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy()
  })

  it('keeps incomplete codes on the same screen with one actionable error', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByRole('textbox', { name: 'Room Code or Invite Link' }), 'abc{Enter}')
    expect(location.search).toBe('')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('6-character')
  })
})
