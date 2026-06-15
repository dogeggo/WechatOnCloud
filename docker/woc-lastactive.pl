# perl -0777 -pe 补丁脚本（被 woc-www-patch.sh 引用）。
# KasmVNC 的空闲 keepalive 定时器在部分版本里会在 UI.rfb 已被断开清理后继续读取
# UI.rfb.lastActiveAt，导致 iframe 内 fatal error。这里只给已知源码形态加防御。

s~\Qif (UI.rfb) {
                    const timeSinceLastActivityInS = (Date.now() - UI.rfb.lastActiveAt) / 1000;\E~if (UI.rfb && Number.isFinite(UI.rfb.lastActiveAt)) { /* WOC-LASTACTIVE */
                    const timeSinceLastActivityInS = (Date.now() - UI.rfb.lastActiveAt) / 1000;~g;
