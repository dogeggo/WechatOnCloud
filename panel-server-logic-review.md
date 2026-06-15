# panel/server 后端逻辑分析

分析范围：`panel/server/src`。重点阅读了路由入口 `index.ts`、业务编排 `instance-manager.ts`、Docker/文件/卷操作 `docker.ts`、认证与请求安全相关模块。

## 结论概览

后端主体分层已经比较明确：`index.ts` 负责 HTTP 路由，`InstanceManager` 负责实例业务编排，`store.ts` 负责实例持久化，`docker.ts` 负责容器与卷的底层操作。当前最值得优化的是单文件下载链路仍然把 Docker archive 全量读入内存；明确存在的 bug 是上传文件名校验与 tar 头写入规则不一致，长文件名会被静默截断，部分多字节文件名还可能破坏 tar 头字段。

## 1. 单文件下载应改为流式处理

- 位置：`panel/server/src/docker/docker.ts:709`、`panel/server/src/docker/docker.ts:718`、`panel/server/src/docker/docker.ts:724`、`panel/server/src/docker/docker.ts:980`、`panel/server/src/docker/docker.ts:989`、`panel/server/src/docker/docker.ts:995`
- 类型：逻辑/资源优化
- 优先级：中到高

现象：

`downloadFromInstance()` 和 `volDownloadFile()` 都通过 Docker `getArchive()` 获取 tar 流，但随后把所有 chunk 收集到数组，`Buffer.concat()` 后再调用 `extractSingleFileFromTar()` 取第一个普通文件内容。也就是说，请求真正返回给前端前，服务端会同时持有完整 tar archive 和文件 Buffer。

影响：

- 中转目录下载受上传上限影响，单个文件默认可到 128 MiB，已经会造成明显内存尖峰。
- 数据卷文件下载没有按真实文件大小做单独限制，卷内可能存在数据库、缓存、备份包等大文件，下载时更容易把 Node 进程内存打高。
- `sendBinary()` 已支持 `NodeJS.ReadableStream`，整卷备份 `volBackupStream()` 也已经采用流式返回，单文件下载与现有能力不一致。

建议：

- 把 Docker archive 解包改成流式读取：只解析 tar header，定位第一个普通文件后把其内容作为 `Readable` 传给 `sendBinary()`。
- 对单文件下载增加文件大小探测或下载上限，避免误点超大卷文件导致面板进程内存尖峰。
- 将 tar header 生成、tar 解包、Docker archive 读写抽到独立模块，例如 `docker/archive.ts`，让 `docker.ts` 只保留容器生命周期和 Docker API 适配逻辑。

## 2. 上传长文件名会被静默截断

- 位置：`panel/server/src/docker/docker.ts:612`、`panel/server/src/docker/docker.ts:616`、`panel/server/src/docker/docker.ts:654`、`panel/server/src/docker/docker.ts:657`、`panel/server/src/docker/docker.ts:665`、`panel/server/src/docker/docker.ts:947`
- 类型：存在的 bug
- 优先级：中

现象：

上传单文件时，`safeName()` 允许 `name.length <= 200` 的 basename，但 `tarHeader()` 只把 `name.slice(0, 100)` 写入 tar header 的 name 字段。两个入口都会复用这套逻辑：

- `/api/instances/:id/upload` -> `uploadToInstance()` -> `tarSingleFileStream()`
- `/api/admin/instances/:id/volume/upload` -> `volUploadFile()` -> `tarSingleFileStream()`

对于 ASCII 文件名，只要长度超过 100 个字符，上传会成功，但容器内实际落盘文件名会变成前 100 个字符。对于中文等多字节文件名，`name.length` 不是 UTF-8 字节数，`h.write(name.slice(0, 100), 0, "utf8")` 又没有把写入长度限制到 tar name 字段的 100 字节内，较长的多字节名称可能覆盖后续 tar header 字段，导致 Docker 解包失败或落盘结果不可预期。

影响：

- 前端和用户认为上传的是原文件名，但后端实际文件名变短，后续按原名下载、删除会失败。
- 两个不同长文件名如果前 100 个字符相同，可能在容器内发生覆盖。
- 多字节文件名可能导致 tar 元数据异常，错误表现不稳定，排查成本高。

建议：

- 如果暂不支持 tar long name / PAX 扩展，直接按 UTF-8 字节数校验：`Buffer.byteLength(name, "utf8") <= 100`，超过则返回 400 错误。
- `tarHeader()` 写入 name 字段时显式限制长度，例如只写入 name 字段范围，避免越界污染其他 header 字段。
- 更彻底的做法是用统一的 tar pack/stream 实现替代手写 512 字节头，并补充测试用例：100 字节文件名、101 字节文件名、中文多字节文件名、前 100 字节相同的两个文件名。
