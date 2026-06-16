# VNC 性能优化分析

分析时间：2026-06-16  
项目路径：`/root/docker/WechatOnCloud`  
运行环境：Alpine 宿主，Docker 已部署，当前宿主约 4 核 CPU、5.8 GiB 内存、2 GiB swap。

## 结论摘要

当前项目的 VNC 链路已经做过一轮基础优化：KasmVNC 服务端有 `speed / balanced / quality` 编码档位，前端 noVNC 有 `省流 / 均衡 / 清晰` 流设置，并且后端限制每个实例只保留一个图形 WebSocket。面板代理本身不是当前主要瓶颈，运行采样中 `aoc-panel` CPU 约 1% 左右。

仍然有性能优化空间，优先级最高的是“多实例 VNC 常驻”与“服务端档位/内存阈值配置不匹配”这两类问题。当前 3 个实例均保持一个 VNC 图形连接，即使实例页面被隐藏，只要开启了 `VNC常驻`，iframe 仍在 DOM 中并保持全尺寸远端桌面，服务端仍需要持续编码和推送画面。对 4 核小主机来说，这是最容易造成 CPU 与带宽浪费的点。

另一个重要现象是：运行高峰时 Telegram 容器 CPU 曾达到 95% 到 219%，进程内 Telegram 本体约 60% CPU，Xvnc 约 8.5% CPU；QQ/微信实例的 Xvnc 多在 1% 到 3% 左右。也就是说，瓶颈不只是 VNC 编码，更多是“应用本体刷新/渲染 + Xvnc 编码 + WebSocket 传输”的组合。

## 当前 VNC 架构

服务端：

- 应用实例镜像基于 `lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm`。
- 每个应用实例容器内运行 `Xvnc`、nginx、kclient、PulseAudio、openbox 和目标应用。
- KasmVNC 配置由 [panel/server/src/desktop/vnc-server-profile.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/vnc-server-profile.ts:66) 生成，通过环境变量 `WOC_VNC_SERVER_PROFILE_YAML_B64` 传入容器，再由 [docker/woc-vnc-profile.sh](/root/docker/WechatOnCloud/docker/woc-vnc-profile.sh:10) 写入 `/config/.vnc/kasmvnc.yaml`。
- 修改服务端 VNC 档位会调用 [panel/server/src/instance/instance-manager.ts](/root/docker/WechatOnCloud/panel/server/src/instance/instance-manager.ts:189) 的 `updateVncServerProfile`，保存后立即 `runInstance` 重建实例容器，所以会断开当前连接但保留数据卷。

代理层：

- 面板通过 [panel/server/src/desktop/desktop-proxy.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/desktop-proxy.ts:18) 代理 `/desktop/:id/*` 到目标实例。
- `/websockify` 升级请求会做登录态、Host、Origin、实例权限校验，然后转发到实例容器。
- [panel/server/src/desktop/desktop-client-manager.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/desktop-client-manager.ts:22) 限制每个实例只保留一个桌面图形 WebSocket，新客户端接入会断开旧客户端。

客户端：

- 桌面页用 iframe 加载 noVNC，URL 由 [panel/web/src/domain/instances.ts](/root/docker/WechatOnCloud/panel/web/src/domain/instances.ts:169) 生成。
- URL 参数固定开启 `resize=remote`，并传入前端流设置 `quality`、`compression`。
- 前端流设置在 [panel/web/src/domain/vncStream.ts](/root/docker/WechatOnCloud/panel/web/src/domain/vncStream.ts:19)：
  - `省流`：quality 4，compression 8，关闭音频。
  - `均衡`：quality 5，compression 7，开启音频。
  - `清晰`：quality 8，compression 4，开启音频。
- [panel/web/src/features/desktop/desktopFrame.ts](/root/docker/WechatOnCloud/panel/web/src/features/desktop/desktopFrame.ts:89) 会在 iframe 内直接设置 noVNC 的 `rfb.qualityLevel` 和 `rfb.compressionLevel`。
- 音频不是走 noVNC 图像 WebSocket，而是 [panel/web/src/vncAudio.ts](/root/docker/WechatOnCloud/panel/web/src/vncAudio.ts:1) 通过 `/audio/socket.io` 另建通道。前端“省流”会关闭音频。

## 运行态观察

当前运行实例：

| 实例 | 应用 | 服务端 VNC 档位 | 容器内存上限 |
| --- | --- | --- | --- |
| `woc-app-d7b5df207a` | WeChat | balanced | 1.5 GiB |
| `woc-app-6af26ebdc6` | QQ | balanced | 1.5 GiB |
| `woc-app-9f88b18b24` | Telegram | balanced | 1.5 GiB |

实际 `/config/.vnc/kasmvnc.yaml` 均为 `balanced`：

```yaml
encoding:
  max_frame_rate: 24
  full_frame_updates: none
  rect_encoding_mode:
    min_quality: 5
    max_quality: 7
    consider_lossless_quality: 9
    rectangle_compress_threads: auto
  video_encoding_mode:
    jpeg_quality: 6
    webp_quality: 6
    max_resolution:
      width: 1920
      height: 1080
```

实时资源采样中观察到：

- `aoc-panel` CPU 约 1% 到 1.5%，不是主要瓶颈。
- Telegram 容器高峰 CPU 曾到 95% 到 219%，进程内 Telegram 本体约 60%，Xvnc 约 8.5%。
- QQ 容器当前 Xvnc 约 2.7%，QQ 本体多个进程合计高于 Xvnc。
- WeChat 容器当前 Xvnc 约 1.2%，WeChat 本体约 0.6%。
- 宿主 swap 已使用约 1.2 GiB，说明整体内存压力存在，虽然这 3 个实例当前没有 OOM 记录。

连接状态：

- 每个实例当前都有一个 `127.0.0.1 -> Xvnc:6901` 的图形连接。
- 每个实例都有一个面板到实例 nginx `:3000` 的连接。
- 后端已经限制单实例单图形客户端，所以不是“同一实例多个浏览器重复连接”的问题。

远端分辨率：

- 3 个实例当前远端桌面均为 `1543x965`。
- 前端使用 `resize=remote`，VNC iframe 尺寸会影响远端桌面尺寸。

## 已有优化点

项目中已经存在这些有效优化：

- KasmVNC 服务端档位：见 [panel/server/src/desktop/vnc-server-profile.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/vnc-server-profile.ts:18)。
- noVNC 客户端流档位：见 [panel/web/src/domain/vncStream.ts](/root/docker/WechatOnCloud/panel/web/src/domain/vncStream.ts:19)。
- 单实例单 VNC 图形连接：见 [panel/server/src/desktop/desktop-client-manager.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/desktop-client-manager.ts:26)。
- 关闭前台外实例的音频：见 [panel/web/src/features/desktop/useVncFrame.ts](/root/docker/WechatOnCloud/panel/web/src/features/desktop/useVncFrame.ts:125)。
- noVNC canvas `willReadFrequently` 补丁：见 [docker/woc-canvas.pl](/root/docker/WechatOnCloud/docker/woc-canvas.pl:1)。
- KasmVNC/Xvnc 内存泄漏 watchdog：见 [panel/server/src/watchdog/watchdog-manager.ts](/root/docker/WechatOnCloud/panel/server/src/watchdog/watchdog-manager.ts:13)。
- 容器内存硬限制：当前实例均为 `1.5 GiB`，防止 Xvnc 或应用异常膨胀拖垮宿主。

## 主要可优化点

### 1. 优先优化 VNC 常驻的隐藏实例

当前 `VNC常驻` 的前端实现会把实例页保留在 DOM 中。隐藏态 CSS 是 `visibility:hidden`，不是卸载 iframe：

- [panel/web/src/AppShell.tsx](/root/docker/WechatOnCloud/panel/web/src/AppShell.tsx:126) 渲染 `workspace-keepalive`。
- [panel/web/src/styles.css](/root/docker/WechatOnCloud/panel/web/src/styles.css:1850) 对非活动常驻实例设置 `visibility:hidden`。

这意味着隐藏实例仍然保留 VNC WebSocket，远端仍保持全尺寸桌面，服务端仍会编码和发送图像。当前 3 个实例都有 VNC 连接，说明这不是理论问题。

建议：

1. 运营层面立即处理：非必要不要同时开启多个实例的 `VNC常驻`。
2. 代码层面优化：给 `VNC常驻` 增加“空闲降载”策略。非活动实例超过一段时间后断开 VNC iframe，回到该实例时自动重连。应用容器继续运行，不影响微信/QQ/Telegram 登录态。
3. 如果必须保持低延迟切换，可增加“低负载常驻”模式：非活动实例不完全断开，但把 noVNC 客户端切到 `quality=2/compression=9`，并尝试把远端 resize 到较小尺寸，例如 960x600。切回前台后恢复用户选择的流档位和窗口尺寸。

优先级：高。  
风险：中。断开 VNC iframe 会导致切回时有重连等待，但不会丢容器数据。若业务需要秒切，则用“低负载常驻”替代。

### 2. 将 Telegram / QQ 默认服务端档位降到 `speed`

当前所有实例都是 `balanced`，即 24fps、中等质量。Telegram 在当前采样中是 CPU 压力最高的实例，且多数聊天类应用不需要 24fps。

建议：

- Telegram 优先改服务端 VNC 档位为 `speed`：15fps、低质量、更早进入视频编码。
- QQ 如果持续高峰，也建议改 `speed`。
- WeChat 当前压力较低，可以继续 `balanced`。

这项可以直接在管理页“VNC编码”里改，保存会重启实例。对应服务端配置在 [panel/server/src/desktop/vnc-server-profile.ts](/root/docker/WechatOnCloud/panel/server/src/desktop/vnc-server-profile.ts:18)。

优先级：高。  
风险：低到中。需要实例重启，画面流畅度和细节会下降，但聊天类应用一般可接受。

### 3. 修正内存硬上限与 watchdog hard 阈值不一致

当前面板容器环境里：

- `WOC_INSTANCE_MEM_GB=1.5`，实例容器硬上限是 1.5 GiB。
- `WOC_INSTANCE_MEM_HARD_MB=2500`，默认 watchdog hard 是 2.5 GiB。

这两者不一致。实例容器到 1.5 GiB 会先被 cgroup 限制，watchdog 的 2.5 GiB hard 永远触发不到。当前账号数据里 WeChat 自定义 hard 是 1500，QQ 是 2000，Telegram 未设置使用默认 2500；但所有容器实际 `memory.max` 都是 1.5 GiB。

建议：

- 如果希望 watchdog 在 Docker OOM 前处理，`hard` 应小于或等于容器硬上限，例如 1400 MiB。
- 如果希望实例有更大缓冲，则把 `WOC_INSTANCE_MEM_GB` 提高到 2.5 或 3.0，同时确认宿主内存足够。当前宿主已使用 swap，不建议盲目提高。
- 对 Telegram 补一个 per-instance 内存阈值，例如 soft 1200、hard 1400。

优先级：高。  
风险：低。属于配置一致性修正。

### 4. 静态 noVNC 资源可增加缓存和压缩

实例内 KasmVNC 静态资源当前响应：

- `main.bundle.js` 约 777 KiB。
- `vendors~main.bundle.js` 约 463 KiB。
- `Cache-Control: public, max-age=0`。
- 即使请求带 `Accept-Encoding: gzip, br`，响应也没有 `Content-Encoding`。

这些资源通过“浏览器 -> 面板 -> 实例 nginx/kclient”加载。它们不是持续帧流瓶颈，但会影响首次打开和频繁重连速度。

建议：

- 在面板代理层或实例 nginx 层给 `/desktop/:id/vnc/dist/*` 增加 gzip/br 或预压缩资源。
- 对带 ETag 的 dist 资源设置更长浏览器缓存。因为实例镜像更新后 ETag/Last-Modified 会变化，长缓存风险可控，但需要避免缓存 `index.html`。

优先级：中。  
风险：中。需要注意不同实例共用路径但内容来自同镜像，缓存 key 中有实例 ID，收益主要是减少重复下载和代理开销。

### 5. 非活动实例可以停止性能采样，当前已基本做到

[panel/web/src/features/desktop/useVncPerformanceStats.ts](/root/docker/WechatOnCloud/panel/web/src/features/desktop/useVncPerformanceStats.ts:36) 只在 `active && showVnc && frameLoaded` 时启用，非活动常驻实例不会继续统计 FPS、延迟、heap、WebSocket buffer。

这一点已经合理。若未来加更多监控，必须继续保持“仅前台实例采样”，避免监控本身变成负载。

优先级：低。  
风险：低。

### 6. 音频默认开启会增加额外连接和处理成本

前端 `balanced` 和 `quality` 都默认开启音频，`speed` 关闭音频。音频通过 socket.io 另建连接，并且麦克风在安全上下文可用时也会尝试启动。

建议：

- 对聊天应用默认前端流档位可考虑改成 `省流` 或提供“默认不开音频”的用户偏好。
- 保持当前“非活动实例关闭音频”的逻辑，这一点已经实现。
- 如果用户几乎不用语音/视频，关闭音频收益明显，尤其是多个实例同时运行时。

优先级：中。  
风险：低。影响声音和麦克风能力。

### 7. 应用本体渲染参数还有进一步压 CPU 空间

QQ 已经通过 [docker/app-defs.sh](/root/docker/WechatOnCloud/docker/app-defs.sh:7) 加了多项 Chromium 软件渲染参数。Telegram 当前启动命令只是 `$APP_BIN`，没有类似的降载参数。采样显示 Telegram 本体 CPU 明显高于 Xvnc。

建议：

- 调研 Telegram Desktop 支持的启动参数，优先寻找禁用动画、禁用 OpenGL、降低后台刷新之类选项。
- 如果 Telegram 本体没有合适参数，则主要靠服务端 `speed` 档、关闭常驻、降低远端分辨率解决。

优先级：中。  
风险：中。应用参数兼容性需要实测。

### 8. KasmVNC 编码线程 `auto` 可按小主机调小

当前服务端配置使用：

```yaml
rectangle_compress_threads: auto
```

在 4 核主机上，多实例同时编码时 `auto` 可能造成线程竞争。现在单个 Xvnc CPU 不算最高，但多个实例常驻时仍有累积风险。

建议：

- 增加一个更激进的 `lowcpu` 或调整 `speed` 档，把 `rectangle_compress_threads` 从 `auto` 改为 `1` 或 `2`。
- 需要对比 CPU、延迟和画面质量。线程减少可能降低峰值 CPU，但也可能提高单帧编码耗时。

优先级：中。  
风险：中。需要基准测试。

## 推荐实施顺序

1. 先关闭非必要实例的 `VNC常驻`，只保留当前正在使用的实例连接。
2. 将 Telegram 服务端 VNC 档位改为 `speed`，如果 QQ 也经常高 CPU，则 QQ 也改为 `speed`。
3. 将前端流档位默认使用 `省流`，需要声音或画质时再手动切回 `均衡/清晰`。
4. 修正 watchdog hard 与容器内存硬限制不一致：在 1.5 GiB 容器上建议 hard 不超过 1400 MiB，soft 可设 1000 到 1200 MiB。
5. 代码层面实现“非活动 VNC 常驻降载/断开”。
6. 再做静态资源缓存压缩、KasmVNC 编码线程调参、Telegram 启动参数优化。

## 建议代码改造方案

### 方案 A：非活动常驻实例自动断开 VNC

目标：保留应用容器运行，但释放隐藏 iframe 的 VNC 图形连接。

实现思路：

- 在 `InstanceView` 或 `useVncFrame` 中新增 `keepAlivePolicy`。
- 当 `active=false` 且实例开启常驻时，不立即保留图形连接，而是启动一个空闲计时器，例如 60 秒。
- 空闲超时后卸载 iframe 或把 `showVnc` 置为 false。
- 用户切回实例时重新创建 iframe，走现有自动重连逻辑。

优点：

- 对 CPU、带宽、Xvnc 编码压力收益最大。
- 实现边界清楚，不需要改 KasmVNC。

缺点：

- 切回时需要重新连接。
- 如果用户依赖隐藏页面持续刷新画面，这个行为会改变预期。

### 方案 B：非活动常驻实例降为低码流

目标：保留 VNC 连接，但显著降低隐藏实例负载。

实现思路：

- `active=false` 时调用 `applyVncStreamSettings(frame, { quality: 2, compression: 9 })`。
- 尝试对隐藏 iframe 触发较小 `resize=remote`，比如 960x600。
- `active=true` 时恢复用户原始 stream 设置并重新同步尺寸。

优点：

- 切回比方案 A 更快。
- 对使用体验改动较小。

缺点：

- 仍然保留 WebSocket 和服务端编码。
- 隐藏 iframe 当前 CSS 是全尺寸 `visibility:hidden`，如果要降低远端分辨率，需要改布局策略或直接调用 noVNC resize 相关能力。

### 方案 C：增加 `lowcpu` 服务端档位

目标：给小主机/多实例场景一个比 `speed` 更省 CPU 的服务端档位。

建议参数方向：

```yaml
encoding:
  max_frame_rate: 10
  full_frame_updates: none
  rect_encoding_mode:
    min_quality: 2
    max_quality: 4
    consider_lossless_quality: 7
    rectangle_compress_threads: 1
  video_encoding_mode:
    jpeg_quality: 3
    webp_quality: 3
    max_resolution:
      width: 1280
      height: 720
```

优点：

- 对低端主机和公网弱网更直接。

缺点：

- 画质下降明显。
- 增加一个新档位需要同步后端类型、前端类型、管理页文案和显示逻辑。

## 不建议优先做的方向

- 不建议先优化 Fastify/http-proxy 代理层。当前面板 CPU 很低，代理不是瓶颈。
- 不建议盲目提高容器内存上限。宿主已经使用 swap，提高上限可能让多个实例互相挤占，体感更差。
- 不建议默认使用 `quality` 服务端档位。当前应用场景是聊天/办公类，不是高帧率视频或游戏。
- 不建议移除单实例单客户端限制。这个限制对防止重复编码非常关键。

## 最终判断

当前项目 VNC 服务端和客户端都还能优化。最有价值的优化不是单纯提高编码参数，而是减少不必要的持续编码：关闭或降载隐藏的常驻 VNC、让聊天类应用默认使用更低帧率、让内存 watchdog 阈值与容器硬限制一致。

如果只做配置层调整，建议先执行：

1. Telegram 改服务端 `speed`。
2. 非当前使用实例关闭 `VNC常驻`。
3. 前端使用 `省流` 档，必要时再开音频。
4. 将 hard 内存阈值调到不高于 1.5 GiB 容器上限。

如果进入代码优化，优先做“非活动常驻 VNC 自动断开或降码流”，这是当前架构下收益最高、风险可控的方向。
