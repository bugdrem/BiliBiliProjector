package com.bilitv.app;

import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.DefaultRenderersFactory;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 原生播放内核插件（P9.19 D39）
 *
 * 背景：极米 Z7X 等老投影的 WebView 媒体栈存在原生崩溃（MSE/DURL 均触发），
 * 需要完全绕开 WebView 的原生播放管线。ijkplayer 预编译随 jcenter 停服不可得，
 * 采用 media3 ExoPlayer（Apache-2.0，Maven Central 稳定可得）。
 *
 * 职责：
 *  - TextureView 原生渲染层：加在 android.R.id.content 顶层，覆盖 WebView 对应区域
 *  - load(url, headers, decoder)：decoder=hw 用厂商硬件解码器；sw 强制软解
 *    （OMX.google/c2.android 系统软编解码器，MediaCodecSelector 重排序实现）
 *  - JS 侧通过 layout(cssW, cssH, cssX, cssY, dpr) 同步 <video 占位区> 的几何位置
 *  - 事件：prepared/ended/error/stateChanged 通知 JS；进度由 JS 轮询 getProgress
 */
@CapacitorPlugin(name = "NativePlayer")
@OptIn(markerClass = UnstableApi.class)
public class NativePlayerPlugin extends Plugin {

    private ExoPlayer player;
    /**
     * P9.46（Z7X 闪退对策）：渲染层 TextureView → SurfaceView。
     * TextureView 走 app 内 GL 合成（老 GPU 驱动上是常见 native 闪退源，且每帧拷贝），
     * SurfaceView 由系统独立窗口合成、天然位于窗口层之下——正好满足 D55 的
     * 「视频在底、WebView（透明挖洞）在上」架构，且是老电视/投影上最稳的路径。
     * Surface 由 SurfaceHolder 系统管理，**不可手动 release**，只做摘挂。
     */
    private SurfaceView surfaceView;
    /** P9.44：Surface 单例复用+显式释放（原先每次 load 匿名 new Surface 从不 release，
     *  长时间连播/切清晰度会不断泄漏 BufferQueue，最终硬解 IllegalStateException） */
    private android.view.Surface videoSurface;
    private String decoderMode = "hw"; // hw=硬件解码（默认） / sw=软解码
    private boolean surfaceReady = false;
    private boolean pendingStart = false;
    /** P9.44：最后一次有效播放进度（ms）——异常/IDLE 时避免把 0 写进用户历史 */
    private long lastKnownPos = 0;
    /** P9.44：同一 media 上 IO 自愈重试计数 */
    private int ioRetryCount = 0;

    // 视频帧几何（P9.30 D46）：用于在占位区内等比缩放居中（修复拉伸变形）
    private int tgtX, tgtY, tgtW, tgtH; // 占位区（设备 px）
    private int videoW = 0, videoH = 0; // 视频原始宽高
    private float videoSar = 1f; // 像素宽高比
    private int videoRot = 0; // 未应用的旋转角
    private boolean stretchMode = false; // P9.34 D50：true=拉伸铺满占位区（视频适应模式=全屏拉伸）

    /**
     * 原生渲染进行中（P9.29 D45）：MainActivity.dispatchTouchEvent 据此把触摸
     * 直接派发给 WebView（渲染层不参与焦点，事件由 WebView 处理）。
     * load 置 true；release/hide 置 false。volatile 保证跨线程可见。
     */
    public static volatile boolean rendering = false;

    /**
     * 按模式构造解码器选择器（真实 API：接口方法为 getDecoderInfos(mimeType, secure, tunneling)，
     * 自查全系统编解码器后按 MediaCodecInfo.hardwareAccelerated/softwareOnly 过滤；
     * 目标类别为空时回退系统默认顺序，保证可播）
     */
    /**
     * 按模式构造解码器选择器（真实 API：接口方法为 getDecoderInfos(mimeType, secure, tunneling)，
     * 自查全系统编解码器后按 MediaCodecInfo.hardwareAccelerated/softwareOnly 过滤；
     * 目标类别为空时回退系统默认顺序，保证可播）
     *
     * P9.44 修正（解码器自愈）：原实现在 hw 模式**只**返回硬解候选，此时
     * setEnableDecoderFallback(true) 形同虚设——fallback 只能在候选列表内依次重试，
     * 硬解 init 失败没有第二个候选可退（Z7X 上表现为绿屏/起播失败且无法自愈）。
     * 现在 hw 模式返回「硬解在前 + 软解追尾」，真正用上 retryWithCodecReconfiguration；
     * sw 模式仍只给软解（目标就是绕开厂商硬解 bug）。
     */
    private MediaCodecSelector buildSelector() {
        final String mode = decoderMode;
        return (mimeType, requiresSecure, requiresTunneling) -> {
            List<MediaCodecInfo> infos =
                MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, requiresSecure, requiresTunneling);
            List<MediaCodecInfo> hwList = new ArrayList<>();
            List<MediaCodecInfo> swList = new ArrayList<>();
            for (MediaCodecInfo info : infos) {
                if (info.hardwareAccelerated) hwList.add(info);
                if (info.softwareOnly) swList.add(info);
            }
            if ("sw".equals(mode)) return swList.isEmpty() ? infos : swList;
            if ("hw".equals(mode)) {
                if (hwList.isEmpty()) return swList.isEmpty() ? infos : swList;
                List<MediaCodecInfo> picked = new ArrayList<>(hwList);
                picked.addAll(swList); // 硬解失败 → 自动退到软解
                return picked;
            }
            return infos;
        };
    }

    /**
     * 构建播放器：DefaultRenderersFactory.setMediaCodecSelector 注入解码器选择器 +
     * setEnableDecoderFallback（首选解码器失败时自动回退，老设备保命项）+
     * EXTENSION_RENDERER_MODE_ON（P9.40 D54：启用 AV1 软解扩展 dav1d——设备无 AV1
     * 硬解时软件解码，防花屏/无法播放）+
     * LoadControl 缓冲调优（P9.38 D53：起播缓冲 2.5s / 重缓冲 5s / 上限 60s，
     * 弱网与慢解码设备减少起播卡顿与播放中停顿）
     */
    private ExoPlayer buildPlayer(DefaultHttpDataSource.Factory httpFactory) {
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(getContext())
            .setMediaCodecSelector(buildSelector())
            .setEnableDecoderFallback(true)
            // P9.44：工程未打包任何 media3-*-decoder 扩展制品，ON 会让每次 load 都对 6+ 个
            // 扩展类做反射 Class.forName 并吞 ClassNotFoundException（切一次清晰度重复一轮），
            // 且 ON 的语义是"扩展优先于平台解码器"——将来误加软解扩展会压过硬解。
            // 无扩展依赖时 OFF 行为等价且零反射开销。
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF);
        // P9.44 内存与卡顿权衡：原先 min 30s/max 60s + prioritizeTimeOverSizeThresholds(true)
        // 取消了 DefaultAllocator 的字节上限，长时间连播会持续吃内存/带宽，与 WebView 弹幕层抢资源。
        // 改为 15s/30s + 5s 重缓冲，保留回看缓冲（遥控器回拖），并恢复字节上限。
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(15000, 30000, 2500, 5000)
            .setBackBuffer(30000, true)
            .build();
        return new ExoPlayer.Builder(getContext(), renderersFactory)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
            // P9.44：音频焦点 + 耳机/蓝牙断连自动暂停（ExoPlayer.Builder 默认两项均为 false，
            // 投影外接音响抢占或断蓝牙时不会暂停，TV 场景必须显式打开）
            .setAudioAttributes(
                new androidx.media3.common.AudioAttributes.Builder()
                    .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                    .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                true)
            .setHandleAudioBecomingNoisy(true)
            .build();
    }

    /** SurfaceHolder 回调：surface 就绪即交给播放器（P9.46 SurfaceView 版） */
    /** SurfaceView 就绪后把 Surface 交给播放器（Surface 由系统持有，摘挂即可，勿 release） */
    private final SurfaceHolder.Callback surfaceCallback = new SurfaceHolder.Callback() {
        @Override
        public void surfaceCreated(SurfaceHolder holder) {
            surfaceReady = true;
            videoSurface = holder.getSurface();
            if (player != null) {
                player.setVideoSurface(videoSurface);
                if (pendingStart) {
                    pendingStart = false;
                    player.prepare();
                    player.setPlayWhenReady(true);
                }
            }
        }

        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

        @Override
        public void surfaceDestroyed(SurfaceHolder holder) {
            // Surface 随系统销毁：只需把播放器摘下（不能手动 release，归 SurfaceHolder 管）
            android.util.Log.w("BiliTV", "surface DESTROYED");
            releaseSurface();
        }
    };

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url 必填");
            return;
        }
        decoderMode = "sw".equals(call.getString("decoder")) ? "sw" : "hw";
        final double startMs = call.getDouble("startMs", 0.0);

        // 请求头（bilibili CDN 需要 Referer/UA；原生通道无浏览器 forbidden headers 限制）
        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(10000)
            .setReadTimeoutMs(15000);
        JSObject headers = call.getObject("headers");
        if (headers != null) {
            java.util.Map<String, String> headerMap = new java.util.HashMap<>();
            java.util.Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                Object v = headers.opt(k);
                if (k != null && v != null) headerMap.put(k, String.valueOf(v));
            }
            if (!headerMap.isEmpty()) httpFactory.setDefaultRequestProperties(headerMap);
        }

        // 关键：渲染层/ExoPlayer 全部 UI 与播放器操作必须在主线程
        // （插件方法运行在 CapacitorPlugins 线程，直接触碰 view 崩溃——P9.19 实测）
        getActivity().runOnUiThread(() -> {
            try {
                releaseInternal(); // 复位旧实例

                // 渲染层：挂在 content 底层（WebView 之下）—— P9.41 D55 层级翻转。
                // P9.46（Z7X 闪退对策）：TextureView → SurfaceView。TextureView 走 app 内
                // GL 合成，老 GPU（Z7X 投影芯片）上驱动级崩溃风险高、每帧还有 GPU 拷贝；
                // SurfaceView 由系统独立窗口合成、默认就在窗口层之下，与「视频在底、
                // WebView 透明挖洞在上」的架构天然匹配，是老电视/投影最稳的渲染路径。
                if (surfaceView == null) {
                    surfaceView = new SurfaceView(getContext());
                    surfaceView.getHolder().addCallback(surfaceCallback);
                    // P9.26 D42：渲染层纯展示——不响应焦点，避免抢遥控器按键
                    surfaceView.setFocusable(false);
                    // P9.28 D44 触摸转发逻辑保留（SurfaceView 仍会参与事件派发）
                    surfaceView.setOnTouchListener((v, event) -> {
                        android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                        if (wv == null || surfaceView == null) return false;
                        android.view.MotionEvent fwd = android.view.MotionEvent.obtain(event);
                        fwd.offsetLocation(surfaceView.getLeft(), surfaceView.getTop());
                        wv.dispatchTouchEvent(fwd);
                        fwd.recycle();
                        return true;
                    });
                    ViewGroup content = getActivity().findViewById(android.R.id.content);
                    // index 0 = 插到所有子视图最前（FrameLayout 后加者在上层）→ 渲染层沉底。
                    // 有缓存矩形用矩形，否则 MATCH_PARENT（过小尺寸可能拿不到 surface）。
                    ViewGroup.LayoutParams initLp;
                    if (tgtW > 0 && tgtH > 0) {
                        initLp = new FrameLayout.LayoutParams(tgtW, tgtH);
                    } else {
                        initLp = new FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
                    }
                    content.addView(surfaceView, 0, initLp);
                    if (tgtW > 0 && tgtH > 0) applyVideoFrame();
                }
                // 每次原生播放都重新确认 WebView 置顶 + 透明（防止其它视图抢上层）
                bringWebViewToFront(getActivity().findViewById(android.R.id.content));
                surfaceView.setVisibility(View.VISIBLE);
                surfaceReady = surfaceView.getHolder().getSurface() != null
                    && surfaceView.getHolder().getSurface().isValid();
                rendering = true; // P9.29 D45：MainActivity 触摸拦截生效

                player = buildPlayer(httpFactory);

                player.addListener(new Player.Listener() {
                    @Override
                    public void onVideoSizeChanged(androidx.media3.common.VideoSize videoSize) {
                        // P9.30 D46：帧几何变化 → 重算等比缩放布局（UI 线程）
                        videoW = videoSize.width;
                        videoH = videoSize.height;
                        videoSar = videoSize.pixelWidthHeightRatio <= 0 ? 1f : videoSize.pixelWidthHeightRatio;
                        videoRot = videoSize.unappliedRotationDegrees;
                        getActivity().runOnUiThread(() -> applyVideoFrame());
                    }

                    @Override
                    public void onPlaybackStateChanged(int state) {
                        if (player == null) return;
                        if (state == Player.STATE_READY) {
                            JSObject d = new JSObject();
                            d.put("duration", player.getDuration());
                            notifyListeners("prepared", d);
                            if (!player.isPlaying()) player.play();
                        } else if (state == Player.STATE_ENDED) {
                            notifyListeners("ended", new JSObject());
                        }
                    }

                    @Override
                    public void onIsPlayingChanged(boolean isPlaying) {
                        JSObject d = new JSObject();
                        d.put("playing", isPlaying);
                        notifyListeners("stateChanged", d);
                    }

                    @Override
                    public void onPlayerError(PlaybackException error) {
                        if (player == null) return;
                        final String msg = error.getMessage() == null ? "unknown" : error.getMessage();

                        // P9.44：区分 IO 抖动与真正的解码/渲染失败。
                        // 旧实现只上报一句话，PlayerView.handleNativeError 无法区分，
                        // 一次弱网抖动就把 nativeFallbackUsed 永久置真 → 降级到 Z7X 上已知会崩的
                        // WebView 内核。现在 TYPE_SOURCE(网络/数据源) 在原生层先自愈（最多 2 次，
                        // 1s/3s 退避），解码/渲染类才上报给 JS 走「原生 hw → 原生 sw → WebView」。
                        boolean isSourceError = false;
                        String typeName = "unknown";
                        if (error instanceof androidx.media3.exoplayer.ExoPlaybackException) {
                            androidx.media3.exoplayer.ExoPlaybackException epe =
                                (androidx.media3.exoplayer.ExoPlaybackException) error;
                            isSourceError = epe.type == androidx.media3.exoplayer.ExoPlaybackException.TYPE_SOURCE;
                            typeName = epe.type == androidx.media3.exoplayer.ExoPlaybackException.TYPE_SOURCE
                                ? "source"
                                : epe.type == androidx.media3.exoplayer.ExoPlaybackException.TYPE_RENDERER
                                    ? "renderer"
                                    : "unexpected";
                        }

                        if (isSourceError && ioRetryCount < 2) {
                            ioRetryCount++;
                            final long resume = lastKnownPos;
                            final long delay = ioRetryCount == 1 ? 1000L : 3000L;
                            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                                try {
                                    if (player != null) {
                                        player.seekTo(resume);
                                        player.prepare();
                                        player.setPlayWhenReady(true);
                                    }
                                } catch (Exception ignored) {
                                    /* 自愈失败：下一次错误会上报到 JS */
                                }
                            }, delay);
                            return;
                        }

                        JSObject d = new JSObject();
                        d.put("message", msg);
                        d.put("errorCode", error.errorCode);
                        d.put("type", typeName);
                        notifyListeners("error", d);
                    }
                });

                player.setMediaItem(MediaItem.fromUri(url));
                if (startMs > 0) player.seekTo((long) startMs);
                if (videoSurface == null && surfaceView.getHolder().getSurface() != null
                    && surfaceView.getHolder().getSurface().isValid()) {
                    videoSurface = surfaceView.getHolder().getSurface();
                }
                if (videoSurface != null) {
                    player.setVideoSurface(videoSurface);
                    player.prepare();
                    player.setPlayWhenReady(true);
                } else {
                    pendingStart = true; // Surface 尚未就绪：onSurfaceTextureAvailable 接棒
                }
                ioRetryCount = 0; // 新的一次 load：重置 IO 自愈计数
                call.resolve();
            } catch (Exception e) {
                call.reject("load 失败: " + e.getMessage());
            }
        });
    }

    /** JS 同步 <video 占位区> 几何：css px × dpr = 原生 px */
    @PluginMethod
    public void layout(PluginCall call) {
        double dpr = call.getDouble("dpr", 1.0);
        final int x = (int) Math.round(call.getDouble("x", 0.0) * dpr);
        final int y = (int) Math.round(call.getDouble("y", 0.0) * dpr);
        final int w = (int) Math.round(call.getDouble("w", 1.0) * dpr);
        final int h = (int) Math.round(call.getDouble("h", 1.0) * dpr);
        final boolean stretch = call.getBoolean("stretch", false);
        getActivity().runOnUiThread(() -> {
            // P9.44：JS 常在 load() 之前就同步几何（nativePlayer.js / PlayerView 挂载时），
            // 此时渲染层还没建。原实现直接 resolve 丢弃矩形 → 新建的渲染层
            // 以 MATCH_PARENT 加入，首帧全屏拉伸，要等下一次同步才纠正。
            // 这里先记下目标矩形，随后新建渲染层时会立即 applyVideoFrame()。
            if (surfaceView == null) {
                tgtX = x;
                tgtY = y;
                tgtW = w;
                tgtH = h;
                stretchMode = stretch;
                call.resolve();
                return;
            }
            tgtX = x;
            tgtY = y;
            tgtW = w;
            tgtH = h;
            stretchMode = stretch;
            applyVideoFrame();
            call.resolve();
        });
    }

    /**
     * 按视频帧几何在占位区内布局（P9.30 D46 + P9.34 D50）：
     *  - 默认：scale = min(tgtW/vw, tgtH/vh) 等比缩放 letterbox 居中（修拉伸变形）
     *  - stretchMode：铺满占位区（视频适应模式=全屏拉伸）
     *  - 未知帧尺寸：铺满占位区。须在 UI 线程调用。
     */
    private void applyVideoFrame() {
        if (surfaceView == null) return;
        int x = tgtX, y = tgtY, w = tgtW, h = tgtH;
        if (!stretchMode && videoW > 0 && videoH > 0 && tgtW > 0 && tgtH > 0) {
            double vw = videoW * videoSar;
            double vh = videoH;
            if (videoRot == 90 || videoRot == 270) {
                double t = vw;
                vw = vh;
                vh = t;
            }
            double scale = Math.min(tgtW / vw, tgtH / vh);
            w = Math.max(1, (int) Math.round(vw * scale));
            h = Math.max(1, (int) Math.round(vh * scale));
            x = tgtX + (tgtW - w) / 2;
            y = tgtY + (tgtH - h) / 2;
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, w), Math.max(1, h));
        lp.leftMargin = Math.max(0, x);
        lp.topMargin = Math.max(0, y);
        surfaceView.setLayoutParams(lp);
    }

    /**
     * P9.41 D55：把 Capacitor WebView 提到 content 顶层并设为透明背景。
     * FrameLayout 中「后添加者在上层」，层级必须恒为：
     *   android.R.id.content
     *     └─ SurfaceView（底：只渲染视频画面）
     *        └─ WebView（上：页面 UI + 弹幕 canvas，背景透明，视频区透出下层画面）
     * 顺序一旦颠倒，弹幕就会被视频盖住（v1.3.11~v1.3.20 的已知限制）。
     */
    private void bringWebViewToFront(ViewGroup content) {
        android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        // P9.44 修复（阻塞级）：Capacitor 的 WebView 挂在 bridge layout 的 CoordinatorLayout 里，
        // **不是** android.R.id.content 的直接子视图。原先 `if (wv.getParent() != content)
        // content.addView(wv)` 恒真 → 对已有父视图的子视图 addView 抛
        // IllegalStateException("The specified child already has a parent")，被 load() 的
        // catch(Exception) 吞成 "load 失败"，整个原生起播被打断（只能落到 WebView/MSE 降级，
        // 而 WebView 内核在 Z7X 上已知崩溃）。content.bringChildToFront(wv) 同理无效
        // （indexOfChild 返回 -1，静默失败）。
        // 正确做法：绝不重挂载 WebView；仅在它需要保序时在**它自己的父布局**内提到最前。
        wv.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        android.view.ViewParent parent = wv.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).bringChildToFront(wv);
        }
        wv.invalidate();
    }

    /**
     * P9.44：把播放器当前的 Surface 解绑并释放（切清晰度/退后台/销毁前必调）。
     * 不释放会让 MediaCodec 继续向已废弃的 BufferQueue 写帧 → 硬解崩溃/内存累积。
     */
    private void releaseSurface() {
        if (player != null) {
            try {
                player.setVideoSurface(null);
            } catch (Exception ignored) { /* 播放器已释放 */ }
        }
        if (videoSurface != null) {
            videoSurface.release();
            videoSurface = null;
        }
        surfaceReady = false;
    }

    /** 隐藏渲染层（离开原生播放时调用） */
    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (surfaceView != null) surfaceView.setVisibility(View.GONE);
            call.resolve();
        });
    }

    /**
     * 渲染层调暗（P9.30 D46 Legacy / P9.41 D55 起失效）：OSD/面板/进度 HUD 显示时把
     * 视频层降到半透明。该方案建立在「渲染层盖在 WebView 之上、浮层原本全被挡」的前提上；
     * D55 翻转层级后 WebView 浮层与弹幕本就可见，JS 侧已不再调用，此处仅保留接口。
     * alpha 0~1：1 恢复不透明。
     */
    @PluginMethod
    public void dim(PluginCall call) {
        final float alpha = (float) (double) call.getDouble("alpha", 1.0);
        getActivity().runOnUiThread(() -> {
            if (surfaceView != null) {
                surfaceView.setAlpha(Math.max(0f, Math.min(1f, alpha)));
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) player.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) player.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        double ms = call.getDouble("ms", 0.0);
        getActivity().runOnUiThread(() -> {
            if (player != null) player.seekTo((long) ms);
            call.resolve();
        });
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        double speed = call.getDouble("speed", 1.0);
        getActivity().runOnUiThread(() -> {
            if (player != null) player.setPlaybackParameters(new androidx.media3.common.PlaybackParameters((float) speed));
            call.resolve();
        });
    }

    /** 进度查询（JS 每 500ms 轮询一次驱动 timeupdate 语义） */
    @PluginMethod
    public void getProgress(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject d = new JSObject();
            if (player != null) {
                long pos = player.getCurrentPosition();
                // P9.44：出错/IDLE 时 getCurrentPosition() 会返回 0，JS 侧会把 0 写进观看历史
                // （表现为"从来没看过进度"）。这里保留最后一次有效进度兜底。
                if (pos > 0) lastKnownPos = pos;
                d.put("position", pos > 0 ? pos : lastKnownPos);
                d.put("duration", player.getDuration());
                d.put("playing", player.isPlaying());
            } else {
                d.put("position", 0);
                d.put("duration", 0);
                d.put("playing", false);
            }
            call.resolve(d);
        });
    }

    @PluginMethod
    public void release(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            releaseInternal();
            call.resolve();
        });
    }

    /**
     * 模拟器环境检测（P9.26 D42）：MuMu/AVD/夜神等 PC 模拟器的视频解码走 GPU 转译，
     * WebView 内核与硬件解码器输出常见纯绿帧（色彩格式不兼容），软件解码器路径稳定。
     * JS 侧启动时据此自动切换原生软解内核（用户显式选过解码器则尊重其选择）。
     */
    @PluginMethod
    public void isEmulator(PluginCall call) {
        JSObject d = new JSObject();
        d.put("value", detectEmulator());
        call.resolve(d);
    }

    /** 启发式检测：Build 字段含模拟器特征串即判定（低误报：真机不含 generic/vbox/ranchu 等）。
     *  P9.29 D45 补充：x86/x86_64 ABI 必为 PC 模拟器（电视/投影真机全是 ARM）——
     *  MuMu 等模拟器 Build 特征串可能不带常见关键字，ABI 是兜底强信号。 */
    private boolean detectEmulator() {
        try {
            String[] abis = android.os.Build.SUPPORTED_ABIS;
            if (abis != null) {
                for (String abi : abis) {
                    if (abi != null && abi.startsWith("x86")) return true;
                }
            }
        } catch (Exception ignored) { /* 特性缺失按字段判定 */ }
        String[] fields = {
            safe(android.os.Build.PRODUCT),
            safe(android.os.Build.MODEL),
            safe(android.os.Build.MANUFACTURER),
            safe(android.os.Build.HARDWARE),
            safe(android.os.Build.BOARD),
            safe(android.os.Build.FINGERPRINT)
        };
        String[] needles = {
            "generic", "emulator", "sdk_gphone", "google_sdk", "vbox", "genymotion",
            "ranchu", "goldfish", "mumu", "netease", "nox", "bluestacks", "ldplay",
            "boloop", "titan", "x86"
        };
        for (String f : fields) {
            for (String n : needles) {
                if (f.contains(n)) return true;
            }
        }
        return false;
    }

    private String safe(String s) {
        return s == null ? "" : s.toLowerCase();
    }

    /** 内部复位：销毁播放器、摘除渲染层（load/release 双入口复用） */
    /**
     * 复位播放器（切清晰度/分P/退出播放都会走）
     *
     * P9.44 长播内存修复：原实现每次都把渲染层从视图树 remove 并置 null，
     * 于是「多集连播 = 反复新建渲染层 + Surface，且旧 Surface 从不 release」，
     * 是长时间观看内存持续增长与硬解崩溃的主要来源。
     * 现在渲染层常驻复用（仅 GONE），Surface 摘挂走 releaseSurface()；
     * 彻底销毁只在 handleOnDestroy 做。
     */
    private void releaseInternal() {
        rendering = false; // P9.29 D45：触摸拦截随渲染层一起摘除
        videoW = 0;
        videoH = 0;
        videoSar = 1f;
        videoRot = 0;
        // 顺序：先摘/释放 Surface，再 stop/release，避免 MediaCodec 继续写废弃队列
        releaseSurface();
        if (player != null) {
            try {
                player.stop();
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
        if (surfaceView != null) {
            surfaceView.setVisibility(View.GONE); // 复用，不 remove（保持 index 0 的层级）
        }
        pendingStart = false;
        ioRetryCount = 0;
    }

    /** P9.44：退后台/息屏时停止解码并释放 Surface（ExoPlayer 默认会在后台继续解码） */
    @Override
    protected void handleOnPause() {
        if (player != null) {
            try {
                lastKnownPos = player.getCurrentPosition();
                player.pause();
                releaseSurface();
            } catch (Exception ignored) { /* 播放器已释放 */ }
        }
    }

    /** P9.44：回到前台恢复画面 */
    @Override
    protected void handleOnResume() {
        rendering = false; // 桥重建场景：抹掉可能残留的静态标记
        if (player == null || surfaceView == null) return;
        try {
            Surface s = surfaceView.getHolder().getSurface();
            if (s != null && s.isValid() && videoSurface == null) {
                videoSurface = s;
            }
            if (videoSurface != null) {
                surfaceReady = true;
                player.setVideoSurface(videoSurface);
                if (lastKnownPos > 0) player.seekTo(lastKnownPos);
                player.setPlayWhenReady(true);
            }
        } catch (Exception ignored) { /* 下次 load 会重建 */ }
    }

    @Override
    protected void handleOnDestroy() {
        releaseInternal();
        // 真正销毁时才从视图树摘除渲染层
        if (surfaceView != null) {
            android.view.ViewParent parent = surfaceView.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(surfaceView);
            surfaceView = null;
        }
    }
}
