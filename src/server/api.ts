/**
 * REST API —— 设备 CRUD / 启停 / 手动覆写 / 对接导出 / 场景预设。
 * 返回信封 {code, message, data}(与 AgentWorkShop apiClient 契约一致,便于复用其错误归一)。
 */
import {
  createRouter, defineEventHandler, readBody, getRouterParam, createError,
} from 'h3'
import { getConfig, findNode, upsertNode, removeNode, saveConfig, genId } from './store'
import { startNode, stopNode, isRunning } from './runtime'
import { startProtocol, stopProtocol, summaryOf } from './protocols/registry'
import { applyPreset } from './presets'
import type { SignalDef } from '../shared/types'

const ok = (data: unknown = null) => ({ code: 0, message: 'ok', data })
const fail = (status: number, code: string, message: string) => createError({ statusCode: status, data: { code, message } })

/** SP→PV 联动:信号值更新时,把引用它的映射(writebackTarget)目标回路的 first-order.sp 同步 */
function linkSpTarget(node: NonNullable<ReturnType<typeof findNode>>, signalId: string, out: number): void {
  for (const m of node.config.registerMaps ?? []) {
    if (m.writebackTarget !== signalId) continue
    const target = (node.signals ?? []).find(s => s.id === m.writebackTarget)
    if (target?.strategy.kind === 'first-order') target.strategy.sp = out
  }
}

/** 设备视图:配置 + 运行态(含信号当前值) */
function nodeView(node: ReturnType<typeof findNode>) {
  if (!node) return null
  return {
    ...node,
    runtime: {
      running: isRunning(node.id),
      startedAt: node.runtime?.startedAt,
      lastError: node.runtime?.lastError,
      protocol: summaryOf(node.id),
    },
    signals: (node.signals ?? []).map(s => ({
      id: s.id, name: s.name, unit: s.unit, min: s.min, max: s.max,
      decimals: s.decimals, strategy: s.strategy, faults: s.faults, tickMs: s.tickMs,
      value: s.runtime?.value ?? 0, hist: s.runtime?.hist ?? [],
    })),
  }
}

/** 启动一个设备:协议端点 + 信号 tick(协议失败记录 lastError 但不阻止 tick) */
export async function bootNode(node: NonNullable<ReturnType<typeof findNode>>): Promise<void> {
  if (!node.enabled) return
  startNode(node)
  try {
    await startProtocol(node)
    node.runtime = { ...node.runtime, lastError: undefined }
  }
  catch (err) {
    node.runtime = { ...node.runtime, lastError: (err as Error).message }
    console.error(`[boot] ${node.name} 协议端点启动失败:`, (err as Error).message)
  }
}

export async function haltNode(node: NonNullable<ReturnType<typeof findNode>>): Promise<void> {
  stopNode(node.id)
  await stopProtocol(node.id)
}

export function createApi() {
  const router = createRouter()

  router.get('/nodes', defineEventHandler(() => ok(getConfig().nodes.map(nodeView))))

  router.post('/nodes', defineEventHandler(async (event) => {
    const body = await readBody<Record<string, unknown>>(event) ?? {}
    if (!body.name || !body.protocol) throw fail(400, 'BAD_INPUT', 'name 与 protocol 必填')
    const node = {
      id: genId('dev'),
      name: String(body.name),
      protocol: body.protocol as never,
      enabled: body.enabled !== false,
      tickMs: Number(body.tickMs ?? 1000),
      signals: (body.signals ?? []) as never,
      config: (body.config ?? {}) as never,
      runtime: {},
    }
    upsertNode(node)
    await bootNode(node)
    saveConfig()
    return ok(nodeView(node))
  }))

  router.patch('/nodes/:id', defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    const cur = findNode(id ?? '')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    const body = await readBody<Record<string, unknown>>(event) ?? {}
    const wasEnabled = cur.enabled
    Object.assign(cur, {
      name: body.name !== undefined ? String(body.name) : cur.name,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : cur.enabled,
      tickMs: body.tickMs !== undefined ? Number(body.tickMs) : cur.tickMs,
      signals: (body.signals ?? cur.signals) as never,
      config: (body.config ?? cur.config) as never,
    })
    upsertNode(cur)
    // 配置变化 → 端点按新配置重启;启停联动
    if (wasEnabled && !cur.enabled) await haltNode(cur)
    else if (!wasEnabled && cur.enabled) await bootNode(cur)
    else if (cur.enabled) await bootNode(cur)
    saveConfig()
    return ok(nodeView(cur))
  }))

  router.delete('/nodes/:id', defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    const cur = findNode(id ?? '')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    await haltNode(cur)
    removeNode(cur.id)
    return ok()
  }))

  router.post('/nodes/:id/start', defineEventHandler(async (event) => {
    const cur = findNode(getRouterParam(event, 'id') ?? '')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    cur.enabled = true
    upsertNode(cur)
    await bootNode(cur)
    saveConfig()
    return ok(nodeView(cur))
  }))

  router.post('/nodes/:id/stop', defineEventHandler(async (event) => {
    const cur = findNode(getRouterParam(event, 'id') ?? '')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    cur.enabled = false
    upsertNode(cur)
    await haltNode(cur)
    saveConfig()
    return ok(nodeView(cur))
  }))

  // 手动覆写(UI「手动给定值」模拟操作工设定);若本信号被 SP 映射(writebackTarget)引用,联动目标回路 sp
  router.post('/nodes/:id/signals/:sid/manual', defineEventHandler(async (event) => {
    const cur = findNode(getRouterParam(event, 'id') ?? '')
    const sid = getRouterParam(event, 'sid')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    const sig = (cur.signals ?? []).find(s => s.id === sid)
    if (!sig) throw fail(404, 'NOT_FOUND', '信号不存在')
    const body = await readBody<{ value?: number }>(event) ?? {}
    const v = Number(body.value)
    if (!Number.isFinite(v)) throw fail(400, 'BAD_INPUT', 'value 必须是数字')
    if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
    sig.strategy = { kind: 'manual', value: v }
    sig.runtime.value = Number(v.toFixed(sig.decimals ?? 3))
    linkSpTarget(cur, sig.id, v)
    saveConfig()
    return ok({ id: sig.id, value: sig.runtime.value })
  }))

  // 策略覆写(直接替换信号的生成策略;调参/预置工况用)
  router.post('/nodes/:id/signals/:sid/strategy', defineEventHandler(async (event) => {
    const cur = findNode(getRouterParam(event, 'id') ?? '')
    const sid = getRouterParam(event, 'sid')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    const sig = (cur.signals ?? []).find(s => s.id === sid)
    if (!sig) throw fail(404, 'NOT_FOUND', '信号不存在')
    const body = await readBody<{ strategy?: Record<string, unknown> }>(event) ?? {}
    if (!body.strategy?.kind) throw fail(400, 'BAD_INPUT', 'strategy.kind 必填')
    const incoming = body.strategy as unknown as SignalDef['strategy']
    sig.strategy = incoming
    if (incoming.kind === 'manual' || incoming.kind === 'constant') {
      if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
      sig.runtime.value = Number((incoming as { value: number }).value.toFixed(sig.decimals ?? 3))
    }
    saveConfig()
    return ok({ id: sig.id, strategy: sig.strategy })
  }))

  router.get('/config', defineEventHandler(() => ok(getConfig())))

  router.put('/config', defineEventHandler(async (event) => {
    const body = await readBody<{ nodes?: unknown[] }>(event) ?? {}
    const { replaceAll } = await import('./presets')
    replaceAll((body.nodes ?? []) as never)
    return ok({ nodes: getConfig().nodes.length })
  }))

  router.post('/presets/:key', defineEventHandler(async (event) => {
    const key = getRouterParam(event, 'key')
    const created = await applyPreset(key ?? '', bootNode)
    return ok(created)
  }))

  router.get('/presets', defineEventHandler(() => ok([
    { key: 'film-line', name: '薄膜双拉产线(全协议,对齐主项目 DAQ 模板语义)' },
  ])))

  // 对接导出:生成主项目 /daq 添加节点所需 driverConfig + curl
  router.get('/nodes/:id/export', defineEventHandler((event) => {
    const cur = findNode(getRouterParam(event, 'id') ?? '')
    if (!cur) throw fail(404, 'NOT_FOUND', '设备不存在')
    return ok(buildExport(cur))
  }))

  return router
}

/** 生成主项目对接配置(每个信号一条:driver + driverConfig + 建议采样周期) */
function buildExport(node: NonNullable<ReturnType<typeof findNode>>) {
  const cfg = node.config
  const items: Array<{ signal: string, driver: string, driverConfig: Record<string, unknown>, curl: string }> = []
  const push = (signal: string, driver: string, driverConfig: Record<string, unknown>) => {
    const curl = [
      `curl -s -X POST http://127.0.0.1:3021/api/workshop/daq/test-driver`,
      `  -H 'content-type: application/json'`,
      `  -d '${JSON.stringify({ driver, driverConfig })}'`,
    ].join('\\n')
    items.push({ signal, driver, driverConfig, curl })
  }
  for (const s of node.signals ?? []) {
    if (node.protocol === 'modbus-tcp' || node.protocol === 'modbus-rtu') {
      const m = (cfg.registerMaps ?? []).find(r => r.signalId === s.id)
      if (!m) continue
      push(s.name, node.protocol, {
        host: '127.0.0.1', port: cfg.port, unitId: cfg.unitId ?? 1,
        register: m.address, registerType: m.area, dataType: m.dataType, byteOrder: m.byteOrder,
      })
    }
    else if (node.protocol === 'opcua') {
      const v = (cfg.opcVars ?? []).find(x => x.signalId === s.id)
      if (!v) continue
      push(s.name, 'opcua', { endpoint: `opc.tcp://127.0.0.1:${cfg.port ?? 4840}`, nodeId: v.nodeId })
    }
    else if (node.protocol === 'mqtt') {
      const t = (cfg.topics ?? []).find(x => x.signalId === s.id)
      if (!t) continue
      push(s.name, 'mqtt', { host: '127.0.0.1', port: Number(new URL(cfg.brokerUrl ?? 'mqtt://127.0.0.1:18830').port ?? 1883), topic: t.topic, jsonPath: 'data.temp' })
    }
    else if (node.protocol === 'http') {
      const p = (cfg.paths ?? []).find(x => x.signalId === s.id)
      if (!p) continue
      push(s.name, 'http', {
        url: `http://127.0.0.1:${process.env.SIM_PORT ?? 4010}/sim-http/${node.id}${p.path}`,
        // 主项目 http 驱动要求 jsonPath 提取(JSON 报文);纯数字文本则无需
        jsonPath: (p.responseTemplate ?? '').includes('{') ? 'data.value' : undefined,
      })
    }
  }
  return { device: { id: node.id, name: node.name, protocol: node.protocol }, items }
}
