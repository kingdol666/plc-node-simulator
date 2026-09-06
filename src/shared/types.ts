/**
 * PLC 节点模拟器 —— 共享类型定义(前后端单一事实源)。
 *
 * 与 AgentWorkShop 互通的约定:
 *   - 寄存器映射 dataType/byteOrder 与主项目 daq/drivers.ts decodeRegisters 同一约定
 *     (big=ABCD 标准大端 / little=DCBA 全小端 / wordSwap=CDAB 字交换);
 *   - 读偏移 = 地址 − 40001(保持)/− 30001(输入);
 *   - MQTT payload 模板与主项目 jsonPath 提取兼容(纯数字或 JSON 占位符)。
 */

export type ProtocolKind = 'modbus-tcp' | 'modbus-rtu' | 'opcua' | 'mqtt' | 'http'

/** 信号生成策略(每信号独立) */
export type SignalStrategy =
  | { kind: 'constant', value: number }
  | { kind: 'sine', base: number, amp: number, periodMs: number }
  | { kind: 'random-walk', start: number, step: number, min: number, max: number }
  | { kind: 'ramp', start: number, end: number, durationMs: number, loop: boolean }
  | { kind: 'first-order', initial: number, tauMs: number, sp: number, noise: number }
  | { kind: 'expression', expr: string }
  | { kind: 'manual', value: number }

/** 故障注入(可叠加) */
export interface FaultInjection {
  /** 卡值:激活后输出冻结在当前值 */
  stuckAt?: boolean
  /** 尖峰:概率触发,持续 ms,越限量程比例 */
  spike?: { probability: number, durationMs: number, overshoot: number }
  /** 漂移:每 tick 累加 */
  drift?: { perTick: number }
  /** 断链:协议端点拒绝/断开连接,按概率触发持续 durationMs 后自愈 */
  disconnect?: { probability?: number, durationMs: number }
}

/** 信号定义(虚拟设备的物理量) */
export interface SignalDef {
  id: string
  name: string
  unit?: string
  min?: number
  max?: number
  decimals?: number
  /** 采样/更新节拍(ms);0 = 跟随设备全局 tickMs */
  tickMs?: number
  strategy: SignalStrategy
  /** 标定:输出 = value × scale + offset(与主项目 DataTransform 同约定) */
  scale?: number
  offset?: number
  faults?: FaultInjection
  /** 运行时状态(不持久化) */
  runtime?: SignalRuntime
}

export interface SignalRuntime {
  value: number
  /** random-walk/ramp/first-order 内部游标 */
  cursor?: number
  /** 上次 tick 时间戳 */
  lastTick?: number
  spikeUntil?: number
  disconnectUntil?: number
  /** 环形历史(前端趋势) */
  hist?: number[]
}

/** 寄存器映射(Modbus):信号值 ↔ 协议地址 */
export interface RegisterMap {
  /** 协议地址,4xxxx(保持)或 3xxxx(输入) */
  address: number
  area: 'holding' | 'input'
  signalId: string
  dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32'
  byteOrder: 'big' | 'little' | 'wordSwap'
  /**
   * 写回灌联动目标(SP→PV 闭环):外部写本地址时,除更新本信号外,
   * 同步把目标信号的 first-order.sp 设为写入值(真实 PLC:SP 寄存器即控制目标)。
   */
  writebackTarget?: string
}

/** OPC UA 变量映射 */
export interface OpcUaVarMap {
  /** NodeId 如 ns=2;s=Channel1.Tag1(相对设备命名空间时可只给 name) */
  nodeId: string
  signalId: string
  dataType: 'Double' | 'Float' | 'Int16' | 'UInt16' | 'Int32' | 'UInt32' | 'Boolean'
  /** 可写 setpoint(供 DCW session.write 写入,写入值回灌信号) */
  writable?: boolean
}

/** MQTT 发布映射 */
export interface MqttTopicMap {
  topic: string
  signalId: string
  /** payload 模板:'${value}' 纯数字,或 JSON 如 '{"data":{"temp":${value}}}' */
  payloadTemplate?: string
  qos?: 0 | 1 | 2
  retain?: boolean
}

/** HTTP 端点映射 */
export interface HttpPathMap {
  path: string
  signalId: string
  /** 响应模板:'${value}' 纯数字文本,或 JSON 如 '{"value":${value}}' */
  responseTemplate?: string
}

/** 虚拟设备节点 */
export interface DeviceNode {
  id: string
  name: string
  protocol: ProtocolKind
  enabled: boolean
  /** 设备全局节拍(ms):信号默认 tick */
  tickMs: number
  signals: SignalDef[]
  /** 协议配置(按 protocol 解释) */
  config: {
    /** modbus:监听参数 */
    host?: string
    port?: number
    unitId?: number
    registerMaps?: RegisterMap[]
    /** opcua */
    endpointPath?: string
    namespaceUri?: string
    opcVars?: OpcUaVarMap[]
    securityMode?: 'None' | 'Sign' | 'SignAndEncrypt'
    username?: string
    password?: string
    /** mqtt:主动发布 */
    brokerUrl?: string
    topics?: MqttTopicMap[]
    commandTopic?: string
    /** http:GET 端点(挂在模拟器 UI 同端口) */
    paths?: HttpPathMap[]
  }
  /** 运行时状态(不持久化) */
  runtime?: {
    startedAt?: number
    lastError?: string
    /** mqtt 独立发布游标 */
  }
}

export interface SimConfig {
  nodes: DeviceNode[]
}

/** WS 帧 */
export interface SimWsFrame {
  type: 'signal.update' | 'device.changed' | 'device.error'
  payload: Record<string, unknown>
}
