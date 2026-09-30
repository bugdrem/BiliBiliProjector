#!/usr/bin/env python3
"""把 BiliBiliProjector 的「代码 + 文档」同步到已克隆的远端工作副本。

用法：
    python scripts/publish-to-github.py <已 clone 的仓库目录>

只复制源码与文档，跳过本机工具链 / 依赖 / 构建产物 / 交付 APK /  Pictures 预览。
"""
import os
import shutil
import sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 需要整体跳过的目录（相对项目根）
SKIP_DIRS = {
    ".git",
    ".tools",             # 本机 JDK / Android SDK / 下载缓存（11G）
    ".workbuddy",         # 本机项目数据
    ".android",           # 模拟器 / AVD
    "node_modules",       # npm 依赖
    "dist",               # vite 构建产物
    "releases",           # 交付 APK（172M）
    "apk",                # 早期交付 APK
    "icon-preview",       # 图标生成预览图
    "capacitor-cordova-android-plugins",  # cap sync 生成，由 android/.gitignore 忽略
    ".gradle",
    "build",
    "captures",
    ".externalNativeBuild",
    ".cxx",
    ".idea",
}

# 需要跳过的文件（后缀 / 相对路径）
SKIP_SUFFIX = (".apk", ".aab", ".dex", ".jks", ".keystore", ".hprof", ".iml")
SKIP_PATHS = {
    "bilitv-web/android/local.properties",        # 本机 SDK 绝对路径
    "bilitv-web/android/app/src/main/assets/public",  # cap sync 复制的 web 产物
    "bilitv-web/android/app/src/main/res/xml/config.xml",  # cap sync 生成
}


def copy_tree(src, dst):
    for name in sorted(os.listdir(src)):
        sp = os.path.join(src, name)
        rel = os.path.relpath(sp, SRC).replace("\\", "/")
        if rel in SKIP_PATHS or name in SKIP_DIRS:
            continue
        dp = os.path.join(dst, name)
        if os.path.isdir(sp):
            os.makedirs(dp, exist_ok=True)
            copy_tree(sp, dp)
        else:
            if rel.endswith(SKIP_SUFFIX):
                continue
            shutil.copy2(sp, dp)


def main():
    if len(sys.argv) < 2:
        print("usage: publish-to-github.py <repo-clone-dir>")
        return 1
    dst = os.path.abspath(sys.argv[1])
    if not os.path.isdir(os.path.join(dst, ".git")):
        print("error: %s is not a git repo" % dst)
        return 1
    for item in sorted(os.listdir(dst)):
        if item in (".git", ".gitignore", "README.md"):
            continue
        p = os.path.join(dst, item)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(dst, exist_ok=True)
    for item in (".gitignore", "README.md"):
        shutil.copy2(os.path.join(SRC, item), os.path.join(dst, item)) \
            if os.path.exists(os.path.join(SRC, item)) else None
    copy_tree(SRC, dst)
    total = sum(len(f) for _, _, f in os.walk(dst))
    print("copied %d files into %s" % (total, dst))
    return 0


if __name__ == "__main__":
    sys.exit(main())
