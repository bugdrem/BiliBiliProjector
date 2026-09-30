/**
 * 设备探测与跑分（P9.27 D43）：设置页「系统环境及硬件检测」后端适配层
 *
 *  - probeDeviceInfo()：原生 DeviceProbe.getInfo（设备/SoC/内存/硬解支持/模拟器），
 *    Web 环境回退 navigator 信息（硬解支持未知）
 *  - runCpuBenchmark()：原生多核定时长基准（Mops/s），Web 回退单线程 JS 基准 × 核数近似
 *  - analyzeDevice()：按「硬解支持优先 + CPU 分数档位」给出编码/解码器推荐
 *
 * 推荐逻辑（结合 D36 编码语义与 D39 解码器语义）：
 *  1. 模拟器 → 原生软解 + default（GPU 转译解码易绿屏，D42 实测）
 *  2. 硬解 AV1 → hw + av01（同画质带宽最优）
 *  3. 硬解 HEVC → hw + hev1（硬解不吃 CPU，弱机也推荐）
 *  4. 仅硬解 AVC → hw + default（avc1 优先，兼容性最好）
 *  5. 无任何硬解 + CPU 中/强 → sw + default（软解 H.264 稳定）
 *  6. 无任何硬解 + CPU 弱 → hw + default（selector 空集自动回退系统默认解码器）
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

const DeviceProbe = registerPlugin('DeviceProbe')

/** 原生调用超时包装（P9.31 D47）：老设备插件调用挂死时兜底回退，面板不无限转圈 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('原生调用超时(' + ms + 'ms)')), ms))
  ])
}

/** 设备信息（原生或 Web 回退） */
export async function probeDeviceInfo() {
  if (Capacitor.isNativePlatform()) {
    try {
      const r = await withTimeout(DeviceProbe.getInfo(), 5000)
      if (r && typeof r.cores === 'number') return r
      throw new Error('返回数据异常')
    } catch (err) {
      console.warn('[BiliTV] 原生设备信息获取失败，回退 Web 探测:', err.message)
    }
  }
  const nav = navigator
  return {
    manufacturer: '',
    model: '浏览器环境',
    androidVersion: '',
    apiLevel: 0,
    soc: '',
    board: '',
    abi: '',
    cores: nav.hardwareConcurrency || 4,
    memGB: nav.deviceMemory ? Math.round(nav.deviceMemory * 10) / 10 : 0,
    glEs: '',
    isEmulator: false,
    hwAvc: false,
    hwHevc: false,
    hwAv1: false,
    hwUnknown: true
  }
}

/** CPU 跑分（Mops/s，多核合计） */
export async function runCpuBenchmark() {
  if (Capacitor.isNativePlatform()) {
    try {
      const r = await withTimeout(DeviceProbe.benchCpu(), 10000)
      if (r && r.score > 0) return { score: r.score, threads: r.threads || 1 }
      throw new Error('返回数据异常')
    } catch (err) {
      console.warn('[BiliTV] 原生跑分失败，回退 JS 基准:', err.message)
    }
  }
  return { score: jsBenchmark(), threads: Math.max(1, (navigator.hardwareConcurrency || 4) - 1) }
}

/**
 * Web 回退基准：单线程 xorshift + 周期 sqrt，1.2s 定时长，
 * 乘 (核数-1)×0.8 近似多核（Worker 并行在 TV WebView 兼容性参差，不引入复杂度）
 */
function jsBenchmark() {
  const deadline = performance.now() + 1200
  let acc = 2463534242
  let ops = 0
  let cnt = 0
  while (performance.now() < deadline) {
    for (let i = 0; i < 20000; i++) {
      acc ^= acc << 13
      acc |= 0
      acc ^= acc >>> 7
      acc ^= acc << 17
      acc |= 0
      cnt++
      if ((cnt & 255) === 0) acc += Math.sqrt(cnt) | 0
      ops += 8
    }
  }
  const single = ops / 1.2 / 1e6
  return Math.round(single * Math.max(1, ((navigator.hardwareConcurrency || 4) - 1) * 0.8))
}

/** 分数档位：弱（老投影/入门盒子）/ 中（主流电视）/ 强（旗舰/PC 级） */
function scoreTier(score) {
  if (score >= 400) return { key: 'high', name: '强' }
  if (score >= 120) return { key: 'mid', name: '中' }
  return { key: 'low', name: '弱' }
}

/**
 * 匹配最优编码 + 解码器
 * @param {object} info probeDeviceInfo() 结果
 * @param {number} score runCpuBenchmark() 分数
 * @returns {{tierName:string, score:number, decoder:string, decoderName:string, codec:string, codecName:string, reason:string, qnAdvice:string}}
 */
export function analyzeDevice(info, score) {
  const tier = scoreTier(score)
  let decoder = 'hw'
  let codec = 'default'
  let reason = ''
  if (info.isEmulator) {
    decoder = 'sw'
    codec = 'default'
    reason = '模拟器环境：GPU 转译解码易绿屏，使用原生软解'
  } else if (info.hwAv1) {
    codec = 'av01'
    reason = '硬件支持 AV1 解码：同画质带宽最优'
  } else if (info.hwHevc) {
    codec = 'hev1'
    reason = '硬件支持 HEVC 解码：同画质码率低于 H.264，硬解不占 CPU'
  } else if (info.hwAvc) {
    reason = '仅硬解 H.264：编码跟随默认（AVC 优先），兼容性最好'
  } else if (tier.key !== 'low') {
    decoder = 'sw'
    reason = '无硬件解码器但 CPU 较强：软解 H.264 稳定'
  } else {
    reason = '无硬件解码器且 CPU 较弱：使用系统默认解码器，建议限制 720P'
  }
  const decoderNames = { webview: 'WebView 内核', hw: '原生·硬解码', sw: '原生·软解码' }
  const codecNames = { default: '跟随默认（AVC 优先）', avc1: 'H.264/AVC', hev1: 'H.265/HEVC', av01: 'AV1' }
  const qnAdvice = tier.key === 'low' ? '建议默认分辨率 720P' : tier.key === 'mid' ? '建议默认分辨率 1080P' : '分辨率可开自动（支持的最高）'
  let reasonFull = reason
  if (info.hwUnknown) reasonFull += '（本机硬解能力未知，按保守策略推荐）'
  return {
    score,
    tierName: tier.name,
    decoder,
    decoderName: decoderNames[decoder],
    codec,
    codecName: codecNames[codec],
    reason: reasonFull,
    qnAdvice
  }
}
