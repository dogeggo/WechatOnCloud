# WechatOnCloud —— 在浏览器里访问服务端应用实例
# 基于 linuxserver 的 KasmVNC 基础镜像（多架构 amd64/arm64）：
# 自带 Xvfb + openbox + KasmVNC + web 客户端(3000/3001)
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

# 应用本体不再在构建时下载/安装，改为运行时由面板点击下载、解压到数据卷 /config。
# 构建时只装：中文字体、语言环境、下载工具，以及桌面客户端运行所需的系统库。
ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    # 中文字体（否则界面/消息显示方块）+ 语言环境 + 下载/解压工具
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates locales dpkg \
        xz-utils \
        fontconfig \
        fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk fonts-noto-color-emoji \
        libnss3 libgbm1 libasound2 libxss1 \
        chromium xdg-utils dbus dbus-x11 \
        python3-dbus python3-gi gir1.2-glib-2.0 python3-pyatspi at-spi2-core \
        xdotool xclip wmctrl; \
    sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 本地打包 HarmonyOS Sans SC，避免构建镜像时联网下载字体。
COPY fonts/harmonyos-sans/ /usr/local/share/fonts/harmonyos-sans/
RUN chmod 644 /usr/local/share/fonts/harmonyos-sans/*

# 明确中文字体优先级：应用实例内的 Qt/Chromium/GTK 通过 fontconfig 选字形。
# 优先使用更现代的 HarmonyOS Sans SC，Noto CJK / 文泉驿保留为兜底。
COPY fonts/woc-cjk-font.conf /etc/fonts/conf.d/99-woc-cjk-font.conf
RUN fc-cache -f

# 微信运行时需要、但官方 deb 未声明的额外库（单独成层，避免动到上面缓存的安装层）。
# 微信原生版是 Qt 程序，依赖一组 xcb 平台库；libxcb-cursor0 由 Qt 动态 dlopen，ldd 查不到，需主动装。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libatomic1 \
        libxdamage1 \
        libxkbcommon-x11-0 \
        libxcb-icccm4 \
        libxcb-image0 \
        libxcb-keysyms1 \
        libxcb-render-util0 \
        libxcb-xkb1 \
        libxcb-cursor0 \
        # WeChatAppEx 是 Chromium 内核，需 GTK3 全家桶 + 一组 X 扩展 + cups
        libgtk-3-0 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libxcomposite1 \
        libxrandr2 \
        libxfixes3 \
        libxtst6 \
        libxshmfence1 \
        libdrm2; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    QTWEBENGINE_DISABLE_SANDBOX=1 \
    QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox \
    BROWSER=/usr/local/bin/woc-open-url

# 本项目不依赖实例容器内的 cron / dockerd；从 s6 user bundle 移除，避免常驻空跑进程。
RUN rm -f \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-cron \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-docker

# 微信内打开外链时可能走系统 URL handler，而不是 app-defs.sh 中的 Chromium 启动命令。
# 默认 URL handler 先尝试把 http/https 上报给面板，由用户端浏览器打开；无人接管时回退到容器内 Chromium。
COPY browser/woc-browser browser/woc-open-url /usr/local/bin/
COPY browser/woc-browser.desktop /usr/share/applications/woc-browser.desktop
RUN chmod 755 /usr/local/bin/woc-browser /usr/local/bin/woc-open-url && \
    chmod 644 /usr/share/applications/woc-browser.desktop && \
    update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/woc-open-url 200 && \
    update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/woc-open-url 200

# 改 KasmVNC web 客户端的 webpack 产物 dist/*.bundle.js：
#  (1) 默认开启 IME 输入模式：本地（客户端）输入法打中文，拼音联想在本地完成、只把成品汉字
#      发进容器，无需容器内装 IME。默认值仅在浏览器未存过该设置时生效，不覆盖用户手动改过的偏好。
#  (2) 修复 noVNC 中文 IME 输入：原实现靠隐藏 textarea 差分逐字符重发 keysym，会泄漏中间拼音、
#      累积不 reset、退格风暴，导致大量丢字 / ~21 字卡住 / 跨浏览器不稳。改为只在 compositionend
#      用 e.data 直发成品字符串（详见 woc-www-patch.sh / woc-ime.pl）。
# 注意：实际加载的是 webpack 产物 dist/main.bundle.js（app/ui.js 是未打包源码、运行时不加载），故必须改 bundle。
COPY web/woc-www-patch.sh web/woc-ime.pl web/woc-canvas.pl /woc/
RUN chmod +x /woc/woc-www-patch.sh && /woc/woc-www-patch.sh

# 容器内通知桥：接管 org.freedesktop.Notifications，把 QQ/微信发出的桌面通知转交面板 SSE。
# baseimage 自带 dunst 的 D-Bus 激活；通知桥重启空窗期如果触发通知，dunst 会抢占通知名。
# 这里直接卸载 dunst，并删除残留激活文件，确保只有 woc-notifyd 能提供桌面通知服务。
RUN apt-get purge -y dunst 2>/dev/null || true; \
    rm -f /usr/share/dbus-1/services/org.knopwob.dunst.service; \
    rm -rf /var/lib/apt/lists/*
COPY notify/woc-notifyd.py /usr/local/bin/woc-notifyd
RUN chmod 755 /usr/local/bin/woc-notifyd

# 应用下载/解压控制脚本（运行时由面板经 docker exec 触发，状态写入数据卷 /config/.woc-state）
COPY app/deb-app-ctl.sh app/wechat-ctl.sh app/qq-ctl.sh app/telegram-ctl.sh /woc/
RUN chmod 755 /woc/deb-app-ctl.sh /woc/wechat-ctl.sh /woc/qq-ctl.sh /woc/telegram-ctl.sh

# 多应用：应用定义 + 通用安装/状态控制。deb 应用委托各自 ctl，Chromium 随镜像就绪。
COPY app/app-defs.sh app/app-ctl.sh /woc/
RUN chmod 644 /woc/app-defs.sh && chmod 755 /woc/app-ctl.sh

# openbox 会话启动时执行此脚本：等待应用就绪 + 常驻拉起应用 + 最小化自动复原看守
COPY init/autostart /defaults/autostart
RUN chmod +x /defaults/autostart

# 启动钩子（00）：给每个实例唯一且持久的 machine-id，避免所有实例共用镜像里烤死的同一个，
# 触发客户端"设备农场"风控导致登录即被强制退出。须在 autostart（拉起应用）之前执行，故用 00 前缀。
COPY init/woc-identity.sh /custom-cont-init.d/00-woc-identity
RUN chmod +x /custom-cont-init.d/00-woc-identity

# 启动钩子（01）：每次启动用镜像内最新 autostart 覆盖数据卷旧副本（否则旧实例升级后用不上新逻辑）
COPY init/woc-update-autostart /custom-cont-init.d/01-woc-autostart
RUN chmod +x /custom-cont-init.d/01-woc-autostart

# 启动钩子（02）：把容器环境 WOC_APP_TYPE 写入 /config/.woc-app，供 autostart 选择启动哪个应用。
COPY init/woc-app-init.sh /custom-cont-init.d/02-woc-app
RUN chmod 755 /custom-cont-init.d/02-woc-app

# 启动钩子（03）：容器里没有 systemd，不会自动拉起 D-Bus system bus。
# Chromium 会访问 system/session bus 查询桌面、电源与通知能力；显式启动可避免外链浏览器启动时报连接失败。
COPY init/woc-dbus.sh /custom-cont-init.d/03-woc-dbus
RUN chmod 755 /custom-cont-init.d/03-woc-dbus

# 启动钩子（04）：按实例档位写入 KasmVNC 服务端编码配置。更改后由面板重建容器生效。
COPY init/woc-vnc-profile.sh /custom-cont-init.d/04-woc-vnc-profile
RUN chmod 755 /custom-cont-init.d/04-woc-vnc-profile

# 3000 = HTTP web 客户端, 3001 = HTTPS
EXPOSE 3000 3001
