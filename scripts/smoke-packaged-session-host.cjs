const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const appOutDir = path.resolve(process.argv[2] || path.join('dist', 'win-unpacked'))
const executable = path.join(appOutDir, 'nodeterm-session-host.exe')
const hostScript = path.join(appOutDir, 'resources', 'app.asar', 'out', 'session-host', 'host.cjs')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-packaged-host-'))
const statePath = path.join(userDataDir, 'session-host.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForState() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const token = fs.readFileSync(state.tokenPath, 'utf8').trim()
      if (state.pid && state.endpoint && state.protocolVersion && token) return { state, token }
    } catch {
      // Publication is atomic, but the process and scanner still race the first read.
    }
    await sleep(100)
  }
  throw new Error('packaged session host did not publish usable state')
}

function hello(state, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(state.endpoint)
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('packaged session host hello timed out'))
    }, 5_000)
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: 1, cmd: 'hello', token, protocolVersion: state.protocolVersion })}\n`
      )
    })
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      const newline = data.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.end()
      const response = JSON.parse(data.slice(0, newline))
      if (response.id === 1 && response.ok === true) resolve()
      else reject(new Error(`packaged session host refused hello: ${data.slice(0, newline)}`))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function main() {
  if (process.platform !== 'win32') throw new Error('packaged session-host smoke requires Windows')
  if (!fs.existsSync(executable)) throw new Error(`session-host executable missing: ${executable}`)

  const child = spawn(executable, [hostScript, userDataDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })

  try {
    const { state, token } = await waitForState()
    if (state.pid !== child.pid) throw new Error(`published pid ${state.pid} did not match ${child.pid}`)
    await hello(state, token)
    console.log(`packaged session host answered authenticated hello (pid ${state.pid})`)
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    await sleep(250)
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
