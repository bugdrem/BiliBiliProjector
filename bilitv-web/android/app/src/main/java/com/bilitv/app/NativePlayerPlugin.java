package com.bilitv.app;

import android.view.Surface;
import android.view.TextureView;
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
    private TextureView textureView;
    private String decoderMode = "hw"; // hw=硬件解码（默认） / sw=软解码
    private boolean surfaceReady = false;
    private boolean pendingStart = false;

    // 视频帧几何（P9.30 D46）：用于在占位区内等比缩放居中（修复拉伸变形）
    private int tgtX, tgtY, tgtW, tgtH; // 占位区（设备 px）
    private int videoW = 0, videoH = 0; // 视频原始宽高
    private float videoSar = 1f; // 像素宽高比
    private int videoRot = 0; // 未应用的旋转角
    private boolean stretchMode = false; // P9.34 D50：true=拉伸铺满占位区（视频适应模式=全屏拉伸）

    /**
     * 原生渲染进行中（P9.29 D45）：MainActivity.dispatchTouchEvent 据此把触摸
     * 直接派发给 WebView，绕过盖在视频区上方的 TextureView（点击丢失根治）。
     * load 置 true；release/hide 置 false。volatile 保证跨线程可见。
     */
    public static volatile boolean rendering = false;

    /**
     * 按模式构造解码器选择器（真实 API：接口方法为 getDecoderInfos(mimeType, secure, tunneling)，
     * 自查全系统编解码器后按 MediaCodecInfo.hardwareAccelerated/softwareOnly 过滤；
     * 目标类别为空时回退系统默认顺序，保证可播）
     */
    private MediaCodecSelector buildSelector() {
        final String mode = decoderMode;
        return (mimeType, requiresSecure, requiresTunneling) -> {
            List<MediaCodecInfo> infos =
                MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, requiresSecure, requiresTunneling);
            List<MediaCodecInfo> picked = new ArrayList<>();
            for (MediaCodecInfo info : infos) {
                if ("sw".equals(mode) && info.softwareOnly) picked.add(info);
                if ("hw".equals(mode) && info.hardwareAccelerated) picked.add(info);
            }
            return picked.isEmpty() ? infos : picked;
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
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(30000, 60000, 2500, 5000)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build();
        return new ExoPlayer.Builder(getContext(), renderersFactory)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
            .build();
    }

    /** TextureView 就绪后把 Surface 交给播放器 */
    private final TextureView.SurfaceTextureListener surfaceListener =
        new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(android.graphics.SurfaceTexture surface, int w, int h) {
                surfaceReady = true;
                if (player != null) {
                    player.setVideoSurface(new Surface(surface));
                    if (pendingStart) {
                        pendingStart = false;
                        player.prepare();
                        player.setPlayWhenReady(true);
                    }
                }
            }

            @Override
            public void onSurfaceTextureSizeChanged(android.graphics.SurfaceTexture surface, int w, int h) {}

            @Override
            public boolean onSurfaceTextureDestroyed(android.graphics.SurfaceTexture surface) {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(android.graphics.SurfaceTexture surface) {}
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

        // 关键：TextureView/ExoPlayer 全部 UI 与播放器操作必须在主线程
        // （插件方法运行在 CapacitorPlugins 线程，直接触碰 view 崩溃——P9.19 实测）
        getActivity().runOnUiThread(() -> {
            try {
                releaseInternal(); // 复位旧实例

                // 渲染层：挂在 content 底层（WebView 之下）—— P9.41 D55 层级翻转
                // 历史做法（≤P9.38）把 TextureView 加在顶层盖住 WebView，WebView 内的
                // 弹幕 canvas / OSD / 控制条全部被视频遮住（v1.3.11 起的已知限制）。
                // 现改为：TextureView 在下（只负责渲染视频画面），WebView 在上且背景透明，
                // 页面在原生播放态把 body 与视频区背景置 transparent「挖洞」，
                // 于是下层视频从洞里透出、上层 WebView 里的弹幕浮在视频之上（层级正确）。
                if (textureView == null) {
                    textureView = new TextureView(getContext());
                    textureView.setSurfaceTextureListener(surfaceListener);
                    textureView.setOpaque(false);
                    // P9.26 D42：渲染层纯展示——不响应焦点，避免抢遥控器按键
                    textureView.setFocusable(false);
                    // P9.28 D44：渲染层盖在 WebView 视频区上方，模拟器/触屏的点击会落在
                    // 最顶层的 TextureView 上（不可点击也不一定穿透——MuMu 实测点击无反馈）。
                    // 手动把触摸事件转发给 WebView（补回父级 offset 后派发），返回 true 消费
                    // 本层事件防止父级二次派发。
                    textureView.setOnTouchListener((v, event) -> {
                        android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                        if (wv == null || textureView == null) return false;
                        android.view.MotionEvent fwd = android.view.MotionEvent.obtain(event);
                        fwd.offsetLocation(textureView.getLeft(), textureView.getTop());
                        wv.dispatchTouchEvent(fwd);
                        fwd.recycle();
                        return true;
                    });
                    ViewGroup content = getActivity().findViewById(android.R.id.content);
                    // index 0 = 插到所有子视图最前（FrameLayout 后加者在上层）→ 渲染层沉底
                    content.addView(textureView, 0);
                }
                // 每次原生播放都重新确认 WebView 置顶 + 透明（防止其它视图抢上层）
                bringWebViewToFront(getActivity().findViewById(android.R.id.content));
                textureView.setVisibility(View.VISIBLE);
                surfaceReady = textureView.isAvailable();
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
                        JSObject d = new JSObject();
                        d.put("message", error.getMessage() == null ? "unknown" : error.getMessage());
                        notifyListeners("error", d);
                    }
                });

                player.setMediaItem(MediaItem.fromUri(url));
                if (startMs > 0) player.seekTo((long) startMs);
                if (surfaceReady) {
                    player.setVideoSurface(new Surface(textureView.getSurfaceTexture()));
                    player.prepare();
                    player.setPlayWhenReady(true);
                } else {
                    pendingStart = true; // Surface 尚未就绪：onSurfaceTextureAvailable 接棒
                }
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
            if (textureView == null) {
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
        if (textureView == null) return;
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
        textureView.setLayoutParams(lp);
    }

    /**
     * P9.41 D55：把 Capacitor WebView 提到 content 顶层并设为透明背景。
     * FrameLayout 中「后添加者在上层」，层级必须恒为：
     *   android.R.id.content
     *     └─ TextureView（底：只渲染视频画面）
     *        └─ WebView（上：页面 UI + 弹幕 canvas，背景透明，视频区透出下层画面）
     * 顺序一旦颠倒，弹幕就会被视频盖住（v1.3.11~v1.3.20 的已知限制）。
     */
    private void bringWebViewToFront(ViewGroup content) {
        android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (content == null || wv == null) return;
        if (wv.getParent() != content) content.addView(wv);
        // 透明背景：WebView 自身不绘制底色，才能透出下层的 TextureView 画面
        wv.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        content.bringChildToFront(wv);
        content.invalidate();
    }

    /** 隐藏渲染层（离开原生播放时调用） */
    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (textureView != null) textureView.setVisibility(View.GONE);
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
            if (textureView != null) {
                textureView.setAlpha(Math.max(0f, Math.min(1f, alpha)));
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
                d.put("position", player.getCurrentPosition());
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
    private void releaseInternal() {
        rendering = false; // P9.29 D45：触摸拦截随渲染层一起摘除
        videoW = 0;
        videoH = 0;
        videoSar = 1f;
        videoRot = 0;
        if (player != null) {
            try {
                player.stop();
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
        if (textureView != null) {
            ViewGroup parent = (ViewGroup) textureView.getParent();
            if (parent != null) parent.removeView(textureView);
            textureView = null;
        }
        surfaceReady = false;
        pendingStart = false;
    }

    @Override
    protected void handleOnDestroy() {
        releaseInternal();
    }
}
