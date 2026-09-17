/**
 * plant-runtime:物理模型与设备信号的绑定执行层。
 *
 * 职责:每 dtMs 一步 —— 从控制绑定信号读当前 SP(外部 DCW 写已落到信号值)→
 * CastFilmModel 积分 → 把模型输出覆写到 DAQ 绑定信号(vector/image 信号写对应形态)→
 * WS 广播 → 真值/暴露双列 JSONL 导出(ground truth 评测流)。
 * 控制/输出绑定缺失时跳过对应项(允许部分场景)。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PlantBinding, PlantModelConfig, PlantTruthSample, SignalDef } from '../../shared/types'
import { CastFilmModel, type PlantControls, type PlantStepResult } from './plant-model'
import { BiaxModel, BIAX_NOMINAL, type BiaxControls, type BiaxStepResult } from './biax-model'
import { encodeGrayPng } from './png-enc'
import { broadcast } from '../bus'
import { DATA_DIR, getConfig, saveConfig } from '../store'

let timer: NodeJS.Timeout | undefined
let model: CastFilmModel | BiaxModel | undefined
let biaxModel: BiaxModel | undefined
let truthStream: fs.WriteStream | undefined
let truthCount = 0

const TRUTH_ROTATE_LINES = 200_000

function findSignal(b: PlantBinding): { nodeId: string, nodeSignals: SignalDef[], sig: SignalDef } | undefined {
  const node = getConfig().nodes.find(n => n.id === b.nodeId)
  if (!node) return undefined
  const sig = (node.signals ?? []).find(s => s.id === b.signalId)
  if (!sig) return undefined
  return { nodeId: node.id, nodeSignals: node.signals ?? [], sig }
}

function readControl(b: PlantBinding | undefined, fallback: number): number {
  if (!b) return fallback
  const hit = findSignal(b)
  const v = hit?.sig.runtime?.value
  return Number.isFinite(v) ? v! : fallback
}

/**
 * 变更累积器:**按 nodeId 分桶**。
 *
 * 为什么必须分桶:模型输出会被写进各自**宿主设备**的信号(见 findSignal),
 * 但早先的广播把这些信号统一挂在硬编码的 nodeId 'plant-model' 下 ——
 * 而 'plant-model' 并不是一台真实设备(/api/nodes 里没有它)。
 * 后果:WS 客户端按 nodeId 找卡片永远匹配不上,物理量(melt-temp / thickness /
 * defect…)在界面上**永远显示初始快照**,看起来像"模拟器是静止的"。
 * 现场实测:UI 打开 15 秒,文本 0 个字符变化,而同时 WS 已推了 32 帧。
 */
type ChangedByNode = Map<string, Array<{ id: string, name: string, value: number, unit?: string }>>

function pushChanged(changed: ChangedByNode, nodeId: string, entry: { id: string, name: string, value: number, unit?: string }): void {
  const list = changed.get(nodeId) ?? []
  list.push(entry)
  changed.set(nodeId, list)
}

function writeScalar(hit: { nodeId: string, sig: SignalDef }, value: number, changed: ChangedByNode): void {
  const sig = hit.sig
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  const dec = sig.decimals ?? 3
  sig.runtime.value = Number(value.toFixed(dec))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  pushChanged(changed, hit.nodeId, { id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
}

function writeVector(hit: { nodeId: string, sig: SignalDef }, points: number[], changed: ChangedByNode): void {
  const sig = hit.sig
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  sig.runtime.vector = points
  const avg = points.reduce((a, b) => a + b, 0) / Math.max(points.length, 1)
  sig.runtime.value = Number(avg.toFixed(3))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  pushChanged(changed, hit.nodeId, { id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
}

/** 缺陷图像帧:96×32 灰度 —— 底纹 = 厚度轮廓横向条纹,亮点数 ∝ 缺陷率 */
function renderDefectImage(profile: number[], defect: number, model: CastFilmModel): { png: string, width: number, height: number } {
  const W = 96
  const H = 32
  const px = new Uint8Array(W * H)
  const minP = Math.min(...profile)
  const maxP = Math.max(...profile)
  const span = Math.max(maxP - minP, 1e-6)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pi = Math.min(profile.length - 1, Math.floor((x / W) * profile.length))
      const band = (profile[pi]! - minP) / span
      px[y * W + x] = Math.round(60 + band * 120)
    }
  }
  // 缺陷亮点:撒点数 ∝ 缺陷率(用模型 seeded rand,保持可复现)
  const spots = Math.min(200, Math.round(defect * 6 + 2))
  for (let i = 0; i < spots; i++) {
    const x = Math.floor(model.sampleRand() * W)
    const y = Math.floor(model.sampleRand() * H)
    px[y * W + x] = 240
  }
  const png = encodeGrayPng(px, W, H)
  return { png: png.toString('base64'), width: W, height: H }
}

function openTruthStream(cfg: PlantModelConfig): void {
  if (truthStream) { truthStream.end(); truthStream = undefined }
  const file = path.join(DATA_DIR, 'truth.jsonl')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  truthStream = fs.createWriteStream(file, { flags: 'w' })
  truthStream.write(`${JSON.stringify({
    meta: true, seed: cfg.seed, timeScale: cfg.timeScale, dtMs: cfg.dtMs,
    startedAt: new Date().toISOString(), phase: cfg.phase,
  })}\n`)
  truthCount = 0
}

function readControls(cfg: PlantModelConfig): PlantControls {
  const cb = cfg.controls
  return {
    zone1: readControl(cb?.zone1, 210),
    zone2: readControl(cb?.zone2, 210),
    zone3: readControl(cb?.zone3, 210),
    screw: readControl(cb?.screw, 120),
    lineSpeed: readControl(cb?.lineSpeed, 85),
    dieGap: readControl(cb?.dieGap, 1.0),
  }
}

/** biax 控制面:30 个 SP 从绑定信号读当前值(DCW 写已落到信号值),缺失回退标称值 */
function readBiaxControls(cfg: PlantModelConfig, nominal: BiaxControls): BiaxControls {
  const cb = cfg.controls
  const out = {} as Record<keyof BiaxControls, number>
  for (const [key, def] of Object.entries(nominal) as Array<[keyof BiaxControls, number]>) {
    out[key] = readControl((cb as Record<string, PlantBinding | undefined>)?.[key], def)
  }
  return out as BiaxControls
}

/** biax 输出面:按 cfg.outputs 键值对写绑定信号(vector 轮廓 → writeVector,标量 → writeScalar) */
function writeBiaxOutputs(cfg: PlantModelConfig, r: BiaxStepResult, changed: ChangedByNode): void {
  for (const [key, b] of Object.entries(cfg.outputs ?? {}) as Array<[string, PlantBinding]>) {
    if (!b) continue
    const hit = findSignal(b)
    if (!hit) continue
    if (hit.sig.format === 'vector') {
      if (key === 'profile') writeVector(hit, r.profile, changed)
      continue
    }
    const v = r.exposed[key]
    if (Number.isFinite(v)) writeScalar(hit, v, changed)
  }
}

function stepOnce(): void {
  const cfg = getConfig().plantModel
  if (!cfg?.enabled || !model) return
  const dtSec = (cfg.dtMs / 1000) * cfg.timeScale

  if (cfg.kind === 'biax' && biaxModel) {
    const controls = readBiaxControls(cfg, biaxNominal())
    const r = biaxModel.step(controls, dtSec, {
      heaterDecay: cfg.disturbances?.heaterDecay ?? 1,
      feedDriftPerMin: cfg.disturbances?.feedDriftPerMin ?? 0,
    })
    const changed: ChangedByNode = new Map()
    writeBiaxOutputs(cfg, r, changed)
    const at = Date.now()
    for (const [nodeId, signals] of changed) {
      broadcast({ type: 'signal.update', payload: { nodeId, signals, at } })
    }
    if (cfg.truthExport) {
      if (!truthStream) openTruthStream(cfg)
      const sample: PlantTruthSample = {
        t: new Date().toISOString(),
        phase: cfg.phase ?? 'steady',
        sp: controls as unknown as Record<string, number>,
        truth: r.truth as unknown as Record<string, unknown>,
        exposed: r.exposed,
      }
      truthStream!.write(`${JSON.stringify(sample)}\n`)
      truthCount++
      if (truthCount > TRUTH_ROTATE_LINES) openTruthStream(cfg)
    }
    return
  }

  const controls = readControls(cfg)
  const cfModel = model as CastFilmModel
  const r: PlantStepResult = cfModel.step(controls, dtSec, {
    heaterDecay: cfg.disturbances?.heaterDecay ?? 1,
    feedDriftPerMin: cfg.disturbances?.feedDriftPerMin ?? 0,
  })

  const changed: ChangedByNode = new Map()
  const out = (key: string) => cfg.outputs?.[key as keyof typeof cfg.outputs]

  const bTemp = out('meltTemp')
  if (bTemp) { const hit = findSignal(bTemp); if (hit) writeScalar(hit, r.exposed.meltTemp, changed) }
  const bP = out('meltPressure')
  if (bP) { const hit = findSignal(bP); if (hit) writeScalar(hit, r.exposed.pressure, changed) }
  const bH = out('filmThickness')
  if (bH) { const hit = findSignal(bH); if (hit) writeScalar(hit, r.exposed.thickness, changed) }
  const bD = out('defectRate')
  if (bD) { const hit = findSignal(bD); if (hit) writeScalar(hit, r.exposed.defect, changed) }
  const bG = out('gels')
  if (bG) { const hit = findSignal(bG); if (hit) writeScalar(hit, r.exposed.gels, changed) }
  const bPr = out('profile')
  if (bPr) { const hit = findSignal(bPr); if (hit) writeVector(hit, r.profile, changed) }
  const bImg = out('defectImage')
  if (bImg) {
    const hit = findSignal(bImg)
    if (hit) {
      if (!hit.sig.runtime) hit.sig.runtime = { value: 0, hist: [] }
      hit.sig.runtime.image = renderDefectImage(r.profile, r.exposed.defect, cfModel)
      hit.sig.runtime.value = r.exposed.defect
      pushChanged(changed, hit.nodeId, { id: hit.sig.id, name: hit.sig.name, value: hit.sig.runtime.value, unit: hit.sig.unit })
    }
  }

  // 每台**宿主设备**各推一帧:nodeId 与 /api/nodes 里真实存在的设备 id 一致,
  // 任何 WS 消费端(模拟器 UI、外部工具)都能按 device.id 直接落到卡片上。
  const at = Date.now()
  for (const [nodeId, signals] of changed) {
    broadcast({ type: 'signal.update', payload: { nodeId, signals, at } })
  }

  if (cfg.truthExport) {
    if (!truthStream) openTruthStream(cfg)
    const sample: PlantTruthSample = {
      t: new Date().toISOString(),
      phase: cfg.phase ?? 'steady',
      sp: controls as unknown as Record<string, number>,
      truth: r.truth as unknown as Record<string, unknown>,
      exposed: r.exposed,
    }
    truthStream!.write(`${JSON.stringify(sample)}\n`)
    truthCount++
    if (truthCount > TRUTH_ROTATE_LINES) openTruthStream(cfg)
  }
}

/** biax 标称工况(控制面缺省值来源;presets 的 SP 缺省与此一致) */
function biaxNominal(): BiaxControls {
  return BIAX_NOMINAL
}

/** 启动物理模型(按 config.plantModel;未启用则停止)。
 *  warm=true 时热态复位(各温=标称工艺温度、运输管线填满稳态)→ 免去冷态预热;缺省冷态(与既有行为一致)。 */
export function startPlantModel(warm = false): void {
  stopPlantModel()
  const cfg = getConfig().plantModel
  if (!cfg?.enabled) return
  if (cfg.kind === 'biax') {
    biaxModel = new BiaxModel(cfg.params, cfg.seed)
    model = biaxModel
    biaxModel.reset(cfg.seed, /* cold = */ !warm)
    if (cfg.truthExport) openTruthStream(cfg)
    timer = setInterval(stepOnce, Math.max(cfg.dtMs, 100))
    timer.unref?.()
    stepOnce()
    console.log(`[plant-model] 已启用 biax(双拉产线)物理引擎 seed=${cfg.seed} dt=${cfg.dtMs}ms ×${cfg.timeScale} 阶段=${cfg.phase}${warm ? ' 热态' : ' 冷态'}`)
    return
  }
  model = new CastFilmModel(cfg.params, cfg.seed)
  biaxModel = undefined
  model.reset(cfg.seed, /* cold = */ !warm)
  if (cfg.truthExport) openTruthStream(cfg)
  timer = setInterval(stepOnce, Math.max(cfg.dtMs, 100))
  timer.unref?.()
  // 启动即推一拍:绑定信号立刻有值
  stepOnce()
  console.log(`[plant-model] 已启用 cast-film 物理引擎 seed=${cfg.seed} dt=${cfg.dtMs}ms ×${cfg.timeScale} 阶段=${cfg.phase}${warm ? ' 热态' : ' 冷态'}`)
}

export function stopPlantModel(): void {
  if (timer) { clearInterval(timer); timer = undefined }
  if (truthStream) { truthStream.end(); truthStream = undefined }
  model = undefined
  biaxModel = undefined
}

export function plantRunning(): boolean {
  return timer !== undefined
}

/** 当前模型瞬时真值(供 REST 查看;不落盘) */
export function plantSnapshot(): Record<string, unknown> | null {
  if (!model) return null
  const cfg = getConfig().plantModel
  const base = {
    enabled: cfg?.enabled ?? false,
    running: plantRunning(),
    kind: cfg?.kind ?? 'castfilm',
    phase: cfg?.phase ?? 'steady',
    disturbances: cfg?.disturbances ?? {},
    seed: cfg?.seed,
    timeScale: cfg?.timeScale ?? 1,
    elapsedS: Number(model.elapsedS.toFixed(1)),
  }
  if (biaxModel) {
    // 最近一拍 truth 由 stepOnce 写进绑定信号;快照直接读模型内部稳态观测量
    const s = biaxModel.lastTruth
    return { ...base, ...(s ? { thickness: s.thickness, defect: s.defect, haze: s.haze, sigma: s.sigma, tension: s.tension, rollDia: s.rollDia, meltTemp: s.meltTemp } : {}) }
  }
  return { ...base, defect: Number((model as CastFilmModel).defect.toFixed(3)) }
}

/** 最近 N 行真值(JSONL 尾读;评测/可视化直接拉取) */
export function readTruth(limit = 500): Array<Record<string, unknown>> {
  const file = path.join(DATA_DIR, 'truth.jsonl')
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  return lines.slice(-limit - 1).filter(l => l && !l.includes('"meta"')).map(l => JSON.parse(l) as Record<string, unknown>)
}

/** 工况阶段切换(脚本驱动;阶段只做真值打标,SP 变更走真实协议写) */
export function setPhase(phase: PlantTruthSample['phase'], disturbances?: PlantModelConfig['disturbances']): PlantModelConfig | undefined {
  const cfg = getConfig().plantModel
  if (!cfg) return undefined
  cfg.phase = phase
  if (disturbances) cfg.disturbances = { ...cfg.disturbances, ...disturbances }
  saveConfig()
  return cfg
}
