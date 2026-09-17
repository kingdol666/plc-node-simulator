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
import { BIAX_NOMINAL } from './engine/biax-model'

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
  if (key !== 'film-line' && key !== 'cast-film-physics' && key !== 'biax-line') throw new Error(`未知预设: ${key}`)
  let nodes: DeviceNode[]
  if (key === 'film-line') {
    nodes = filmLinePreset()
    await replaceAll(nodes)
    stopPlantModel()
    getConfig().plantModel = undefined
    saveConfig()
  }
  else {
    const { nodes: n, plantModel } = key === 'cast-film-physics' ? castFilmParts() : biaxParts()
    nodes = n
    await replaceAll(nodes)
    getConfig().plantModel = plantModel
    saveConfig()
    startPlantModel()
  }
  for (const n of nodes) {
    if (n.enabled) await boot(n)
  }
  return nodes
}

export function presetList(): Array<{ key: string, name: string }> {
  return [
    { key: 'film-line', name: '薄膜双拉产线(全协议,对齐主项目 DAQ 模板语义;独立信号策略)' },
    { key: 'cast-film-physics', name: '挤出流延薄膜数字孪生(plant-model 物理引擎:6 DCW + 7 DAQ 五协议,工况可闭环)' },
    { key: 'biax-line', name: '双拉薄膜产线数字孪生(BOPET 全线:干燥→挤出→铸片→MDO→TDO→测厚→电晕→收卷,30 DCW + 19 DAQ 五协议,目标驱动闭环寻优)' },
  ]
}

/** 预设蓝图(dry-run,不动现场):供「探测→补建」式建线消费(如 bench 的 ensure 逻辑) */
export function presetBlueprint(key: string): { nodes: DeviceNode[], plantModel: PlantModelConfig | null } | null {
  if (key === 'film-line') return { nodes: filmLinePreset(), plantModel: null }
  if (key === 'cast-film-physics') { const p = castFilmParts(); return { nodes: p.nodes, plantModel: p.plantModel } }
  if (key === 'biax-line') { const p = biaxParts(); return { nodes: p.nodes, plantModel: p.plantModel } }
  return null
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
export function castFilmParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
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
  return { nodes, plantModel }
}

/**
 * 双向拉伸薄膜产线(biax-line,BOPET 类全线数字孪生)。
 * 物料链:干燥上料(OPC UA)→ 挤出铸片(Modbus TCP ×2 + 计量泵 RTU)→
 *   纵拉 MDO(Modbus TCP)→ 横拉 TDO 烘箱(OPC UA)→ 在线测厚(MQTT)→
 *   电晕/表面检测(HTTP)→ 收卷(Modbus TCP)。
 * 控制面 30 DCW(全线工艺 SP,含单位/量程/工艺语义描述) + 采集面 19 DAQ(物理量)。
 * 起始工况 BIAX_NOMINAL:成品厚度 ≈27.5 μm 偏厚(规格 25.0±0.8),待闭环寻优。
 */
export function biaxParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const SP = BIAX_NOMINAL
  const plantModel: PlantModelConfig = {
    kind: 'biax',
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0.1 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>, // 下方节点定义后回填
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }

  const dryer: DeviceNode = {
    id: 'biax-dryer-opcua',
    name: '原料干燥上料单元(OPC UA)',
    description: 'PET 切片预结晶/干燥塔与失重喂料。上游第一段:残水与特性粘度控制决定熔体质量上限。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'dry-temp-sp', name: '干燥温度SP', description: '干燥塔热风温度设定。PET 预结晶/干燥入口,建议 165~180℃;过低→残水升高(水解除醛劣化),过高→切片结块架桥', unit: '℃', min: 120, max: 200, decimals: 1, strategy: { kind: 'manual', value: SP.dryTemp } },
      { id: 'dew-point-sp', name: '露点SP', description: '干燥空气露点设定(分子筛/冷冻式)。光学级 PET 要求 ≤−40℃;露点升高直接推高切片残水', unit: '℃', min: -80, max: -20, decimals: 0, strategy: { kind: 'manual', value: SP.dewPoint } },
      { id: 'feed-rate-sp', name: '喂料速率SP', description: '失重式喂料设定(kg/h),计量泵的上游供给;低于挤出耗量会引发进料不足与熔压波动', unit: 'kg/h', min: 100, max: 1200, decimals: 0, strategy: { kind: 'manual', value: SP.feedRate } },
      { id: 'dry-temp-pv', name: '干燥塔温度', description: '干燥塔实测热风温度(采集)', unit: '℃', min: 20, max: 220, decimals: 1, plantBinding: 'dryTemp', strategy: { kind: 'constant', value: 25 } },
      { id: 'moisture-pv', name: '切片残水', description: '出口切片残余水分(ppm,采集);>30 ppm 进入水解除醛劣化区,缺陷与雾度上升', unit: 'ppm', min: 0, max: 120, decimals: 1, plantBinding: 'moisture', strategy: { kind: 'constant', value: 5 } },
    ],
    config: {
      host: '127.0.0.1', port: 5841, namespaceUri: 'PLC-Simulator-Biax-Dryer',
      opcVars: [
        { nodeId: 'ns=2;s=Biax.Dry.Temp.Sp', signalId: 'dry-temp-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Dew.Sp', signalId: 'dew-point-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Feed.Sp', signalId: 'feed-rate-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Temp.PV', signalId: 'dry-temp-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Dry.Moist.PV', signalId: 'moisture-pv', dataType: 'Double' },
      ],
    },
  }

  const extruder: DeviceNode = {
    id: 'biax-extruder-mbtcp',
    name: '挤出主机PLC(Modbus TCP)',
    description: 'PET 单螺杆挤出机:机筒五区加热 + 螺杆驱动。塑化段,决定熔体温度与均匀性。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'zone1-sp', name: '机筒温度区1SP', description: '机筒进料段温度(水冷进料口防架桥),五区最低的一区', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone1 } },
      { id: 'zone2-sp', name: '机筒温度区2SP', description: '机筒压缩段温度,物料开始熔融', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone2 } },
      { id: 'zone3-sp', name: '机筒温度区3SP', description: '机筒熔融段中段温度', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone3 } },
      { id: 'zone4-sp', name: '机筒温度区4SP', description: '机筒计量段温度,塑化均化', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone4 } },
      { id: 'zone5-sp', name: '机筒温度区5SP', description: '机筒出口段温度,紧邻过滤器;与熔体温度强相关(建议 285~295℃)', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone5 } },
      { id: 'screw-sp', name: '螺杆转速SP', description: '主螺杆转速(rpm)。维持供料压力;剪切热叠加进熔体温度(约 +0.09℃/rpm)', unit: 'rpm', min: 20, max: 100, decimals: 0, strategy: { kind: 'manual', value: SP.screw } },
      { id: 'melt-temp', name: '熔体温度', description: '模前熔体实测温度(采集);PET 工艺窗 268~300℃,超窗即联锁', unit: '℃', min: 200, max: 330, decimals: 1, plantBinding: 'meltTemp', strategy: { kind: 'constant', value: 280 } },
      { id: 'melt-pressure', name: '泵前熔压', description: '过滤器前熔体压力(采集);反映过滤网堵塞与熔体粘度变化', unit: 'MPa', min: 0, max: 35, decimals: 2, plantBinding: 'meltPressure', strategy: { kind: 'constant', value: 12 } },
    ],
    config: {
      host: '0.0.0.0', port: 16042, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'melt-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'melt-pressure', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'zone1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'zone2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'zone3-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'zone4-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40029, area: 'holding', signalId: 'zone5-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40031, area: 'holding', signalId: 'screw-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const pump: DeviceNode = {
    id: 'biax-pump-rtu',
    name: '熔体计量泵站(Modbus RTU)',
    description: '熔体齿轮泵 + 换网过滤器撬块。挤出流量的权威控制量,比螺杆转速更平稳。',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'pump-sp', name: '计量泵转速SP', description: '齿轮泵转速(rpm)——挤出流量的第一控制量;与铸片厚度成正比、与线速度/拉比共同决定成品厚度', unit: 'rpm', min: 15, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.pump } },
      { id: 'pump-outlet', name: '泵出口压力', description: '齿轮泵出口压力(采集);>32 MPa 触发联锁(模头/过滤堵塞风险)', unit: 'MPa', min: 0, max: 35, decimals: 2, plantBinding: 'pumpOutlet', strategy: { kind: 'constant', value: 17 } },
    ],
    config: {
      host: '0.0.0.0', port: 15042, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'pump-outlet', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'pump-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const casting: DeviceNode = {
    id: 'biax-casting-mbtcp',
    name: '模头铸片单元(Modbus TCP)',
    description: 'T 模头 + 静电毛贴 + 急冷辊(casting drum)。铸片厚度与横向分布在这里定型。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'die-lip-sp', name: '模唇温度SP', description: 'T 模头模唇加热区温度;经热膨胀微调横向厚度分布(人工/自动螺栓的替身),偏离 285℃ 过大会加剧轮廓凹凸', unit: '℃', min: 250, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.dieLip } },
      { id: 'chill-temp-sp', name: '急冷辊温度SP', description: '铸片冷辊冷冻水温度;PET 常用 20~35℃;过高→铸片结晶发脆、雾度升高', unit: '℃', min: 10, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.chillTemp } },
      { id: 'cast-spd-sp', name: '铸片辊速度SP', description: '铸片线速度(m/min)——铸片厚度第一控制量(厚度 ∝ 1/速度);须与 MDO/TDO 拉速保持级配', unit: 'm/min', min: 10, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.castSpd } },
      { id: 'pinning-sp', name: '静电吸附电压SP', description: '静电毛贴(针电极)电压 kV,把熔膜贴牢冷辊防抖动;<5 kV 边缘贴附不良→横向厚度 σ 恶化', unit: 'kV', min: 4, max: 12, decimals: 1, strategy: { kind: 'manual', value: SP.pinning } },
      { id: 'cast-temp-pv', name: '铸片辊面温度', description: '冷辊出口膜面温度(采集)', unit: '℃', min: 0, max: 80, decimals: 1, plantBinding: 'castTemp', strategy: { kind: 'constant', value: 30 } },
    ],
    config: {
      host: '0.0.0.0', port: 16044, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'cast-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'die-lip-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'chill-temp-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'cast-spd-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'pinning-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const mdo: DeviceNode = {
    id: 'biax-mdo-mbtcp',
    name: '纵向拉伸MDO单元(Modbus TCP)',
    description: '纵拉机:预热辊组 ×3 + 慢/快辊拉伸对 + 退火辊。纵向分子取向在此发生。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'mdo-preheat1-sp', name: '预热辊1温度SP', description: 'MDO 预热辊组第 1 辊(入口);三辊递升把膜温带入高弹态', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat1 } },
      { id: 'mdo-preheat2-sp', name: '预热辊2温度SP', description: 'MDO 预热辊组第 2 辊(中段)', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat2 } },
      { id: 'mdo-preheat3-sp', name: '预热辊3温度SP', description: 'MDO 预热辊组第 3 辊(拉伸前);膜温应到达 86~110℃ 拉伸窗', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat3 } },
      { id: 'slow-roll-sp', name: '慢辊线速度SP', description: '纵拉拉伸区入口(慢辊)速度;快/慢辊速比即纵向拉伸比 R_md=快/慢', unit: 'm/min', min: 10, max: 80, decimals: 1, strategy: { kind: 'manual', value: SP.slowRoll } },
      { id: 'fast-roll-sp', name: '快辊线速度SP', description: '纵拉出口(快辊)速度;提高快辊→拉伸比增大→厚度按比例减薄(PET 常用 R_md 2.5~3.3)', unit: 'm/min', min: 30, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.fastRoll } },
      { id: 'mdo-anneal-sp', name: '纵拉退火辊SP', description: '纵拉后定型辊温;缓释纵向内应力,影响热收缩与横向分布', unit: '℃', min: 90, max: 170, decimals: 1, strategy: { kind: 'manual', value: SP.mdoAnneal } },
      { id: 'mdo-film-temp', name: '纵拉膜温', description: '纵拉区薄膜实测温度(采集);拉伸窗 86~110℃(≈Tg+8~Tg+32),低于窗口→颈缩/破膜', unit: '℃', min: 40, max: 160, decimals: 1, plantBinding: 'mdoTemp', strategy: { kind: 'constant', value: 100 } },
      { id: 'mdo-ratio-pv', name: '纵拉实际拉伸比', description: '快/慢辊实测速比(采集)', unit: '', min: 1, max: 5, decimals: 2, plantBinding: 'mdRatio', strategy: { kind: 'constant', value: 2.8 } },
    ],
    config: {
      host: '0.0.0.0', port: 16046, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'mdo-film-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'mdo-ratio-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'mdo-preheat1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'mdo-preheat2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'mdo-preheat3-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'slow-roll-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40029, area: 'holding', signalId: 'fast-roll-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40031, area: 'holding', signalId: 'mdo-anneal-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const tdo: DeviceNode = {
    id: 'biax-tdo-opcua',
    name: '横向拉伸TDO烘箱(OPC UA)',
    description: '拉幅机(tenter):预热/拉伸/定型三段烘箱 + 链夹 + 轨道展幅。横向取向与结晶定型在此完成。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'tdo-preheat-sp', name: 'TDO预热段SP', description: '横拉烘箱预热段温度;把纵拉膜重新升温至拉伸准备态', unit: '℃', min: 80, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.tdoPreheat } },
      { id: 'tdo-stretch-sp', name: 'TDO拉伸段SP', description: '横拉拉伸段温度;窗口 98~128℃——过低→破膜掉边,过高→不均匀减薄', unit: '℃', min: 90, max: 150, decimals: 1, strategy: { kind: 'manual', value: SP.tdoStretch } },
      { id: 'tdo-anneal-sp', name: 'TDO定型段SP', description: '横拉定型/退火段温度;PET 结晶定型 200~235℃;过低→雾度与热收缩劣化,过高→松弛减薄', unit: '℃', min: 180, max: 250, decimals: 1, strategy: { kind: 'manual', value: SP.tdoAnneal } },
      { id: 'chain-sp', name: '链夹速度SP', description: '拉幅机链夹线速度 = 产线主速度(m/min);决定烤箱驻留时间与产能', unit: 'm/min', min: 40, max: 260, decimals: 0, strategy: { kind: 'manual', value: SP.chain } },
      { id: 'rail-out-sp', name: '出口轨宽SP', description: '横拉出口轨道宽度(mm);入口宽≈铸片宽,出口/入口即横向拉伸比 R_td;增大轨宽→厚度按比例减薄(BOPET 常用 R_td 3.0~3.6)', unit: 'mm', min: 1800, max: 4200, decimals: 0, strategy: { kind: 'manual', value: SP.railOut } },
      { id: 'tdo-temp-pv', name: '烘箱膜温', description: 'TDO 出口膜温(采集,三段加权)', unit: '℃', min: 60, max: 260, decimals: 1, plantBinding: 'tdoTemp', strategy: { kind: 'constant', value: 160 } },
      { id: 'td-ratio-pv', name: '横拉实际拉伸比', description: '出口/入口轨宽实测比(采集)', unit: '', min: 1, max: 5.5, decimals: 2, plantBinding: 'tdRatio', strategy: { kind: 'constant', value: 3.2 } },
      { id: 'rail-width-pv', name: '轨道实测宽度', description: '出口轨道实测宽度(采集)', unit: 'mm', min: 1500, max: 4500, decimals: 0, plantBinding: 'railWidth', strategy: { kind: 'constant', value: 3000 } },
    ],
    config: {
      host: '127.0.0.1', port: 5842, namespaceUri: 'PLC-Simulator-Biax-Tdo',
      opcVars: [
        { nodeId: 'ns=2;s=Biax.Tdo.Pre.Sp', signalId: 'tdo-preheat-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Str.Sp', signalId: 'tdo-stretch-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Ann.Sp', signalId: 'tdo-anneal-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Chain.Sp', signalId: 'chain-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Rail.Sp', signalId: 'rail-out-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.T.PV', signalId: 'tdo-temp-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Tdo.Ratio.PV', signalId: 'td-ratio-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Tdo.Rail.PV', signalId: 'rail-width-pv', dataType: 'Double' },
      ],
    },
  }

  const gauge: DeviceNode = {
    id: 'biax-gauge-mqtt',
    name: '在线测厚仪(MQTT)',
    description: 'TDO 出口透射式测厚仪(扫描架):全线平均厚度与横向 σ 的质量关。',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'biax-thickness', name: 'biaxThick', description: '成品全线平均厚度(采集);当前规格 25.0±0.8 μm——闭环寻优的被控量', unit: 'μm', min: 0, max: 80, decimals: 2, plantBinding: 'thickness', strategy: { kind: 'constant', value: 25 } },
      { id: 'thickness-sigma', name: 'biaxSigma', description: '横向厚度标准差(采集);光学级要求 σ/均值 ≤1.2%', unit: 'μm', min: 0, max: 10, decimals: 3, plantBinding: 'sigma', strategy: { kind: 'constant', value: 0.25 } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:18830',
      topics: [
        { topic: 'aw/biax/thick', signalId: 'biax-thickness', payloadTemplate: '{"data":{"thick":${value}}}', qos: 0 },
        { topic: 'aw/biax/sigma', signalId: 'thickness-sigma', payloadTemplate: '{"data":{"sigma":${value}}}', qos: 0 },
      ],
    } as never,
  }

  const inspect: DeviceNode = {
    id: 'biax-inspect-http',
    name: '电晕处理与表面检测站(HTTP)',
    description: '电晕处理机 + 在线表面检测(轮廓/缺陷/雾度/达因)。后处理质量段。',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'corona-sp', name: 'coronaPower', description: '电晕处理功率(kW);决定表面张力——印刷/镀铝要求 ≥38~42 dyn/cm', unit: 'kW', min: 0.5, max: 8, decimals: 1, strategy: { kind: 'manual', value: SP.corona } },
      { id: 'biax-profile', name: 'biaxProfile', description: '横向厚度轮廓 64 点向量帧(采集)', unit: 'μm', min: 0, max: 80, decimals: 3, format: 'vector', plantBinding: 'profile', strategy: { kind: 'constant', value: 25 } },
      { id: 'biax-defect', name: 'biaxDefect', description: '表面缺陷率(采集,%)——破膜/颈缩/皱折/晶点的综合表现;规格 ≤1.0%', unit: '%', min: 0, max: 10, decimals: 3, plantBinding: 'defect', strategy: { kind: 'constant', value: 0.2 } },
      { id: 'biax-haze', name: 'biaxHaze', description: '雾度(采集,%);定型段温度不足或残水超标会推高', unit: '%', min: 0, max: 10, decimals: 2, plantBinding: 'haze', strategy: { kind: 'constant', value: 0.6 } },
      { id: 'dyne-level', name: 'biaxDyne', description: '表面达因值(采集,dyn/cm);电晕功率的对数映射', unit: 'dyn/cm', min: 30, max: 60, decimals: 0, plantBinding: 'dyne', strategy: { kind: 'constant', value: 42 } },
    ],
    config: {
      paths: [
        { path: '/api/control/corona', signalId: 'corona-sp', writable: true },
        { path: '/api/profile', signalId: 'biax-profile', responseTemplate: '{"points":${points},"value":${value}}' },
        { path: '/api/defect', signalId: 'biax-defect', responseTemplate: '{"value":${value}}' },
        { path: '/api/haze', signalId: 'biax-haze', responseTemplate: '{"value":${value}}' },
        { path: '/api/dyne', signalId: 'dyne-level', responseTemplate: '{"value":${value}}' },
      ],
    },
  }

  const winder: DeviceNode = {
    id: 'biax-winder-mbtcp',
    name: '收卷单元(Modbus TCP)',
    description: '中心卷取式收卷机:张力锥度控制 + 接触辊 + 卷径测量。产线末段。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'winder-tension-sp', name: '收卷张力SP', description: '收卷张力设定(N,锥度基准);过高→拉伸/勒痕,过低→松卷窜动;工作窗 55~120 N', unit: 'N', min: 30, max: 180, decimals: 1, strategy: { kind: 'manual', value: SP.windTension } },
      { id: 'taper-sp', name: '张力锥度SP', description: '锥度系数(%):随卷径增大张力线性衰减,防外卷勒伤', unit: '%', min: 10, max: 60, decimals: 0, strategy: { kind: 'manual', value: SP.windTaper } },
      { id: 'contact-press-sp', name: '接触辊压力SP', description: '收卷接触辊压紧力(bar);<0.9 易夹气起皱', unit: 'bar', min: 0.3, max: 4, decimals: 2, strategy: { kind: 'manual', value: SP.windContact } },
      { id: 'winder-speed-sp', name: '卷取速度上限SP', description: '卷取速度上限(m/min,张力舞辊随动);与链夹速度联锁', unit: 'm/min', min: 60, max: 320, decimals: 0, strategy: { kind: 'manual', value: SP.windSpeed } },
      { id: 'winder-tension-pv', name: '实际收卷张力', description: '张力传感器实测(采集)', unit: 'N', min: 0, max: 220, decimals: 1, plantBinding: 'tension', strategy: { kind: 'constant', value: 88 } },
      { id: 'roll-diameter', name: '卷径', description: '当前卷径(超声测距,采集);锥度张力与换卷逻辑的输入', unit: 'm', min: 0.05, max: 1.5, decimals: 3, plantBinding: 'rollDia', strategy: { kind: 'constant', value: 0.15 } },
    ],
    config: {
      host: '0.0.0.0', port: 16048, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'winder-tension-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'roll-diameter', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'winder-tension-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'taper-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'contact-press-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'winder-speed-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const nodes = [dryer, extruder, pump, casting, mdo, tdo, gauge, inspect, winder]
  plantModel.controls = {
    dryTemp: { nodeId: dryer.id, signalId: 'dry-temp-sp' },
    dewPoint: { nodeId: dryer.id, signalId: 'dew-point-sp' },
    feedRate: { nodeId: dryer.id, signalId: 'feed-rate-sp' },
    zone1: { nodeId: extruder.id, signalId: 'zone1-sp' },
    zone2: { nodeId: extruder.id, signalId: 'zone2-sp' },
    zone3: { nodeId: extruder.id, signalId: 'zone3-sp' },
    zone4: { nodeId: extruder.id, signalId: 'zone4-sp' },
    zone5: { nodeId: extruder.id, signalId: 'zone5-sp' },
    screw: { nodeId: extruder.id, signalId: 'screw-sp' },
    pump: { nodeId: pump.id, signalId: 'pump-sp' },
    dieLip: { nodeId: casting.id, signalId: 'die-lip-sp' },
    chillTemp: { nodeId: casting.id, signalId: 'chill-temp-sp' },
    castSpd: { nodeId: casting.id, signalId: 'cast-spd-sp' },
    pinning: { nodeId: casting.id, signalId: 'pinning-sp' },
    mdoPreheat1: { nodeId: mdo.id, signalId: 'mdo-preheat1-sp' },
    mdoPreheat2: { nodeId: mdo.id, signalId: 'mdo-preheat2-sp' },
    mdoPreheat3: { nodeId: mdo.id, signalId: 'mdo-preheat3-sp' },
    slowRoll: { nodeId: mdo.id, signalId: 'slow-roll-sp' },
    fastRoll: { nodeId: mdo.id, signalId: 'fast-roll-sp' },
    mdoAnneal: { nodeId: mdo.id, signalId: 'mdo-anneal-sp' },
    tdoPreheat: { nodeId: tdo.id, signalId: 'tdo-preheat-sp' },
    tdoStretch: { nodeId: tdo.id, signalId: 'tdo-stretch-sp' },
    tdoAnneal: { nodeId: tdo.id, signalId: 'tdo-anneal-sp' },
    chain: { nodeId: tdo.id, signalId: 'chain-sp' },
    railOut: { nodeId: tdo.id, signalId: 'rail-out-sp' },
    corona: { nodeId: inspect.id, signalId: 'corona-sp' },
    windTension: { nodeId: winder.id, signalId: 'winder-tension-sp' },
    windTaper: { nodeId: winder.id, signalId: 'taper-sp' },
    windContact: { nodeId: winder.id, signalId: 'contact-press-sp' },
    windSpeed: { nodeId: winder.id, signalId: 'winder-speed-sp' },
  }
  plantModel.outputs = {
    dryTemp: { nodeId: dryer.id, signalId: 'dry-temp-pv' },
    moisture: { nodeId: dryer.id, signalId: 'moisture-pv' },
    meltTemp: { nodeId: extruder.id, signalId: 'melt-temp' },
    meltPressure: { nodeId: extruder.id, signalId: 'melt-pressure' },
    pumpOutlet: { nodeId: pump.id, signalId: 'pump-outlet' },
    castTemp: { nodeId: casting.id, signalId: 'cast-temp-pv' },
    mdoTemp: { nodeId: mdo.id, signalId: 'mdo-film-temp' },
    mdRatio: { nodeId: mdo.id, signalId: 'mdo-ratio-pv' },
    tdoTemp: { nodeId: tdo.id, signalId: 'tdo-temp-pv' },
    tdRatio: { nodeId: tdo.id, signalId: 'td-ratio-pv' },
    railWidth: { nodeId: tdo.id, signalId: 'rail-width-pv' },
    thickness: { nodeId: gauge.id, signalId: 'biax-thickness' },
    sigma: { nodeId: gauge.id, signalId: 'thickness-sigma' },
    profile: { nodeId: inspect.id, signalId: 'biax-profile' },
    defect: { nodeId: inspect.id, signalId: 'biax-defect' },
    haze: { nodeId: inspect.id, signalId: 'biax-haze' },
    dyne: { nodeId: inspect.id, signalId: 'dyne-level' },
    tension: { nodeId: winder.id, signalId: 'winder-tension-pv' },
    rollDia: { nodeId: winder.id, signalId: 'roll-diameter' },
  }
  return { nodes, plantModel }
}

export function filmLinePreset(): DeviceNode[] {
  return [
    {
      id: genId('dev'),
      name: 'Coating Oven PLC',
      protocol: 'modbus-tcp',
      enabled: true,
      tickMs: 800,
      signals: [
        { id: 'temp-pv', name: 'Temp PV', unit: '℃', min: 0, max: 260, decimals: 1, tickMs: 800,
          strategy: { kind: 'first-order', initial: 24, tauMs: 8000, sp: 180, noise: 0.25 } },
        { id: 'temp-sp', name: 'Temp SP', unit: '℃', min: 0, max: 260, decimals: 1,
          strategy: { kind: 'manual', value: 180 } },
        { id: 'pressure', name: 'Pressure PV', unit: 'MPa', min: 0, max: 2, decimals: 3,
          strategy: { kind: 'sine', base: 0.85, amp: 0.12, periodMs: 30000 } },
        { id: 'tension', name: 'Tension PV', unit: 'N', min: 0, max: 200, decimals: 1,
          strategy: { kind: 'random-walk', start: 120, step: 1.5, min: 80, max: 160 } },
        { id: 'speed', name: 'Speed PV', unit: 'm/min', min: 0, max: 300, decimals: 1,
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
      name: 'Remote RTU Temp Slave',
      protocol: 'modbus-rtu',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'rtu-temp', name: 'Furnace Temp', unit: '℃', min: 0, max: 100, decimals: 1,
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
      name: 'OPC UA Temp Controller',
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
      name: 'MQTT Temp Sensor',
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
      name: 'HTTP Flow Meter',
      protocol: 'http',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'flow', name: 'Flow', unit: 'L/min', min: 0, max: 100, decimals: 2,
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
