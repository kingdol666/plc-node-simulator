/**
 * HTTP GET 端点 —— 与主服务器同端口(4010),无独立监听。
 * 路由:/sim-http/{deviceId}{path};主项目 http 驱动配
 *   url = http://127.0.0.1:4010/sim-http/{deviceId}/api/value
 * 响应:'${value}' 纯数字文本,或 JSON 模板占位符。
 * 断链故障注入:disconnect 激活期间返回 503(主项目 fetch 5s 超时/错误分类可测)。
 */
import type { DeviceNode } from '../../shared/types'
import type { ProtocolHandle } from './registry'

const routes = new Map<string, DeviceNode>()

export function routeOf(deviceId: string, path: string): DeviceNode | undefined {
  const node = routes.get(deviceId)
  if (!node) return undefined
  return (node.config.paths ?? []).some(p => p.path === path) ? node : undefined
}

export function serveHttp(node: DeviceNode, path: string): { status: number, body: string } {
  const m = (node.config.paths ?? []).find(p => p.path === path)
  if (!m) return { status: 404, body: 'not found' }
  const sig = (node.signals ?? []).find(s => s.id === m.signalId)
  // 断链注入:故障窗内 503
  const rt = sig?.runtime
  if (rt?.disconnectUntil && Date.now() < rt.disconnectUntil) return { status: 503, body: 'disconnected(fault injection)' }
  const value = rt?.value ?? 0
  const template = m.responseTemplate
  const body = (!template || template === '${value}') ? String(value) : template.replace(/\$\{value\}/g, String(value))
  return { status: 200, body }
}

/** 按 deviceId + path 直接服务(index.ts 入口用;无循环依赖) */
export function serveById(deviceId: string, path: string): { status: number, body: string } {
  const node = routes.get(deviceId)
  if (!node) return { status: 404, body: 'not found' }
  return serveHttp(node, path)
}

export async function startHttpEndpoint(node: DeviceNode): Promise<ProtocolHandle> {
  routes.set(node.id, node)
  return {
    close: async () => { routes.delete(node.id) },
    summary: () => ({ protocol: 'http', paths: (node.config.paths ?? []).map(p => `/sim-http/${node.id}${p.path}`) }),
  }
}
