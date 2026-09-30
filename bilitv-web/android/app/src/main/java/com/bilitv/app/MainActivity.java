package com.bilitv.app;

import android.os.Bundle;
import android.view.MotionEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 插件注册必须在 super.onCreate 之前（桥在 super 初始化时构建，晚注册会报
        // "plugin is not implemented on android"——P9.19 实测）
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(DeviceProbePlugin.class); // P9.27 D43：硬件检测与跑分
        super.onCreate(savedInstanceState);
    }

    /**
     * P9.29 D45：原生渲染层触摸拦截。
     * 原生播放时 TextureView 盖在 WebView 视频区上方，Android 派发链里点击落在
     * 渲染层（MuMu 实测 setClickable(false) 不能保证穿透，用户点击无任何反馈）。
     * 在 Activity 分发口直接把整条事件流转派给 WebView——窗口坐标即 WebView
     * 全屏坐标，无需偏移换算；渲染层之外区域的点击行为不变（WebView 同样处理）。
     * rendering=false（非原生播放）走正常分发。
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (NativePlayerPlugin.rendering && getBridge() != null && getBridge().getWebView() != null) {
            return getBridge().getWebView().dispatchTouchEvent(ev);
        }
        return super.dispatchTouchEvent(ev);
    }
}
