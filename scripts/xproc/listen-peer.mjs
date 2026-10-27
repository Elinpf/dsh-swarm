#!/usr/bin/env node
/**
 * 本机监听的「对端进程」（P32 · 两个独立启动的进程自动互连的验证载体）。
 *
 * 每个进程各自起一个 `team-transport`（backend=`local-listen`, endpoint=argv），
 * 在 `<registryDir>/<endpoint>.sock` 上**监听**并把端点写进 `<endpoint>.json`（端点注册）。
 * 其它进程经 registry **发现**地址后拨号（端点发现）——无需预置守护进程。
 *
 * argv：<endpoint> <registryDir> <mode:receiver|sender> <sink> [target]
 *   - receiver：监听 + 把收到的帧写 sink；保持存活。
 *   - sender：轮询发现 target 的 registry → 拨号 → 发一条 DM（event 帧）→ 退出。
 *
 * env：`REGISTRY_WAIT_MS`（sender 等待 target 出现的上限，默认 5000）。
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const TR_LIB = fileURLToPath(new URL('../../packages/team-transport/lib/index.js', import.meta.url))
const { default: TeamTransportService } = await import(TR_LIB)

const [endpoint, registryDir, mode, sink, target] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小假 ctx（Service 基类只需 reflect/effect/get/logger）。 */
function makeCtx() {
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    reflect: { provide() {} },
    get: () => undefined,
    effect: (fn) => fn(),
    emit() {},
    on: () => () => {},
  }
  return ctx
}

const svc = new TeamTransportService(makeCtx(), {
  backend: 'local-listen',
  endpoint,
  registryDir,
  maxQueue: 1024,
  maxHistory: 1024,
  reconnectTimeoutMs: 15000,
  reconnectIntervalMs: 200,
  ackTimeoutMs: 500,
  autoReconnect: true,
})

if (mode === 'receiver') {
  mkdirSync(registryDir, { recursive: true })
  // 就绪标记（供父进程等待 registry 落盘）
  svc.onFrame((_pid, f) => {
    appendFileSync(sink, `${JSON.stringify(f)}\n`)
  })
  // 保持存活
  const keep = setInterval(() => {}, 1000)
  keep.unref?.()
  // 让父进程知道该进程已启动
  process.stdout.write(`${JSON.stringify({ role: 'receiver', endpoint })}\n`)
} else {
  // 等自身监听服务端起来（registry 出现）→ 保证 factory 已装配
  const selfKey = `${endpoint.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
  {
    const dl = Date.now() + 3000
    while (!existsSync(join(registryDir, selfKey)) && Date.now() < dl) await sleep(30)
  }
  // sender：等待发现 target
  const key = `${target.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
  const waitMs = Number(process.env.REGISTRY_WAIT_MS ?? 5000)
  const deadline = Date.now() + waitMs
  while (!existsSync(join(registryDir, key)) && Date.now() < deadline) await sleep(50)
  const found = existsSync(join(registryDir, key))
  try {
    await svc.send(target, {
      kind: 'event',
      teamId: 'T',
      payload: {
        targetId: `${target}-member`,
        messageId: 'dm-1',
        content: [{ type: 'text', text: 'hi' }],
      },
    })
  } catch {
    /* ignore */
  }
  await sleep(500) // 给帧往返/ack 一点时间
  writeFileSync(
    join(registryDir, `${endpoint}.done`),
    JSON.stringify({ found, stats: svc.stats(), peers: svc.peers() }),
  )
  process.exit(0)
}
