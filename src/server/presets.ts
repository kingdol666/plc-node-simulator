/**
 * 场景预设 —— 一键生成对齐 AgentWorkShop DAQ 模板语义的完整模拟产线。
 * film-line:五协议各一设备,信号域与主项目全协议矩阵 e2e 的期望域一致,
 * 主项目建节点即可一一对应(温度 30-75/165-185、压力 0.5-1.25、张力、流量 38-48)。
 */
import type { DeviceNode } from '../shared/types'
import { getConfig, saveConfig, genId } from './store'
import { stopNode } from './runtime'
import { stopProtocol } from './protocols/registry'

type Boot = (node: DeviceNode) => Promise<void>

export async function replaceAll(nodes: DeviceNode[]): Promise<void> {
  for (const n of getConfig().nodes) {
    stopNode(n.id)
    await stopProtocol(n.id)
  }
  getConfig().nodes = nodes
  saveConfig()
}

export async function applyPreset(key: string, boot: Boot): Promise<DeviceNode[]> {
  if (key !== 'film-line') throw new Error(`未知预设: ${key}`)
  const nodes = filmLinePreset()
  await replaceAll(nodes)
  for (const n of nodes) {
    if (n.enabled) await boot(n)
  }
  return nodes
}

export function filmLinePreset(): DeviceNode[] {
  return [
    {
      id: genId('dev'),
      name: '涂布烘干PLC',
      protocol: 'modbus-tcp',
      enabled: true,
      tickMs: 800,
      signals: [
        { id: 'temp-pv', name: '温度PV', unit: '℃', min: 0, max: 260, decimals: 1, tickMs: 800,
          strategy: { kind: 'first-order', initial: 24, tauMs: 8000, sp: 180, noise: 0.25 } },
        { id: 'temp-sp', name: '温度SP', unit: '℃', min: 0, max: 260, decimals: 1,
          strategy: { kind: 'manual', value: 180 } },
        { id: 'pressure', name: '压力PV', unit: 'MPa', min: 0, max: 2, decimals: 3,
          strategy: { kind: 'sine', base: 0.85, amp: 0.12, periodMs: 30000 } },
        { id: 'tension', name: '张力PV', unit: 'N', min: 0, max: 200, decimals: 1,
          strategy: { kind: 'random-walk', start: 120, step: 1.5, min: 80, max: 160 } },
        { id: 'speed', name: '速度PV', unit: 'm/min', min: 0, max: 300, decimals: 1,
          strategy: { kind: 'sine', base: 150, amp: 8, periodMs: 20000 } },
      ],
      config: {
        host: '0.0.0.0', port: 16040, unitId: 1,
        registerMaps: [
          { address: 40001, area: 'holding', signalId: 'temp-pv', dataType: 'float32', byteOrder: 'big' },
          { address: 40021, area: 'holding', signalId: 'temp-sp', dataType: 'float32', byteOrder: 'big', writebackTarget: 'temp-pv' },
          { address: 40003, area: 'holding', signalId: 'pressure', dataType: 'float32', byteOrder: 'big' },
          { address: 40005, area: 'holding', signalId: 'tension', dataType: 'float32', byteOrder: 'big' },
          { address: 40007, area: 'holding', signalId: 'speed', dataType: 'float32', byteOrder: 'big' },
        ],
      },
    },
    {
      id: genId('dev'),
      name: '远程RTU温度从站',
      protocol: 'modbus-rtu',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'rtu-temp', name: '炉温', unit: '℃', min: 0, max: 100, decimals: 1,
          strategy: { kind: 'sine', base: 66, amp: 3, periodMs: 15000 } },
      ],
      config: {
        host: '0.0.0.0', port: 15041, unitId: 1,
        registerMaps: [
          { address: 40001, area: 'holding', signalId: 'rtu-temp', dataType: 'float32', byteOrder: 'big' },
        ],
      },
    },
    {
      id: genId('dev'),
      name: 'OPCUA温控器',
      protocol: 'opcua',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'opc-temp', name: 'Temp', unit: '℃', min: 0, max: 260, decimals: 2,
          strategy: { kind: 'first-order', initial: 168, tauMs: 8000, sp: 180, noise: 0.3 } },
        { id: 'opc-sp', name: 'SetTemp', unit: '℃', min: 0, max: 260, decimals: 1,
          strategy: { kind: 'manual', value: 180 } },
      ],
      config: {
        host: '127.0.0.1', port: 5840, namespaceUri: 'PLC-Simulator',
        opcVars: [
          { nodeId: 'ns=2;s=AW.Temp', signalId: 'opc-temp', dataType: 'Double' },
          { nodeId: 'ns=2;s=AW.SetTemp', signalId: 'opc-sp', dataType: 'Double', writable: true },
        ],
      },
    },
    {
      id: genId('dev'),
      name: 'MQTT温度传感器',
      protocol: 'mqtt',
      enabled: true,
      tickMs: 2000,
      signals: [
        { id: 'mqtt-temp', name: 'temp', unit: '℃', min: 0, max: 100, decimals: 2,
          strategy: { kind: 'random-walk', start: 50, step: 2, min: 30, max: 75 } },
        { id: 'mqtt-sp', name: 'tempSP', unit: '℃', min: 0, max: 100, decimals: 1,
          strategy: { kind: 'manual', value: 60 } },
      ],
      config: {
        brokerUrl: 'mqtt://127.0.0.1:18830',
        topics: [
          { topic: 'aw/sim/temp', signalId: 'mqtt-temp', payloadTemplate: '{"data":{"temp":${value}}}', qos: 0 },
        ],
        commandTopic: 'aw/sim/setpoint',
        commandSignalId: 'mqtt-sp' as never,
      },
    },
    {
      id: genId('dev'),
      name: 'HTTP流量计',
      protocol: 'http',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'flow', name: '流量', unit: 'L/min', min: 0, max: 100, decimals: 2,
          strategy: { kind: 'sine', base: 42.5, amp: 0.5, periodMs: 10000 } },
      ],
      config: {
        paths: [
          { path: '/api/value', signalId: 'flow', responseTemplate: '{"data":{"value":${value}}}' },
        ],
      },
    },
  ] as DeviceNode[]
}
