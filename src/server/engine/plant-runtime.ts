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
import { encodeGrayPng } from './png-enc'
import { broadcast } from '../bus'
import { DATA_DIR, getConfig, saveConfig } from '../store'

let timer: NodeJS.Timeout | undefined
let model: CastFilmModel | undefined
let truthStream: fs.WriteStream | undefined
let truthCount = 0

const TRUTH_ROTATE_LINES = 200_000

function findSignal(b: PlantBinding): { nodeSignals: SignalDef[], sig: SignalDef } | undefined {
  const node = getConfig().nodes.find(n => n.id === b.nodeId)
  if (!node) return undefined
  const sig = (node.signals ?? []).find(s => s.id === b.signalId)
  if (!sig) return undefined
  return { nodeSignals: node.signals ?? [], sig }
}

function readControl(b: PlantBinding | undefined, fallback: number): number {
  if (!b) return fallback
  const hit = findSignal(b)
  const v = hit?.sig.runtime?.value
  return Number.isFinite(v) ? v! : fallback
}

function writeScalar(sig: SignalDef, value: number, changed: Array<{ id: string, name: string, value: number, unit?: string }>): void {
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  const dec = sig.decimals ?? 3
  sig.runtime.value = Number(value.toFixed(dec))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  changed.push({ id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
}

function writeVector(sig: SignalDef, points: number[], changed: Array<{ id: string, name: string, value: number, unit?: string }>): void {
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  sig.runtime.vector = points
  const avg = points.reduce((a, b) => a + b, 0) / Math.max(points.length, 1)
  sig.runtime.value = Number(avg.toFixed(3))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  changed.push({ id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
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

function stepOnce(): void {
  const cfg = getConfig().plantModel
  if (!cfg?.enabled || !model) return
  const dtSec = (cfg.dtMs / 1000) * cfg.timeScale
  const controls = readControls(cfg)
  const r: PlantStepResult = model.step(controls, dtSec, {
    heaterDecay: cfg.disturbances?.heaterDecay ?? 1,
    feedDriftPerMin: cfg.disturbances?.feedDriftPerMin ?? 0,
  })

  const changed: Array<{ id: string, name: string, value: number, unit?: string }> = []
  const out = (key: string) => cfg.outputs?.[key as keyof typeof cfg.outputs]

  const bTemp = out('meltTemp')
  if (bTemp) { const hit = findSignal(bTemp); if (hit) writeScalar(hit.sig, r.exposed.meltTemp, changed) }
  const bP = out('meltPressure')
  if (bP) { const hit = findSignal(bP); if (hit) writeScalar(hit.sig, r.exposed.pressure, changed) }
  const bH = out('filmThickness')
  if (bH) { const hit = findSignal(bH); if (hit) writeScalar(hit.sig, r.exposed.thickness, changed) }
  const bD = out('defectRate')
  if (bD) { const hit = findSignal(bD); if (hit) writeScalar(hit.sig, r.exposed.defect, changed) }
  const bG = out('gels')
  if (bG) { const hit = findSignal(bG); if (hit) writeScalar(hit.sig, r.exposed.gels, changed) }
  const bPr = out('profile')
  if (bPr) { const hit = findSignal(bPr); if (hit) writeVector(hit.sig, r.profile, changed) }
  const bImg = out('defectImage')
  if (bImg) {
    const hit = findSignal(bImg)
    if (hit) {
      if (!hit.sig.runtime) hit.sig.runtime = { value: 0, hist: [] }
      hit.sig.runtime.image = renderDefectImage(r.profile, r.exposed.defect, model)
      hit.sig.runtime.value = r.exposed.defect
      changed.push({ id: hit.sig.id, name: hit.sig.name, value: hit.sig.runtime.value, unit: hit.sig.unit })
    }
  }

  if (changed.length > 0) {
    broadcast({ type: 'signal.update', payload: { nodeId: 'plant-model', signals: changed, at: Date.now() } })
  }

  if (cfg.truthExport) {
    if (!truthStream) openTruthStream(cfg)
    const sample: PlantTruthSample = {
      t: new Date().toISOString(),
      phase: cfg.phase ?? 'steady',
      sp: controls,
      truth: r.truth,
      exposed: r.exposed,
    }
    truthStream!.write(`${JSON.stringify(sample)}\n`)
    truthCount++
    if (truthCount > TRUTH_ROTATE_LINES) openTruthStream(cfg)
  }
}

/** 启动物理模型(按 config.plantModel;未启用则停止) */
export function startPlantModel(): void {
  stopPlantModel()
  const cfg = getConfig().plantModel
  if (!cfg?.enabled) return
  model = new CastFilmModel(cfg.params, cfg.seed)
  if (cfg.truthExport) openTruthStream(cfg)
  timer = setInterval(stepOnce, Math.max(cfg.dtMs, 100))
  timer.unref?.()
  // 启动即推一拍:绑定信号立刻有值
  stepOnce()
  console.log(`[plant-model] 已启用 cast-film 物理引擎 seed=${cfg.seed} dt=${cfg.dtMs}ms ×${cfg.timeScale} 阶段=${cfg.phase}`)
}

export function stopPlantModel(): void {
  if (timer) { clearInterval(timer); timer = undefined }
  if (truthStream) { truthStream.end(); truthStream = undefined }
  model = undefined
}

export function plantRunning(): boolean {
  return timer !== undefined
}

/** 当前模型瞬时真值(供 REST 查看;不落盘) */
export function plantSnapshot(): Record<string, unknown> | null {
  if (!model) return null
  const cfg = getConfig().plantModel
  return {
    enabled: cfg?.enabled ?? false,
    running: plantRunning(),
    phase: cfg?.phase ?? 'steady',
    disturbances: cfg?.disturbances ?? {},
    seed: cfg?.seed,
    timeScale: cfg?.timeScale ?? 1,
    elapsedS: Number(model.elapsedS.toFixed(1)),
    defect: Number(model.defect.toFixed(3)),
  }
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
