import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A request target node:http accepts but URL refuses (`//[`) is answered 400 and the process stays up.
// The server runs in a child process so a crash would show as an exit, not a failed test runner.
const SERVER = pathToFileURL(fileURLToPath(new URL('../src/server.ts', import.meta.url))).href
const children: ChildProcess[] = []
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL') })

function boot(): Promise<{ port: number; exited: Promise<{ code: number | null; stderr: string }> }> {
  const src = `import { createServer } from ${JSON.stringify(SERVER)}
const s = createServer({ providers: [], upstreams: {}, apiToken: 'tok', sealSecret: 'seal-secret-that-is-at-least-32-bytes-long' })
s.listen(0, '127.0.0.1', () => console.log(s.address().port))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', (c) => { stderr += c })
  const exited = new Promise<{ code: number | null; stderr: string }>((r) => child.on('exit', (code) => r({ code, stderr })))
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (d) => resolve({ port: Number(String(d).trim()), exited }))
    void exited.then(({ stderr }) => reject(new Error(`exited before listen: ${stderr}`)))
  })
}

function raw(port: number, target: string, method = 'GET'): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const s = net.connect(port, '127.0.0.1', () => s.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
    s.on('data', (c) => { out += c })
    s.on('close', () => resolve(out))
    s.on('error', () => resolve(out))
  })
}

const alive = (exited: Promise<unknown>) =>
  Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 300))])

describe('malformed request target', () => {
  it('control: /health is answered and the server stays up', async () => {
    const { port, exited } = await boot()
    expect(await raw(port, '/health')).toMatch(/^HTTP\/1.1 200/)
    expect(await alive(exited)).toBe('alive')
  }, 15_000)

  it('`//[` is answered 400 before auth, and the process keeps serving', async () => {
    const { port, exited } = await boot()
    for (const method of ['GET', 'POST']) {
      const reply = await raw(port, '//[', method)
      expect(reply).toMatch(/^HTTP\/1.1 400/)
      expect(reply).toContain('{"error":"bad request target"}')
    }
    expect(await alive(exited)).toBe('alive')
    expect(await raw(port, '/health')).toMatch(/^HTTP\/1.1 200/)
    const { stderr } = await Promise.race([exited, Promise.resolve({ stderr: '' })])
    expect(stderr).not.toMatch(/ERR_INVALID_URL/)
  }, 15_000)
})
