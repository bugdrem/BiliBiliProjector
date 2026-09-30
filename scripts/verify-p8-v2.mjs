/**
 * P8 CDP 验证 V2：诊断 currentTime 卡住
 *  - video.buffered / 双 SourceBuffer.buffered 实况
 *  - 重新拉 sidx 头部，手动解析 frags[24..30] 验证 t 累加
 */
const PAGE_ID = 'A7AA801E992E949FD11F25E9FA23AC69'
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${PAGE_ID}`)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 25000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) {
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => (ws.onopen = r))

  // 1. buffered 实况
  const buf = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    const out = { videoBuffered: [], readyState: v.readyState, currentTime: v.currentTime, paused: v.paused }
    try {
      const ms = window.MediaSource ? null : null
      // video.src 是 blob: —— 通过 mediaSource 全局引用不存在，改走 v.buffered（等价于所有 SB 合并）
      for (let i = 0; i < v.buffered.length; i++) out.videoBuffered.push([v.buffered.start(i), v.buffered.end(i)])
    } catch (e) { out.err = e.message }
    out.mseDebug = (window.__mseDebug || []).slice(-14)
    return out
  })()`)
  console.log('== buffered 实况 ==')
  console.log(JSON.stringify(buf, null, 1))

  // 2. 手动重拉 sidx 解析（用当前页面内 fetch + Range）
  const sidxDump = await evalJS(`(async () => {
    // 从探针反推不可行——重新请求 playurl 拿当前视频的 dash（页面已有 cookie 通道 apiGet，
    // 但模块不在全局；这里手动 fetch wbi playurl 太重，改用简单法：fetch 当前 blob 无用。
    // 方案：直接对探针里记录不到的 URL 无能为力 → 改为诊断 append 后的 SB 内部时间轴。
    return 'skip'
  })()`)
  console.log('sidxDump:', sidxDump)

  // 3. 检查 MediaSource sourceBuffers（通过 video 挂钩 hack：Chromium 无直接路径，跳过）

  // 4. 手动 nudge：把 currentTime 往前推 0.5s 看是否恢复播放
  const nudge = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    if (!v) return 'NO_VIDEO'
    v.currentTime = v.currentTime + 0.5
    return 'NUDGED'
  })()`)
  console.log('nudge:', nudge)
  await sleep(2500)
  const after = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    const bs = []
    for (let i = 0; i < v.buffered.length; i++) bs.push([v.buffered.start(i), v.buffered.end(i)])
    return { t: v.currentTime, paused: v.paused, readyState: v.readyState, buffered: bs }
  })()`)
  console.log('nudge 后:', JSON.stringify(after))

  ws.close()
}

main().catch((e) => { console.error('V2 异常：', e.message); process.exit(1) })
