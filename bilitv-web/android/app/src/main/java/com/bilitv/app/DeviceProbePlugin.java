package com.bilitv.app;

import android.app.ActivityManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 设备探测插件（P9.27 D43）：设置页「系统环境及硬件检测 + 跑分」后端。
 *
 * 职责：
 *  - getInfo()：设备/系统/SoC/内存/GPU 版本/模拟器标记 + AVC/HEVC/AV1 硬件解码器支持
 *  - benchCpu()：多核定时长（~1.2s）CPU 基准，返回 Mops/s 跑分
 *
 * 跑分用于匹配播放编码/解码器推荐（JS 侧 analyzeDevice 出结论）：
 *  - 硬解支持优先（HEVC/AV1 硬解 → 对应编码 + 原生硬解）
 *  - 无硬解时按 CPU 分数决定软解可行性；模拟器强制软解（GPU 转译绿屏，D42）
 */
@CapacitorPlugin(name = "DeviceProbe")
public class DeviceProbePlugin extends Plugin {

    /** 跑分时长（ms）：短到 TV 用户无感，长到分数稳定 */
    private static final long BENCH_MS = 1200;
    /** 每次内层循环计的“操作数”（3 次 xorshift + 1 次 add ≈ 8 计） */
    private static final int OPS_PER_ITER = 8;

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject d = new JSObject();
        d.put("manufacturer", nz(Build.MANUFACTURER));
        d.put("model", nz(Build.MODEL));
        d.put("androidVersion", nz(Build.VERSION.RELEASE));
        d.put("apiLevel", Build.VERSION.SDK_INT);
        // SoC：API 31+ 有官方字段；低版本退 Build.HARDWARE
        String soc = "";
        if (Build.VERSION.SDK_INT >= 31) {
            soc = nz(Build.SOC_MODEL);
            if (soc.isEmpty()) soc = nz(Build.HARDWARE);
        } else {
            soc = nz(Build.HARDWARE);
        }
        d.put("soc", soc);
        d.put("board", nz(Build.BOARD));
        // ABI（P9.29 D45）：诊断面板展示——x86 即模拟器，ARM 为真机
        d.put("abi", Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0 ? nz(Build.SUPPORTED_ABIS[0]) : "");

        int cores = Runtime.getRuntime().availableProcessors();
        d.put("cores", cores);

        try {
            ActivityManager am = (ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            d.put("memGB", Math.round(mi.totalMem / 1024.0 / 1024.0 / 1024.0 * 10) / 10.0);
            android.content.pm.ConfigurationInfo cfg = am.getDeviceConfigurationInfo();
            d.put("glEs", cfg != null ? cfg.getGlEsVersion() : "");
        } catch (Exception e) {
            d.put("memGB", 0);
            d.put("glEs", "");
        }

        d.put("isEmulator", detectEmulator());

        // 硬件解码器支持（视频解码，非 encoder）
        boolean avc = false, hevc = false, av1 = false;
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
            for (MediaCodecInfo info : list.getCodecInfos()) {
                if (info.isEncoder() || !isHardwareDecoder(info)) continue;
                for (String t : info.getSupportedTypes()) {
                    if ("video/avc".equals(t)) avc = true;
                    else if ("video/hevc".equals(t)) hevc = true;
                    else if ("video/av01".equals(t)) av1 = true;
                }
            }
        } catch (Exception ignored) {
            // 枚举失败按全不支持处理（推荐逻辑会回退默认解码器）
        }
        d.put("hwAvc", avc);
        d.put("hwHevc", hevc);
        d.put("hwAv1", av1);
        call.resolve(d);
    }

    /**
     * 多核 CPU 跑分：N 线程（min(核数,8)）各跑 BENCH_MS 定时长循环，
     * 混合 xorshift 整数运算 + 周期性 sqrt（防 JIT 死码消除），返回 Mops/s。
     * 运行在 CapacitorPlugins 线程（非主线程），阻塞 1.2s 无碍。
     */
    @PluginMethod
    public void benchCpu(PluginCall call) {
        final int threads = Math.max(1, Math.min(Runtime.getRuntime().availableProcessors(), 8));
        final long deadline = System.nanoTime() + BENCH_MS * 1_000_000L;
        final long[] results = new long[threads];
        Thread[] pool = new Thread[threads];
        for (int t = 0; t < threads; t++) {
            final int idx = t;
            pool[t] = new Thread(() -> {
                long acc = 2463534242L + idx * 7919L;
                long ops = 0;
                long cnt = idx; // 各线程起始相位错开
                while (System.nanoTime() < deadline) {
                    for (int i = 0; i < 1024; i++) {
                        acc ^= acc << 13;
                        acc ^= acc >>> 7;
                        acc ^= acc << 17;
                        cnt++;
                        if ((cnt & 255) == 0) acc += (long) Math.sqrt(cnt);
                    }
                    ops += 1024L * OPS_PER_ITER;
                    if (acc == 42L) results[idx] = -1; // 防死码消除（几乎不可达）
                }
                results[idx] = Math.max(results[idx], 0) + ops;
            });
            pool[t].start();
        }
        long total = 0;
        for (int t = 0; t < threads; t++) {
            try { pool[t].join(); } catch (InterruptedException ignored) { }
            total += results[t];
        }
        double mops = total / (BENCH_MS / 1000.0) / 1_000_000.0;
        JSObject d = new JSObject();
        d.put("score", Math.round(mops));
        d.put("threads", threads);
        d.put("benchMs", BENCH_MS);
        call.resolve(d);
    }

    /**
     * 硬件解码器判定：API 29+ 用官方 isHardwareAccelerated()；
     * 低版本按名称启发式（OMX.google / c2.android 系为软解）。
     */
    private boolean isHardwareDecoder(MediaCodecInfo info) {
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                return info.isHardwareAccelerated();
            } catch (Exception ignored) { /* 落到名称启发式 */ }
        }
        String n = info.getName() == null ? "" : info.getName().toLowerCase();
        return !(n.contains("omx.google") || n.contains("c2.android") || n.contains("sw"));
    }

    /** 模拟器启发式（与 NativePlayerPlugin 同套特征串，独立持有避免跨插件耦合）。
     *  P9.29 D45 补充 x86 ABI 兜底（MuMu 特征串可能不在关键字表内）。 */
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
            nz(Build.PRODUCT), nz(Build.MODEL), nz(Build.MANUFACTURER),
            nz(Build.HARDWARE), nz(Build.BOARD), nz(Build.FINGERPRINT)
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

    private String nz(String s) {
        return s == null ? "" : s;
    }
}
