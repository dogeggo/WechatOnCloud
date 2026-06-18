# 微信消息 GDB 捕获方案评估

## 背景

当前项目的微信通知链路依赖容器内的 `woc-notifyd`：

- 接管 `org.freedesktop.Notifications`，把应用发出的 DBus 桌面通知转发到面板 SSE。
- 对微信额外轮询可见的 utility 提醒窗口，并尝试通过 X11 属性与 AT-SPI 可访问性文本提取提醒内容。

实测当前微信实例为官方 deb 解压版：

- 运行路径：`/config/wechat/opt/wechat/wechat`
- 当前安装状态记录：`4.1.1.7`
- ELF BuildID：`7b3f07cc1c00d7942b8e7235fb17bcf441292698`
- 打包形态：deb 解压到数据卷，不是 AppImage

参考文章方案：

- 链接：<https://aajax.top/2026/03/11/GettingLinuxWechatMessages/>
- 目标版本：Linux 微信 `4.1.0.16` AppImage
- 核心方式：用 `gdb -p "$(pidof wechat)"` attach 到微信进程，在逆向确认的断点 RVA 上读取寄存器与进程内存结构，从而拿到消息文本。

## 当前项目可行性结论

该方案在当前项目中技术上可落地，但不能直接复用文章脚本。

主要原因：

- 文章针对 `4.1.0.16 AppImage`，当前项目是 `4.1.1.7 deb`，二进制 BuildID 和布局不同。
- 文章中的断点 RVA、字段偏移、字符串读取逻辑都属于版本强绑定数据，当前版本需要重新逆向确认。
- 当前实例容器默认没有 `gdb`。
- 当前容器能力被刻意收紧，无法 ptrace 微信进程。

当前容器的关键安全配置位于 `panel/server/src/docker/docker.ts`：

```ts
Privileged: false,
SecurityOpt: ["no-new-privileges:true"],
CapDrop: ["ALL"],
CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
```

在当前微信容器中验证过：

```text
ptrace_attach_ret=-1 errno=1 Operation not permitted
/proc/<wechat-pid>/mem: Permission denied
gdb: command not found
```

因此，GDB 捕获不能作为当前通知问题的直接低风险修复。

## 与现有通知链路的关系

当前 DBus 通知桥本身可用。使用微信进程同一个 `DBUS_SESSION_BUS_ADDRESS` 发送测试通知时，`woc-notifyd` 能收到并上报：

```text
[woc-notifyd] 收到通知 id=1 app="notify-send" summary="WOC测试" body="同bus通知链路测试"
[woc-notifyd] 通知已上报 id=1
```

现有问题更可能在微信侧：

- 微信没有向 `org.freedesktop.Notifications` 发出有效通知。
- 微信仅弹出 utility 提醒窗口。
- 当前 AT-SPI/X11 兜底只能读到窗口标题一类噪声，例如 `wechat`，拿不到真实消息正文。

GDB 方案的价值是绕过桌面通知与可访问性接口，直接从微信进程内存中取消息。它可以作为高级捕获模式，但不适合替换默认通知链路。

## 推荐落地边界

如果后续决定实现 GDB 捕获，建议按可选能力实现，不要默认启用。

建议开关：

```text
WOC_WECHAT_GDB_CAPTURE=1
```

不开启时保持当前容器隔离策略。开启后才允许：

- 镜像安装或携带 `gdb`。
- 实例容器增加 `SYS_PTRACE`。
- 启动微信后再启动 GDB attach runner。
- 校验当前微信二进制版本与已知 profile 是否匹配。

不要使用兜底猜测断点。版本不匹配时直接报错并关闭 GDB 捕获。

## 需要新增的模块

建议按职责拆分：

- `docker/wechat-capture/`
  - 放 GDB Python hook、attach runner、版本 profile。
- `docker/notify/`
  - 保持通知上报职责，可复用内部 HTTP payload 结构。
- `panel/server/src/docker/docker.ts`
  - 根据实例配置或环境变量决定是否给容器增加 `SYS_PTRACE`。
- `docker/init/autostart`
  - 微信启动后按开关启动捕获 runner。

不要把 GDB hook、HTTP 上报、前端展示混在一个函数或一个类里。

## 版本 profile 设计

建议用显式 profile 记录版本强绑定信息：

```json
{
  "wechatVersion": "4.1.1.7",
  "buildId": "7b3f07cc1c00d7942b8e7235fb17bcf441292698",
  "sha256": "e476a594325da076ea83432aa131695f7314b2d663f2035b8fab63261440da9b",
  "bpRva": "0x...",
  "offsets": {
    "msgType": "0x...",
    "serverId": "0x...",
    "sender": "0x...",
    "content": "0x..."
  }
}
```

启动时必须校验：

- `file` 目标是预期微信 ELF。
- BuildID 匹配。
- sha256 匹配。
- profile 中的 RVA 和偏移存在。

任一条件不满足则不 attach，直接记录错误。

## 容器权限改造

当前默认能力不允许 ptrace。GDB 模式至少需要：

```ts
CapAdd: [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETGID",
  "SETUID",
  "SYS_PTRACE",
]
```

是否需要调整 seccomp 取决于实际运行环境。优先只增加 `SYS_PTRACE` 做验证；不要一开始就使用 `Privileged: true` 或 `seccomp=unconfined`。

如果 Docker 默认 seccomp 仍阻止 attach，再单独评估 seccomp profile，而不是直接放开所有安全限制。

## 捕获输出接入

GDB hook 输出不要直接驱动前端。建议转换为现有内部通知 payload：

```json
{
  "appName": "微信",
  "summary": "微信有新消息",
  "body": "消息摘要",
  "urgency": 1,
  "source": "wechat-gdb-message-hook",
  "createdAt": 1781740000000
}
```

由现有面板内部接口接收：

```text
POST /_woc/internal/instances/:id/notifications
```

这样前端 SSE、浏览器通知、toast 逻辑无需知道消息来自 DBus、窗口兜底还是 GDB。

## 风险

- `SYS_PTRACE` 会降低容器内进程隔离强度。
- GDB attach 会读微信进程内存，隐私敏感，必须仅对明确授权的实例启用。
- 微信升级后断点和结构偏移很可能失效。
- 断点处理不当可能导致微信卡顿或崩溃。
- 常驻 GDB/Python hook 会增加少量内存占用，需要计入实例内存限制。
- 该方案可能触发客户端风控，无法保证账号风险为零。

## 建议推进顺序

1. 先增强现有 `woc-notifyd` 的微信提醒窗口兜底逻辑，解决同一窗口复用、噪声文本过滤和可观测性问题。
2. 如果仍无法拿到正文，再单独创建 GDB 捕获实验分支。
3. 对当前 `4.1.1.7` deb 版微信重新逆向，生成严格版本 profile。
4. 只在 `WOC_WECHAT_GDB_CAPTURE=1` 时放开 `SYS_PTRACE` 并启动 attach runner。
5. 验证稳定后再考虑把该能力接入面板配置项。
