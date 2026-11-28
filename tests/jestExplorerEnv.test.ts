// Guard for tests/setup/closed-explorer.js (jest.config.js setupFiles): the Jest environment must point the multisig explorer at the
// local machine, never at a public host, so no test waits on (or leaks traffic to) the public network by default.
describe('Jest environment: multisig explorer', () => {
  it('MULTISIG_EXPLORER_API_URL points at localhost', () => {
    const url = process.env.MULTISIG_EXPLORER_API_URL
    expect(url).toBeDefined()
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(url as string).hostname)
  })
})
