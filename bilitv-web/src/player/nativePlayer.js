/**
 * 原生播放内核适配器（P9.19 D39）
 *
 * 桥接安卓侧 NativePlayerPlugin（media3 ExoPlayer + TextureView 渲染层）：
 *  - 完全绕开 WebView 媒体栈——极米 Z7X 等老投影的 MSE/解码原生崩溃的根治方案
 *  - decoder=hw：厂商硬件解码器；sw：强制软解（OMX.google/c2.android 系统软编解码器）
 *  - 几何同步：JS 量取占位盒 getBoundingClientRect → layout(cssPx × dpr)
 *  - 进度：JS 500ms 轮询 getProgress 驱动 timeupdate 语义；事件走 prepared/ended/error
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

const NativePlayer = registerPlugin('NativePlayer')

/** 是否可用（仅原生环境有该插件） */
export function nativePlayerAvailable() {
  return Capacitor.isNativePlatform()
}

/** 模拟器环境检测（P9.26 D42）：MuMu/AVD 等模拟器视频解码走 GPU 转译常绿屏，需自动切软解 */
export async function isEmulatorDevice() {
  if (!Capacitor.isNativePlatform()) return false
  try {
    const r = await NativePlayer.isEmulator()
    return !!r.value
  } catch (_) {
    return false
  }
}

/** bilibili CDN 必需请求头（原生通道无浏览器 forbidden headers 限制，可全量透传） */
export function biliHeaders() {
  return {
    Referer: 'https://www.bilibili.com/',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; BiliTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  }
}

/**
 * 加载直连流并起播
 * @param {{url:string, decoder:'hw'|'sw', startSec?:number, rect?:{x:number,y:number,w:number,h:number}, dpr?:number}} opts
 */
export async function nativeLoad(opts) {
  if (opts.rect) {
    await NativePlayer.layout({
      x: opts.rect.x,
      y: opts.rect.y,
      w: opts.rect.w,
      h: opts.rect.h,
      dpr: opts.dpr || window.devicePixelRatio || 1,
      stretch: !!opts.rect.stretch
    })
  }
  await NativePlayer.load({
    url: opts.url,
    headers: opts.headers || biliHeaders(),
    decoder: opts.decoder || 'hw',
    startMs: Math.round((opts.startSec || 0) * 1000)
  })
}

/** 同步渲染层几何（窗口 resize 时调用） */
export async function nativeLayout(rect) {
  await NativePlayer.layout({
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    dpr: window.devicePixelRatio || 1,
    stretch: !!rect.stretch
  })
}

/** 渲染层调暗（P9.30 D46）：OSD/面板/HUD 显示时降低视频层不透明度，
 *  让 WebView 里的浮层"透"出来（原生视频层盖在 WebView 之上） */
export async function nativeDim(alpha) {
  try {
    await NativePlayer.dim({ alpha })
  } catch (_) {
    /* 忽略 */
  }
}

export async function nativePlay() {
  await NativePlayer.play()
}

export async function nativePause() {
  await NativePlayer.pause()
}

/** seek（秒） */
export async function nativeSeekTo(sec) {
  await NativePlayer.seekTo({ ms: Math.round(sec * 1000) })
}

export async function nativeSetSpeed(speed) {
  await NativePlayer.setSpeed({ speed })
}

/** 进度：{ positionSec, durationSec, playing } */
export async function nativeGetProgress() {
  const p = await NativePlayer.getProgress()
  return {
    positionSec: (p.position || 0) / 1000,
    durationSec: (p.duration || 0) / 1000,
    playing: !!p.playing
  }
}

/** 离开原生播放：释放播放器并摘除渲染层 */
export async function nativeRelease() {
  try {
    await NativePlayer.release()
    await NativePlayer.hide()
  } catch (_) {
    /* 忽略 */
  }
}

/** 事件监听（prepared/ended/error/stateChanged），返回 remove 句柄 */
export async function nativeOn(event, cb) {
  const handle = await NativePlayer.addListener(event, (data) => cb(data || {}))
  return handle
}
