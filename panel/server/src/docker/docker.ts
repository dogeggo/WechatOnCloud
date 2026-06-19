import { hostname } from "node:os";
import { PassThrough, Transform } from "node:stream";
import zlib from "node:zlib";
import Docker from "dockerode";
import { normalizeAppType, type AppType, type Instance } from "../instance/store.js";
import { kasmVncServerConfigYaml } from "../desktop/vnc-server-config.js";
import { instanceMemoryLimitBytes } from "../config/instance-memory.js";
import {
  singleFileFromTarStream,
  tarNameFitsHeader,
  tarSingleFileStream,
} from "./archive.js";
import {
  assertInstanceId,
  assertProjectContainerName,
  assertProjectVolumeName,
  isProjectContainerName,
  isProjectVolumeName,
  normalizeDockerNetworkName,
  parseIdFromContainerName,
  parseIdFromVolumeName,
} from "../instance/resource-guard.js";

function assertDockerImageRef(image: string): string {
  const ref = image.trim();
  if (!ref || /[\s\0]/.test(ref))
    throw new Error(`Docker 镜像名不合法：${image || "(empty)"}`);
  return ref;
}

const INSTANCE_IMAGE = assertDockerImageRef(
  process.env.WOC_INSTANCE_IMAGE || "docker.io/dogeggo/app-on-cloud:latest",
);
const PUID = process.env.PUID || "1000";
const PGID = process.env.PGID || "1000";
const TZ = process.env.TZ || "Asia/Shanghai";
const PANEL_INTERNAL_URL =
  process.env.WOC_PANEL_INTERNAL_URL || "http://aoc-panel:8080";
const PANEL_INTERNAL_HOST = process.env.WOC_PANEL_INTERNAL_HOST || "127.0.0.1";
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

// 可选：给每个实例容器设内存上限（GiB），作为 Xvnc 等异常增长时的兜底，避免拖垮宿主。
// 默认 0 = 不限制（保持原行为）。命中上限时容器内 OOM 杀进程、由 s6 自动重启 VNC。

// 设备伪装：把 /etc/os-release 伪装成 deepin（部分客户端官方支持的发行版，且 Deepin 本就基于 Debian，
// 与本镜像的 Debian 用户态一致，不会自相矛盾）。默认开启；设 WOC_SPOOF_OS=0 关闭恢复 Debian。
// 配合 00-woc-identity 钩子里的 machine-id 唯一化 + 真实 hostname，整体让容器更像一台普通 Linux 桌面，
// 降低被腾讯按"非真实设备/设备农场"判风险的概率。注意：尽力而为，非保证；详见 doc/设备伪装.md。
const SPOOF_OS = process.env.WOC_SPOOF_OS !== "0";

// 给实例容器派生一个"像个人电脑"的内部 hostname（替代 woc-app-<hex> 这种容器/服务器特征）。
// 从 inst.id 稳定派生：同一实例每次重建得到相同名字、不同实例不同。仅作伪装，不参与寻址
// （反代用容器名 containerName，不用此 hostname）。
function realisticHostname(id: string): string {
  const words = [
    "deepin",
    "lenovo",
    "thinkpad",
    "matebook",
    "xiaoxin",
    "legion",
    "dell",
    "asus",
    "desktop",
    "home",
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const w = words[h % words.length];
  const n = ((h >>> 8) % 900) + 100; // 100-999，避免前导 0
  return `${w}-pc-${n}`;
}

// 给实例容器派生一个"像真实有线网卡"的 MAC：常见网卡厂商 OUI 前缀 + 由 id 稳定派生的后三段。
// 容器默认 MAC 带"本地管理位"（第一字节第 2 位为 1，如 02/26/ee 开头），是"非真实硬件"的明显特征；
// 这里用全局管理、单播的真实厂商 OUI，更像一台插了网卡的真机。同一实例每次重建得到相同 MAC。
function realisticMac(id: string): string {
  // 常见消费级网卡厂商 OUI（全局管理 + 单播，首字节低两位为 0）
  const ouis = [
    "001b21",
    "8c1645",
    "00e04c",
    "0021cc",
    "3c970e",
    "001422",
    "b827eb",
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
  const oui = ouis[h % ouis.length];
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
  const tail = hex(h >>> 3) + hex(h >>> 11) + hex(h >>> 19);
  return (oui + tail).match(/.{2}/g)!.join(":");
}

const docker = new Docker(); // 默认连 /var/run/docker.sock
const VOLUME_PROJECT_LABEL = "com.dogeggo.woc.managed";
const VOLUME_APP_TYPE_LABEL = "com.dogeggo.woc.app-type";
const VOLUME_INSTANCE_ID_LABEL = "com.dogeggo.woc.instance-id";

// 面板自身所在的 docker 网络名；新实例都 attach 到它，便于按容器名互访。
let networkName: string | null = normalizeDockerNetworkName(
  process.env.WOC_DOCKER_NETWORK,
);

export type RuntimeState = "running" | "stopped" | "missing";

function assertProjectInstance(inst: Instance): void {
  assertInstanceId(inst.id);
  assertProjectContainerName(inst.containerName);
  assertProjectVolumeName(inst.volumeName);
  const containerId = parseIdFromContainerName(inst.containerName);
  const volumeId = parseIdFromVolumeName(inst.volumeName);
  if (containerId !== inst.id || volumeId !== inst.id) {
    throw new Error("实例 ID、容器名与数据卷名不一致");
  }
}

function projectContainer(inst: Instance): Docker.Container {
  assertProjectInstance(inst);
  return docker.getContainer(inst.containerName);
}

function projectVolume(name: string): Docker.Volume {
  return docker.getVolume(assertProjectVolumeName(name));
}

function isDockerNotFound(error: any): boolean {
  return error?.statusCode === 404 || error?.status === 404;
}

function appTypeFromVolumeLabels(labels: unknown): AppType | undefined {
  if (!labels || typeof labels !== "object") return undefined;
  const raw = (labels as Record<string, unknown>)[VOLUME_APP_TYPE_LABEL];
  if (raw == null || raw === "") return undefined;
  return normalizeAppType(raw);
}

async function ensureProjectVolume(inst: Instance): Promise<void> {
  try {
    const info: any = await projectVolume(inst.volumeName).inspect();
    const labeledAppType = appTypeFromVolumeLabels(info?.Labels);
    if (labeledAppType && labeledAppType !== inst.appType) {
      throw new Error(
        `数据卷 ${inst.volumeName} 属于 ${labeledAppType}，不能用于 ${inst.appType} 实例`,
      );
    }
    return;
  } catch (e: any) {
    if (!isDockerNotFound(e)) throw e;
  }

  await docker.createVolume({
    Name: inst.volumeName,
    Driver: "local",
    Labels: {
      [VOLUME_PROJECT_LABEL]: "true",
      [VOLUME_APP_TYPE_LABEL]: inst.appType,
      [VOLUME_INSTANCE_ID_LABEL]: inst.id,
    },
  });
}

export async function inspectVolumeAppType(name: string): Promise<AppType | undefined> {
  const info: any = await projectVolume(name).inspect();
  return appTypeFromVolumeLabels(info?.Labels);
}

// 启动时探测面板自身网络（容器内 hostname = 容器短 id）。失败不致命：
// 退回 WOC_DOCKER_NETWORK 或 null（null 时用 docker 默认 bridge，靠 IP 不靠名字会有问题，故尽量探测成功）。
export async function ensureNetwork(): Promise<string | null> {
  if (networkName) return networkName;
  try {
    const self = docker.getContainer(hostname());
    const info = await self.inspect();
    const nets = Object.keys(info.NetworkSettings?.Networks || {}).filter(
      (n) => n !== "none" && n !== "host",
    );
    if (nets.length > 0) networkName = normalizeDockerNetworkName(nets[0]);
  } catch (e: any) {
    console.warn(
      "[docker] 无法探测面板网络（本地开发或缺少 docker.sock 时正常）:",
      e?.message || e,
    );
  }
  return networkName;
}

function envList(inst: Instance): string[] {
  const vncConfigYaml = Buffer.from(kasmVncServerConfigYaml(), "utf8").toString("base64");
  const env = [
    `PUID=${PUID}`,
    `PGID=${PGID}`,
    `TZ=${TZ}`,
    `CUSTOM_USER=${inst.kasmUser}`,
    `PASSWORD=${inst.kasmPassword}`,
  ];
  // 固定禁用 DRI，配合镜像内 LIBGL_ALWAYS_SOFTWARE=1 强制软件渲染。
  env.push("DISABLE_DRI=1");
  // 本项目不需要在应用实例容器内再启动 dockerd；即使基础镜像服务被外部启用，也保持关闭。
  env.push("START_DOCKER=false");
  // 透传 os 伪装开关给容器内的 00-woc-identity 钩子（决定是否把 /etc/os-release 改成 deepin）。
  env.push(`WOC_SPOOF_OS=${SPOOF_OS ? "1" : "0"}`);
  // 多应用实例类型，由 02-woc-app 写入数据卷，autostart 据此启动目标应用。
  env.push(`WOC_APP_TYPE=${inst.appType}`);
  // 容器内 DBus 通知桥把消息提醒回传到面板；复用实例 Kasm 密码作为服务端内部上报密钥。
  env.push(`WOC_INSTANCE_ID=${inst.id}`);
  env.push(`WOC_NOTIFY_TOKEN=${inst.kasmPassword}`);
  env.push(`WOC_PANEL_INTERNAL_URL=${PANEL_INTERNAL_URL}`);
  env.push(`WOC_PANEL_INTERNAL_HOST=${PANEL_INTERNAL_HOST}`);
  env.push(`WOC_VNC_SERVER_CONFIG_YAML_B64=${vncConfigYaml}`);
  return env;
}

// 确保实例镜像在本地存在；缺失则拉取（首次新建实例时镜像通常还没拉过）。
async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(INSTANCE_IMAGE).inspect();
    return;
  } catch {
    /* 本地没有，下面拉取 */
  }
  await pullImage();
}

// 创建并启动一个应用实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
export async function runInstance(inst: Instance): Promise<void> {
  assertProjectInstance(inst);
  const net = await ensureNetwork();
  await ensureImage();
  await ensureProjectVolume(inst);
  try {
    const existing = projectContainer(inst);
    await existing.inspect();
    await existing.remove({ force: true });
  } catch {
    /* 不存在，正常 */
  }
  const hostConfig: Docker.HostConfig = {
    Binds: [`${assertProjectVolumeName(inst.volumeName)}:/config`],
    NetworkMode: net || undefined,
    Privileged: false,
    PublishAllPorts: false,
    SecurityOpt: ["no-new-privileges:true"],
    CapDrop: ["ALL"],
    // linuxserver/s6 init still needs these while running as root before it drops
    // desktop services to abc: chown writable dirs, rewrite machine-id/os-release,
    // and set uid/gid/supplementary groups for service processes.
    CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: "unless-stopped" },
  };
  if (instanceMemoryLimitBytes > 0) {
    hostConfig.Memory = instanceMemoryLimitBytes;
    hostConfig.MemorySwap = instanceMemoryLimitBytes; // 禁止 swap 膨胀：限制即为硬上限
  }
  // 伪装成真实有线网卡 MAC（厂商 OUI），替代容器默认的本地管理位 MAC。
  const mac = realisticMac(inst.id);
  const createOpts: Docker.ContainerCreateOptions = {
    name: inst.containerName,
    Image: INSTANCE_IMAGE,
    // 内部 hostname 伪装成"个人电脑"名（不再用 woc-app-<hex>，那是容器/服务器特征）。
    // 反代靠容器名 name 寻址，与此 hostname 无关。
    Hostname: realisticHostname(inst.id),
    Env: envList(inst),
    Labels: {
      [VOLUME_PROJECT_LABEL]: "true",
      [VOLUME_APP_TYPE_LABEL]: inst.appType,
      [VOLUME_INSTANCE_ID_LABEL]: inst.id,
    },
    ExposedPorts: { "3000/tcp": {} },
    HostConfig: hostConfig,
  };
  // 自定义网络时，MAC 须写到对应 endpoint 上（新版 docker 弃用顶层 MacAddress）；默认网络则用顶层。
  if (net) {
    createOpts.NetworkingConfig = {
      EndpointsConfig: { [net]: { MacAddress: mac } as any },
    };
  } else {
    (createOpts as any).MacAddress = mac;
  }
  const container = await docker.createContainer(createOpts);
  try {
    await container.start();
  } catch (e) {
    // 启动失败但容器已被创建出来（Created 状态），不清理的话会成为"幽灵容器"——
    // 它仍占着卷名 woc-data-<id>，让后续删卷报 409。修复 #23 时发现 4 个此类残留。
    try {
      await container.remove({ force: true });
    } catch {
      /* 容器已被外部移走或正在被清理，忽略 */
    }
    throw e;
  }
}

// 确保实例容器在运行：缺失则按需创建（不会重建已有卷），停止则启动。
export async function ensureRunning(inst: Instance): Promise<void> {
  try {
    const c = projectContainer(inst);
    const info = await c.inspect();
    if (!info.State?.Running) await c.start();
  } catch {
    await runInstance(inst);
  }
}

// 升级实例：拉取最新实例镜像后重建容器（保留数据卷 → 登录态不丢）。
// 拉取失败（本地自构建 / 离线 / 仓库不可达）则用本地现有镜像重建，不阻断。
export async function upgradeInstance(inst: Instance): Promise<void> {
  try {
    await pullImage();
  } catch (e: any) {
    console.warn(
      "[docker] 升级时拉取镜像失败，改用本地镜像重建:",
      e?.message || e,
    );
  }
  await runInstance(inst);
}

// 重置实例的设备 machine-id：删掉持久化的 .woc-machine-id 后重启，由 00-woc-identity 钩子重新生成
// 一个全新的唯一值（相当于"换一台新设备"）。用于某账号被腾讯风控标记后手动滚新设备身份。
// 仅对含身份钩子的新镜像有效；旧镜像（升级前）无钩子，先 throw 提示升级，避免做无用功。
export async function regenInstanceMachineId(inst: Instance): Promise<void> {
  const hasHook = (
    await execCapture(inst, [
      "sh",
      "-c",
      "test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no",
    ])
  ).trim();
  if (hasHook !== "yes") {
    throw new Error(
      "该实例运行的是旧镜像（无设备身份模块），请先「升级实例」后再重置设备 ID",
    );
  }
  // 删除持久化文件；重启时钩子检测到缺失 → 生成新的唯一 machine-id 并写回卷
  await execCapture(inst, ["sh", "-c", "rm -f /config/.woc-machine-id"]);
  await stopInstance(inst);
  await runInstance(inst);
}

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await projectContainer(inst).stop({ t: 5 } as any);
  } catch {
    /* 已停止或不存在 */
  }
}

export async function removeInstance(
  inst: Instance,
  purgeVolume: boolean,
): Promise<void> {
  try {
    const c = projectContainer(inst);
    await c.remove({ force: true });
  } catch {
    /* 容器可能已不存在 */
  }
  if (purgeVolume) {
    try {
      await projectVolume(inst.volumeName).remove({ force: true } as any);
    } catch {
      /* 卷可能不存在 */
    }
  }
}

// 列出"未被任何容器引用的 woc-data-* 数据卷"。判定改为 docker 真实视角（不再仅看 store），
// 否则 Created 状态的"幽灵容器"会让卷被误判为孤儿，删除时撞 409（real-world issue：
// 早期 runInstance 启动失败漏清残留容器，留下 4 个 Created 容器各占一个卷名）。
export async function listOrphanVolumes(
  referencedVolumes: Set<string>,
): Promise<Array<{ name: string; createdAt?: string; sizeBytes?: number; appType?: AppType }>> {
  // 容器视角：扫所有容器（含已停止 / Created），收集它们挂载的 woc-data-* 卷名
  const allContainers = await docker.listContainers({ all: true });
  const containerRefs = new Set<string>();
  for (const c of allContainers) {
    for (const m of c.Mounts || []) {
      if (typeof m.Name === "string" && isProjectVolumeName(m.Name))
        containerRefs.add(m.Name);
    }
  }
  // 与 store 视角并集：取两者都未引用的卷
  const referenced = new Set<string>([...referencedVolumes, ...containerRefs]);

  const { Volumes } = (await (docker as any).listVolumes()) || { Volumes: [] };
  if (!Array.isArray(Volumes)) return [];
  return Volumes.filter(
    (v: any) =>
      typeof v?.Name === "string" &&
      isProjectVolumeName(v.Name) &&
      !referenced.has(v.Name),
  )
    .map((v: any) => ({
      name: v.Name,
      createdAt: v.CreatedAt,
      appType: appTypeFromVolumeLabels(v.Labels),
      // UsageData 仅在 docker engine 启用 -v size=true 时返回，常见情况下没有；缺失就不展示
      sizeBytes:
        typeof v?.UsageData?.Size === "number" && v.UsageData.Size >= 0
          ? v.UsageData.Size
          : undefined,
    }))
    .sort((a, b) =>
      a.createdAt && b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : 0,
    );
}

// 显式删除一个数据卷。调用方负责确认它不被现存实例引用。
export async function removeVolume(name: string): Promise<void> {
  await projectVolume(name).remove({ force: true } as any);
}

// 列出"残留的 woc-app-* 容器"：在 docker 里存在但 store 没登记的（多为 runInstance 失败时
// 留下的 Created 状态容器，或用户手动 docker run 出来的）。供面板一键清理。
export async function listOrphanContainers(
  knownContainerNames: Set<string>,
): Promise<
  Array<{ id: string; name: string; status: string; volumeName?: string }>
> {
  const all = await docker.listContainers({ all: true });
  const out: Array<{
    id: string;
    name: string;
    status: string;
    volumeName?: string;
  }> = [];
  for (const c of all) {
    const name = (c.Names || [])
      .map((n) => n.replace(/^\//, ""))
      .find(isProjectContainerName);
    if (!name) continue;
    if (knownContainerNames.has(name)) continue;
    const vol = (c.Mounts || [])
      .map((m) => m.Name)
      .find((n) => typeof n === "string" && isProjectVolumeName(n));
    out.push({
      id: c.Id,
      name,
      status: c.Status || c.State || "",
      volumeName: vol,
    });
  }
  return out;
}

// 强制删除一个残留容器（按短/全 id 或容器名都行），但实际目标必须是未登记的 woc-app-* 容器。
export async function removeContainerById(
  idOrName: string,
  knownContainerNames = new Set<string>(),
): Promise<void> {
  const raw = String(idOrName || "").replace(/^\//, "");
  let targetIdOrName = "";
  let targetName = "";

  if (isProjectContainerName(raw)) {
    targetIdOrName = raw;
    targetName = raw;
  } else {
    if (!/^[0-9a-f]{12,64}$/.test(raw)) throw new Error("容器 ID 不合法");
    const all = await docker.listContainers({ all: true });
    const matches = all.filter((c) => c.Id === raw || c.Id.startsWith(raw));
    if (matches.length > 1) throw new Error("容器 ID 不唯一，请使用更长 ID");
    const match = matches[0];
    const name = match?.Names?.map((n) => n.replace(/^\//, "")).find(
      isProjectContainerName,
    );
    if (!match || !name) throw new Error("拒绝删除非本项目容器");
    targetIdOrName = match.Id;
    targetName = name;
  }

  if (knownContainerNames.has(targetName))
    throw new Error("该容器属于现存实例，不能在此删除");
  await docker.getContainer(targetIdOrName).remove({ force: true });
}

// 取实例容器的"working set"内存（MB）：等同 docker stats 显示值 = usage - inactive_file。
// 用于 watchdog 检测 KasmVNC/Xvnc 长跑泄漏（21 小时可涨到 ~9 GiB），无法读取时返回 0（视为"暂未知"，
// 不触发自愈，避免容器刚启动 stats 不可用就被误杀）。一次性 stats、不订阅 stream。
export async function instanceMemoryMB(inst: Instance): Promise<number> {
  return Math.round((await instanceMemoryUsedBytes(inst)) / 1024 / 1024);
}

export interface InstanceMemoryStats {
  usedBytes: number;
  maxBytes: number | null;
}

export async function instanceMemoryStats(inst: Instance): Promise<InstanceMemoryStats> {
  const c = projectContainer(inst);
  const [usedBytes, info] = await Promise.all([
    instanceMemoryUsedBytes(inst),
    c.inspect().catch(() => null),
  ]);
  const configuredMaxBytes = Number((info as any)?.HostConfig?.Memory) || 0;
  return {
    usedBytes,
    maxBytes: configuredMaxBytes > 0 ? configuredMaxBytes : null,
  };
}

async function instanceMemoryUsedBytes(inst: Instance): Promise<number> {
  try {
    const s: any = await projectContainer(inst).stats({ stream: false } as any);
    const usage = Number(s?.memory_stats?.usage) || 0;
    const inactive =
      Number(
        s?.memory_stats?.stats?.inactive_file ??
          s?.memory_stats?.stats?.total_inactive_file,
      ) || 0;
    return Math.max(0, usage - inactive);
  } catch {
    return 0;
  }
}

export async function instanceRuntime(inst: Instance): Promise<RuntimeState> {
  try {
    const info = await projectContainer(inst).inspect();
    return info.State?.Running ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

// 在实例容器内执行命令，返回 stdout；若命令失败，把 stderr 透出给调用方。
async function execCapture(inst: Instance, cmd: string[]): Promise<string> {
  const c = projectContainer(inst);
  const exec = await c.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: "abc",
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    const stdout = {
      write: (b: Buffer) => {
        out += b.toString("utf8");
      },
    } as any;
    const stderr = {
      write: (b: Buffer) => {
        err += b.toString("utf8");
      },
    } as any;
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on("end", async () => {
      try {
        const info = await exec.inspect();
        if (info.ExitCode && info.ExitCode !== 0) {
          reject(
            new Error(
              (err || out || `命令执行失败，退出码 ${info.ExitCode}`).trim(),
            ),
          );
          return;
        }
        resolve(out || err);
      } catch (e) {
        reject(e);
      }
    });
    stream.on("error", reject);
  });
}

// 触发应用下载/安装（detached，立即返回，后台下载）。
export async function triggerAppInstall(
  inst: Instance,
  cmd: "install" | "update",
): Promise<void> {
  const c = projectContainer(inst);
  const action = cmd === "update" ? "update" : "install";
  const exec = await c.exec({
    Cmd: [
      "bash",
      "-c",
      `/woc/app-ctl.sh ${inst.appType} ${action}`,
    ],
    AttachStdout: false,
    AttachStderr: false,
    User: "abc",
  });
  await exec.start({ Detach: true });
}

export interface AppStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

const DEFAULT_STATUS: AppStatus = {
  phase: "idle",
  percent: 0,
  installed: false,
  version: "",
  message: "未安装",
  updatedAt: 0,
};

export async function appStatus(inst: Instance): Promise<AppStatus> {
  try {
    const raw = await execCapture(inst, [
      "bash",
      "-c",
      `/woc/app-ctl.sh ${inst.appType} status`,
    ]);
    const json = JSON.parse(raw.trim());
    return { ...DEFAULT_STATUS, ...json };
  } catch {
    return DEFAULT_STATUS;
  }
}

// 拉取实例镜像（首次部署/更新镜像用）。返回拉取日志的最后状态。
export async function pullImage(
  onProgress?: (line: any) => void,
): Promise<void> {
  return await new Promise((resolve, reject) => {
    docker.pull(INSTANCE_IMAGE, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (e: any) => (e ? reject(e) : resolve()),
        (ev: any) => onProgress?.(ev),
      );
    });
  });
}

// ---------- 文件中转（上传/下载） ----------
// 中转目录 = abc 家目录下的 Downloads（/config 持久卷）。上传落这里，应用文件选择器可直接选到；
// 反向：把应用收到的文件另存到下载目录，即可在面板里下载。
const TRANSFER_DIR = "/config/Downloads";

// 校验文件名为安全 basename（防路径穿越）。
function safeName(name: string): boolean {
  return (
    !!name &&
    tarNameFitsHeader(name) &&
    !name.includes("/") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}

export async function uploadToInstance(
  inst: Instance,
  name: string,
  content: NodeJS.ReadableStream,
  size: number,
): Promise<void> {
  if (!safeName(name)) throw new Error("文件名不合法");
  await execCapture(inst, ["mkdir", "-p", TRANSFER_DIR]); // abc 家目录可写
  const c = projectContainer(inst);
  await c.putArchive(tarSingleFileStream(name, content, size), {
    path: TRANSFER_DIR,
  });
}

export interface TransferFile {
  name: string;
  size: number;
}
export async function listInstanceFiles(
  inst: Instance,
): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    "sh",
    "-c",
    `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null`,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, size] = line.split("\t");
      return { name, size: Number(size) || 0 };
    });
}

export async function deleteInstanceFile(
  inst: Instance,
  name: string,
): Promise<void> {
  if (!safeName(name)) throw new Error("文件名不合法");
  // argv 数组直传，不经 shell；safeName 已排除路径穿越
  await execCapture(inst, ["rm", "-f", `${TRANSFER_DIR}/${name}`]);
}

export async function downloadFromInstance(
  inst: Instance,
  name: string,
  maxBytes: number,
): Promise<NodeJS.ReadableStream> {
  if (!safeName(name)) throw new Error("文件名不合法");
  const c = projectContainer(inst);
  const stream = (await c.getArchive({
    path: `${TRANSFER_DIR}/${name}`,
  })) as NodeJS.ReadableStream;
  return singleFileFromTarStream(stream, maxBytes);
}

// 拉取实例容器日志（末尾 N 行），供前端"查看/导出日志"排错。
export async function instanceLogs(
  inst: Instance,
  tail = 600,
): Promise<string> {
  const c = projectContainer(inst);
  const buf = (await c.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  })) as unknown as Buffer;
  // docker 非 TTY 日志为多路复用流：每帧 8 字节头（[stream,0,0,0,size BE]）+ 负载；解出纯文本。
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (size < 0 || i + 8 + size > buf.length) break;
    out += buf.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out || buf.toString("utf8"); // 兜底：TTY 模式非多路复用
}

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 后台短暂持有 X selection，避免 exec 因 xclip 常驻而卡住。
export async function typeInInstance(
  inst: Instance,
  text: string,
): Promise<void> {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const cmd = [
    "set -e",
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    'tmp="$(mktemp)"',
    'clip_pid=""',
    'cleanup(){ rm -f "$tmp"; [ -n "$clip_pid" ] && kill "$clip_pid" 2>/dev/null || true; }',
    "trap cleanup EXIT",
    `printf '%s' '${b64}' | base64 -d > "$tmp"`,
    'xclip -selection clipboard -loops 5 -i < "$tmp" >/dev/null 2>&1 &',
    'clip_pid="$!"',
    "sleep 0.08",
    "xdotool key --clearmodifiers ctrl+v",
    'for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$clip_pid" 2>/dev/null || break; sleep 0.1; done',
  ].join("\n");
  await execCapture(inst, ["bash", "-c", cmd]);
}

export async function keyInInstance(inst: Instance, key: string): Promise<void> {
  if (!/^[A-Za-z_]{1,20}$/.test(key)) throw new Error("按键名不合法");
  const cmd = [
    "set -e",
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    `xdotool key --clearmodifiers ${key}`,
  ].join("\n");
  await execCapture(inst, ["bash", "-c", cmd]);
}

// ---------- 数据卷管理（路由层要求已登录） ----------
// 数据卷 = 容器内 /config 持久卷，含应用全部数据（登录态、加密数据、缓存等）。提供浏览/上传/解压/下载/
// 改名/移动/删除 + 整卷备份/恢复。主要场景：把 PC 应用数据迁移上来、跨实例迁移、离线备份。
// 路径安全：所有相对路径经 safeVolPath 归一化并严格限制在 /config 内，禁止 .. 穿越。
const VOL_ROOT = "/config";

// 把用户给的相对路径安全解析为 /config 下的绝对路径；禁止 .. 与 NUL；剥离前导 /。
function safeVolPath(rel: string): string {
  const raw = (rel ?? "").replace(/\\/g, "/");
  if (raw.includes("\0")) throw new Error("路径不合法");
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error("路径不合法（禁止 ..）");
    parts.push(seg);
  }
  return parts.length ? `${VOL_ROOT}/${parts.join("/")}` : VOL_ROOT;
}
const relOf = (abs: string): string =>
  abs === VOL_ROOT ? "" : abs.slice(VOL_ROOT.length + 1);
function limitStream(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(
          new Error(
            `解压后内容超过上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
}

function archiveInputStream(
  stream: NodeJS.ReadableStream,
  gzip: boolean,
  maxExtractedBytes: number,
): NodeJS.ReadableStream {
  const src = gzip ? stream.pipe(zlib.createGunzip()) : stream;
  return src.pipe(limitStream(maxExtractedBytes));
}

export interface VolEntry {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  mtime: number; // epoch ms
}

// 列目录（仅一层）。dirs/files 混合返回，前端排序。
export async function listVolume(
  inst: Instance,
  rel: string,
): Promise<{ path: string; entries: VolEntry[] }> {
  const abs = safeVolPath(rel);
  // GNU find -printf：%y 类型(d/f/l) \t %s 大小 \t %T@ mtime(秒.纳秒) \t %f 名字。argv 直传不经 shell，名字含空格/引号也安全。
  const out = await execCapture(inst, [
    "find",
    abs,
    "-maxdepth",
    "1",
    "-mindepth",
    "1",
    "-printf",
    "%y\\t%s\\t%T@\\t%f\\n",
  ]);
  const entries: VolEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const i1 = line.indexOf("\t");
    const i2 = line.indexOf("\t", i1 + 1);
    const i3 = line.indexOf("\t", i2 + 1);
    if (i1 < 0 || i2 < 0 || i3 < 0) continue;
    const y = line.slice(0, i1);
    entries.push({
      type:
        y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "link" : "other",
      size: Number(line.slice(i1 + 1, i2)) || 0,
      mtime: Math.round(parseFloat(line.slice(i2 + 1, i3)) * 1000) || 0,
      name: line.slice(i3 + 1),
    });
  }
  return { path: relOf(abs), entries };
}

export async function volMkdir(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error("路径不合法");
  await execCapture(inst, ["mkdir", "-p", abs]);
}

export async function volMove(
  inst: Instance,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const from = safeVolPath(fromRel);
  const to = safeVolPath(toRel);
  if (from === VOL_ROOT || to === VOL_ROOT)
    throw new Error("不能移动数据卷根目录");
  if (from === to) return;
  await execCapture(inst, ["mv", "-f", from, to]);
}

export async function volDelete(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error("不能删除数据卷根目录");
  await execCapture(inst, ["rm", "-rf", abs]);
}

// 上传单个文件到指定目录（流式 tar 写入 uid/gid 1000，落地即 abc 属主，应用可读）。
export async function volUploadFile(
  inst: Instance,
  rel: string,
  name: string,
  content: NodeJS.ReadableStream,
  size: number,
): Promise<void> {
  if (!safeName(name)) throw new Error("文件名不合法");
  const dir = safeVolPath(rel);
  await execCapture(inst, ["mkdir", "-p", dir]);
  await projectContainer(inst).putArchive(
    tarSingleFileStream(name, content, size),
    { path: dir },
  );
}

// 上传压缩包并解压到指定目录（PC 应用数据迁移：用户把文件夹打成 .tar/.tar.gz 上传）。
// putArchive 把 tar 内容解到 dir 下，Docker 解包限制在 dir 内、防 .. 穿越。
export async function volExtractArchive(
  inst: Instance,
  rel: string,
  archive: NodeJS.ReadableStream,
  gzip: boolean,
  maxExtractedBytes: number,
): Promise<void> {
  const dir = safeVolPath(rel);
  await execCapture(inst, ["mkdir", "-p", dir]);
  await projectContainer(inst).putArchive(
    archiveInputStream(archive, gzip, maxExtractedBytes),
    { path: dir },
  );
}

export async function volDownloadFile(
  inst: Instance,
  rel: string,
  maxBytes: number,
): Promise<NodeJS.ReadableStream> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error("不能下载整个根目录，请用整卷备份");
  const stream = (await projectContainer(inst).getArchive({
    path: abs,
  })) as NodeJS.ReadableStream;
  return singleFileFromTarStream(stream, maxBytes);
}

// 整卷备份：在容器内把 /config 内容打成相对路径 tar.gz，路由直接 pipe 给响应，避免大文件入内存。
export async function volBackupStream(
  inst: Instance,
): Promise<NodeJS.ReadableStream> {
  const exec = await projectContainer(inst).exec({
    Cmd: ["tar", "-C", VOL_ROOT, "-czf", "-", "."],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: "abc",
  });
  const raw = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  let errText = "";
  let ended = false;
  out.on("finish", () => {
    ended = true;
  });
  err.on("data", (b: Buffer) => {
    if (errText.length < 4096) errText += b.toString("utf8");
  });
  docker.modem.demuxStream(raw, out, err);
  raw.on("end", async () => {
    const info = await exec.inspect();
    if (info.ExitCode && info.ExitCode !== 0) {
      out.destroy(
        new Error((errText || `备份失败，退出码 ${info.ExitCode}`).trim()),
      );
      return;
    }
    if (!ended) out.end();
  });
  raw.on("error", (e) => out.destroy(e));
  return out;
}

// 整卷恢复：只解入 /config。要求上传的 tar/tar.gz 条目为相对路径。
export async function volRestoreArchive(
  inst: Instance,
  archive: NodeJS.ReadableStream,
  gzip: boolean,
  maxExtractedBytes: number,
): Promise<void> {
  await projectContainer(inst).putArchive(
    archiveInputStream(archive, gzip, maxExtractedBytes),
    { path: VOL_ROOT },
  );
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  assertProjectInstance(inst);
  return `http://${inst.containerName}:3000`;
}

export { INSTANCE_IMAGE };
