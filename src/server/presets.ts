/**
 * 场景预设 —— 一键生成对齐 AgentWorkShop DAQ 模板语义的完整模拟产线。
 * film-line:五协议各一设备,信号域与主项目全协议矩阵 e2e 的期望域一致,
 * 主项目建节点即可一一对应(温度 30-75/165-185、压力 0.5-1.25、张力、流量 38-48)。
 * cast-film-physics:挤出流延薄膜数字孪生产线 —— 全部 DAQ 值由 plant-model
 * 物理状态方程积分产出,6 DCW + 7 DAQ 跨五协议,含向量/图像检测帧。
 */
import type { DeviceNode, PlantBinding, PlantModelConfig } from '../shared/types'
import { getConfig, saveConfig, genId } from './store'
import { stopNode } from './runtime'
import { stopProtocol } from './protocols/registry'
import { startPlantModel, stopPlantModel } from './engine/plant-runtime'

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
  if (key !== 'film-line' && key !== 'cast-film-physics') throw new Error(`未知预设: ${key}`)
  const nodes = key === 'film-line' ? filmLinePreset() : castFilmPreset()
  await replaceAll(nodes)
  if (key === 'cast-film-physics') startPlantModel()
  else { stopPlantModel(); getConfig().plantModel = undefined; saveConfig() }
  for (const n of nodes) {
    if (n.enabled) await boot(n)
  }
  return nodes
}

export function presetList(): Array<{ key: string, name: string }> {
  return [
    { key: 'film-line', name: '薄膜双拉产线(全协议,对齐主项目 DAQ 模板语义;独立信号策略)' },
    { key: 'cast-film-physics', name: '挤出流延薄膜数字孪生(plant-model 物理引擎:6 DCW + 7 DAQ 五协议,工况可闭环)' },
  ]
}

/**
 * 挤出流延薄膜产线(cast-film-physics)。
 * 控制面(6 DCW,次优起点:zone=200℃,N=150rpm,v=95m/min → h≈53.8μm 偏厚,待 Agent 闭环寻优):
 *   zone1/2/3-sp  Modbus TCP 40021/23/25 (120~260℃)
 *   screw-sp      OPC UA ns=2;s=AW.N.Sp 可写 (50~200rpm)
 *   lineSpeed-sp  MQTT 命令主题 aw/sim/lineSp/set (20~120m/min)
 *   dieGap-sp     HTTP POST /api/control/diegap (0.5~2.0mm)
 * 采集面(7 DAQ,全部 plantBinding → 物理模型覆写):
 *   meltTemp(40001 MBTCP) meltPressure(OPC UA) filmThickness(MQTT)
 *   profile(HTTP vector) defectImage(HTTP PNG) defectRate(HTTP) gels(MBTCP-RTU 40001)
 */
export function castFilmPreset(): DeviceNode[] {
  const plantModel: PlantModelConfig = {
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0.15 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>, // 下方节点创建后回填
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }
  // 起始控制点(次优,待闭环寻优)
  const SP = { zone: 200, screw: 150, lineSpeed: 95, dieGap: 1.0 }

  const extruder: DeviceNode = {
    id: 'dev-extruder-mbtcp',
    name: '挤出主机PLC(Modbus TCP)',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'zone1-sp', name: '加热区1SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'zone2-sp', name: '加热区2SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'zone3-sp', name: '加热区3SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'melt-temp', name: '熔体温度', unit: '℃', min: 0, max: 400, decimals: 2, plantBinding: 'meltTemp', strategy: { kind: 'constant', value: 25 } },
    ],
    config: {
      host: '0.0.0.0', port: 16040, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'melt-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'zone1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'zone2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'zone3-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const rtuGels: DeviceNode = {
    id: 'dev-gels-rtu',
    name: '晶点计数从站(Modbus RTU)',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'gels-count', name: '晶点计数', unit: '个/m²', min: 0, max: 500, decimals: 0, plantBinding: 'gels', strategy: { kind: 'constant', value: 4 } },
    ],
    config: {
      host: '0.0.0.0', port: 15041, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'gels-count', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const opcua: DeviceNode = {
    id: 'dev-extruder-opcua',
    name: '熔体泵送单元(OPC UA)',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'melt-pressure', name: 'MeltPressure', unit: 'MPa', min: 0, max: 45, decimals: 3, plantBinding: 'meltPressure', strategy: { kind: 'constant', value: 0.5 } },
      { id: 'screw-sp', name: 'ScrewSpeedSP', unit: 'rpm', min: 50, max: 200, decimals: 0, strategy: { kind: 'manual', value: SP.screw } },
    ],
    config: {
      host: '127.0.0.1', port: 5840, namespaceUri: 'PLC-Simulator',
      opcVars: [
        { nodeId: 'ns=2;s=AW.P', signalId: 'melt-pressure', dataType: 'Double' },
        { nodeId: 'ns=2;s=AW.N.Sp', signalId: 'screw-sp', dataType: 'Double', writable: true },
      ],
    },
  }

  const mqtt: DeviceNode = {
    id: 'dev-gauge-mqtt',
    name: '在线测厚仪(MQTT)',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'film-thickness', name: 'thick', unit: 'μm', min: 0, max: 400, decimals: 2, plantBinding: 'filmThickness', strategy: { kind: 'constant', value: 0 } },
      { id: 'linespeed-sp', name: 'lineSpeedSP', unit: 'm/min', min: 20, max: 120, decimals: 1, strategy: { kind: 'manual', value: SP.lineSpeed } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:18830',
      topics: [
        { topic: 'aw/sim/thick', signalId: 'film-thickness', payloadTemplate: '{"data":{"thick":${value}}}', qos: 0 },
      ],
      commandTopic: 'aw/sim/lineSp/set',
      commandSignalId: 'linespeed-sp',
    } as never,
  }

  const httpStation: DeviceNode = {
    id: 'dev-inspect-http',
    name: 'CCD检测站(HTTP)',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'thickness-profile', name: 'profile', unit: 'μm', min: 0, max: 400, decimals: 3, format: 'vector', plantBinding: 'profile', strategy: { kind: 'constant', value: 0 } },
      { id: 'ccd-image', name: 'ccd', unit: '灰度', min: 0, max: 255, format: 'image', plantBinding: 'defectImage', strategy: { kind: 'constant', value: 0 } },
      { id: 'defect-rate', name: 'defect', unit: '%', min: 0, max: 100, decimals: 3, plantBinding: 'defectRate', strategy: { kind: 'constant', value: 0 } },
      { id: 'diegap-sp', name: 'dieGapSP', unit: 'mm', min: 0.5, max: 2.0, decimals: 2, strategy: { kind: 'manual', value: SP.dieGap } },
    ],
    config: {
      paths: [
        { path: '/api/profile', signalId: 'thickness-profile', responseTemplate: '{"points":${points},"value":${value}}' },
        { path: '/api/ccd', signalId: 'ccd-image' },
        { path: '/api/defect', signalId: 'defect-rate', responseTemplate: '{"value":${value}}' },
        { path: '/api/control/diegap', signalId: 'diegap-sp', writable: true },
      ],
    },
  }

  const nodes = [extruder, rtuGels, opcua, mqtt, httpStation]
  plantModel.controls = {
    zone1: { nodeId: extruder.id, signalId: 'zone1-sp' },
    zone2: { nodeId: extruder.id, signalId: 'zone2-sp' },
    zone3: { nodeId: extruder.id, signalId: 'zone3-sp' },
    screw: { nodeId: opcua.id, signalId: 'screw-sp' },
    lineSpeed: { nodeId: mqtt.id, signalId: 'linespeed-sp' },
    dieGap: { nodeId: httpStation.id, signalId: 'diegap-sp' },
  }
  plantModel.outputs = {
    meltTemp: { nodeId: extruder.id, signalId: 'melt-temp' },
    meltPressure: { nodeId: opcua.id, signalId: 'melt-pressure' },
    filmThickness: { nodeId: mqtt.id, signalId: 'film-thickness' },
    profile: { nodeId: httpStation.id, signalId: 'thickness-profile' },
    defectImage: { nodeId: httpStation.id, signalId: 'ccd-image' },
    defectRate: { nodeId: httpStation.id, signalId: 'defect-rate' },
    gels: { nodeId: rtuGels.id, signalId: 'gels-count' },
  }
  getConfig().plantModel = plantModel
  saveConfig()
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
