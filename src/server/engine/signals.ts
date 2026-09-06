/**
 * 信号生成策略库 —— 模拟真实物理设备数据的核心。
 *
 * 设计:每信号独立策略 + 故障注入 + 标定;tick(now) 纯推进内部状态,无 IO。
 * 一阶惯性工艺闭环抄自主项目 scripts/dev-plc-simulator.mjs 已验证的动力学:
 *   PV' = PV + (SP − PV)·(1 − e^(−dt/τ)) + 噪声·sqrt(dt·2)
 */
import type { SignalDef, SignalStrategy } from '../../shared/types'

/** 简易安全表达式求值:只允许数字/四则/括号/常用函数,变量用 [信号名] 引用 */
export function evalExpression(expr: string, vars: Record<string, number>): number {
  // 展开 [name] → (value);未知信号按 0 处理
  const expanded = expr.replace(/\[([^\[\]]+)\]/g, (_, name) => {
    const v = vars[String(name).trim()]
    return `(${Number.isFinite(v) ? v : 0})`
  })
  // 白名单字符校验:数字/运算符/括号/点/空格/科学计数 e
  if (!/^[-+*/%().\d\s,e]*$/.test(expanded)) throw new Error(`表达式含非法字符: ${expr}`)
  const body = `
    const { abs, min, max, round, floor, ceil, sqrt, pow, sin, cos, tan, log, exp, PI } = Math;
    return (${expanded});
  `
  const fn = new Function('Math', body)
  const v = fn(Math)
  if (!Number.isFinite(v)) throw new Error(`表达式结果非有限数: ${expr}`)
  return v
}

/** 高斯噪声(Box-Muller) */
export function gauss(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity)

/** 应用故障注入:返回 { value, faulted } */
function applyFaults(sig: SignalDef, raw: number, now: number): { value: number, faulted: boolean } {
  const f = sig.faults
  if (!f) return { value: raw, faulted: false }
  const rt = sig.runtime!
  let value = raw
  let faulted = false
  if (f.stuckAt) {
    // 卡值:冻结在上一拍值;首拍(hist 为空)放行,否则永远 0
    if (rt.hist && rt.hist.length > 0) {
      value = rt.value
      faulted = true
    }
  }
  if (f.spike) {
    if (rt.spikeUntil && now < rt.spikeUntil) {
      const range = (sig.max ?? 100) - (sig.min ?? 0)
      value = clamp(value + range * f.spike.overshoot, sig.min, sig.max)
      faulted = true
    }
    else if (Math.random() < f.spike.probability) {
      rt.spikeUntil = now + f.spike.durationMs
    }
  }
  if (f.drift) {
    value = value + f.drift.perTick
    faulted = true
  }
  return { value, faulted }
}

/** 推进单个信号一拍:返回新值(已含故障+标定);hist 由此维护(cap 60) */
export function tickSignal(sig: SignalDef, now: number): number {
  const rt = sig.runtime!
  const prev = rt.value
  // 首拍 dt=0(只初始化,不推进时间);后续按真实间隔
  const dt = rt.lastTick === undefined ? 0 : Math.max(now - rt.lastTick, 0)
  rt.lastTick = now
  const s: SignalStrategy = sig.strategy
  let raw = 0
  switch (s.kind) {
    case 'constant':
    case 'manual':
      raw = s.value
      break
    case 'sine':
      raw = s.base + s.amp * Math.sin((2 * Math.PI * now) / Math.max(s.periodMs, 1))
      break
    case 'random-walk': {
      if (rt.cursor === undefined) rt.cursor = s.start
      rt.cursor = clamp(rt.cursor + gauss() * s.step, s.min, s.max)
      raw = rt.cursor
      break
    }
    case 'ramp': {
      if (rt.cursor === undefined) rt.cursor = 0
      rt.cursor += dt
      const duration = Math.max(s.durationMs, 1)
      let p = rt.cursor / duration
      if (p >= 1) {
        if (s.loop) { rt.cursor = 0; p = 0 }
        else p = 1
      }
      raw = s.start + (s.end - s.start) * p
      break
    }
    case 'first-order': {
      // PV' = PV + (SP − PV)·(1 − e^(−dt/τ)) + 噪声·sqrt(dt·2)
      const alpha = 1 - Math.exp(-dt / Math.max(s.tauMs, 1))
      raw = prev + (s.sp - prev) * alpha + gauss() * s.noise * Math.sqrt((dt / 1000) * 2)
      break
    }
    case 'expression':
      // 变量注入在调用方(node.ts)通过 strategy 预替换;此处裸表达式引用 runtime.cursor
      raw = evalExpression(s.expr, {})
      break
  }
  // stuckAt 冻结:非首拍直接返回上一拍值(不推进、不覆盖)
  if (sig.faults?.stuckAt && rt.hist && rt.hist.length > 0) {
    rt.hist.push(rt.value)
    if (rt.hist.length > 60) rt.hist.shift()
    return rt.value
  }
  const { value } = applyFaults(sig, raw, now)
  // 标定:输出 = value × scale + offset(与主项目 DataTransform 同约定)
  const out = value * (sig.scale ?? 1) + (sig.offset ?? 0)
  const dec = sig.decimals ?? 3
  rt.value = Number(out.toFixed(dec))
  rt.hist!.push(rt.value)
  if (rt.hist!.length > 60) rt.hist!.shift()
  return rt.value
}

/** 表达式策略:由 node.ts 注入其他信号变量后求值 */
export function tickExpressionSignal(sig: SignalDef, vars: Record<string, number>, now: number): number {
  const rt = sig.runtime!
  rt.lastTick = now
  const raw = evalExpression(sig.strategy.kind === 'expression' ? sig.strategy.expr : '0', vars)
  const { value } = applyFaults(sig, raw, now)
  const out = value * (sig.scale ?? 1) + (sig.offset ?? 0)
  rt.value = Number(out.toFixed(sig.decimals ?? 3))
  rt.hist!.push(rt.value)
  if (rt.hist!.length > 60) rt.hist!.shift()
  return rt.value
}

/**
 * 外部写回灌(协议写到达时统一入口):first-order 改 sp(闭环),其余策略改目标值;
 * manual/constant 立即落到 runtime.value(DCW 写后同址回读一致依赖此语义)。
 * out 为「输出域」物理值(主项目 DCW 写入 raw × scale + offset)。
 */
export function applyWriteback(sig: SignalDef, out: number): void {
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  if (sig.strategy.kind === 'first-order') sig.strategy.sp = out
  else if (sig.strategy.kind === 'manual' || sig.strategy.kind === 'constant') sig.strategy.value = out
  // 其余策略(sine/random-walk/ramp/expression):外部写仅立即生效到当前值,下一拍回到策略曲线
  sig.runtime.value = Number(out.toFixed(sig.decimals ?? 3))
}
