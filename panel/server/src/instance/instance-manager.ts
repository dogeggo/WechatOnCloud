import {
  canAccessInstance,
  createInstance,
  findInstance,
  findUnusedVolumeOwnership,
  forgetUnusedVolume,
  listInstances,
  listUnusedVolumeOwnerships,
  normalizeAppType,
  publicInstance,
  rememberUnusedVolume,
  removeInstance as removeInstanceRecord,
  renameInstance,
  setInstanceIcon,
  setInstanceMemLimits,
  type Instance,
  type InstanceActor,
} from './store.js';
import {
  deleteInstanceFile,
  downloadFromInstance,
  ensureRunning,
  instanceLogs,
  instanceMemoryMB,
  instanceMemoryStats,
  instanceRuntime,
  inspectVolumeAppType,
  keyInInstance,
  listInstanceFiles,
  listOrphanContainers,
  listOrphanVolumes,
  listVolume,
  regenInstanceMachineId,
  removeContainerById,
  removeInstance as removeInstanceContainer,
  removeVolume,
  runInstance,
  stopInstance,
  triggerAppInstall,
  typeInInstance,
  upgradeInstance,
  uploadToInstance,
  volBackupStream,
  volDelete,
  volDownloadFile,
  volExtractArchive,
  volMkdir,
  volMove,
  volRestoreArchive,
  volUploadFile,
  ensureNetwork,
  appStatus,
} from '../docker/docker.js';
import { httpError } from '../http/http-error.js';
import { INSTANCE_ID_RE, VOLUME_NAME_RE } from './resource-guard.js';
import type { UploadLimits, WatchdogConfig } from '../config/panel-config.js';

export interface MemoryLimitInfo {
  soft: number | null;
  hard: number | null;
  defaultSoft: number;
  defaultHard: number;
  hardMax: number | null;
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
}

export interface ApplicationMemoryInfo {
  usedBytes: number;
  maxBytes: number | null;
}

export class InstanceManager {
  constructor(
    private readonly watchdog: WatchdogConfig,
    private readonly upload: UploadLimits,
  ) {}

  requireInstance(rawId: unknown): Instance {
    const id = String(rawId || '');
    if (!INSTANCE_ID_RE.test(id)) throw httpError(400, '实例 ID 不合法');
    const inst = findInstance(id);
    if (!inst) throw httpError(404, '实例不存在');
    return inst;
  }

  requireInstanceForActor(rawId: unknown, actor: InstanceActor): Instance {
    const inst = this.requireInstance(rawId);
    if (!canAccessInstance(inst, actor)) throw httpError(404, '实例不存在');
    return inst;
  }

  async listWithStatus(actor: InstanceActor) {
    const rows = await Promise.all(
      listInstances().filter((inst) => canAccessInstance(inst, actor)).map(async (inst) => {
        const [runtime, status] = await Promise.all([instanceRuntime(inst), appStatus(inst)]);
        return { ...publicInstance(inst), runtime, app: status };
      }),
    );
    return { instances: rows };
  }

  async createForUser(actor: InstanceActor, name: unknown, reuseVolume: unknown, appType: unknown) {
    let type: Instance['appType'];
    try {
      type = normalizeAppType(appType);
    } catch (e: any) {
      throw httpError(400, e?.message || '应用类型不合法');
    }
    const reuseVolumeName = await this.normalizeReuseVolume(reuseVolume, actor, type);
    let inst: Instance;
    try {
      inst = createInstance(String(name ?? ''), actor.email, reuseVolumeName, type);
    } catch (e: any) {
      throw httpError(400, e?.message || '创建实例失败');
    }

    try {
      await runInstance(inst);
      if (reuseVolumeName) forgetUnusedVolume(reuseVolumeName);
    } catch (e: any) {
      removeInstanceRecord(inst.id);
      throw httpError(500, '创建容器失败：' + (e?.message || e));
    }
    return { instance: publicInstance(inst) };
  }

  async listUnusedVolumes(actor: InstanceActor) {
    this.requireAdmin(actor);
    const referenced = new Set(listInstances().map((inst) => inst.volumeName));
    const ownerships = new Map(listUnusedVolumeOwnerships().map((volume) => [volume.name, volume.appType]));
    const volumes = (await listOrphanVolumes(referenced)).map((volume) => ({
      ...volume,
      appType: volume.appType ?? ownerships.get(volume.name),
    }));
    return { volumes };
  }

  async listUnusedContainers(actor: InstanceActor) {
    this.requireAdmin(actor);
    const known = new Set(listInstances().map((inst) => inst.containerName));
    return { containers: await listOrphanContainers(known) };
  }

  async removeUnusedContainer(actor: InstanceActor, idOrName: unknown) {
    this.requireAdmin(actor);
    if (!idOrName || typeof idOrName !== 'string') throw httpError(400, '参数不合法');
    const known = new Set(listInstances().map((inst) => inst.containerName));
    if (known.has(idOrName)) throw httpError(409, '该容器属于现存实例，不能在此删除');
    await removeContainerById(idOrName, known);
    return { ok: true };
  }

  async removeUnusedVolume(actor: InstanceActor, name: unknown) {
    this.requireAdmin(actor);
    if (!name || typeof name !== 'string' || !VOLUME_NAME_RE.test(name)) {
      throw httpError(400, '卷名不合法');
    }
    if (listInstances().some((inst) => inst.volumeName === name)) {
      throw httpError(409, '该数据卷正被某个实例使用，不能删除');
    }
    await removeVolume(name);
    forgetUnusedVolume(name);
    return { ok: true };
  }

  async memoryLimits(actor: InstanceActor, id: unknown): Promise<MemoryLimitInfo> {
    const inst = this.requireInstanceForActor(id, actor);
    const currentMB = (await instanceRuntime(inst)) === 'running' ? await instanceMemoryMB(inst) : 0;
    return {
      soft: inst.memSoftLimitMB ?? null,
      hard: inst.memHardLimitMB ?? null,
      defaultSoft: this.watchdog.defaultSoftMB,
      defaultHard: this.watchdog.defaultHardMB,
      hardMax: this.watchdog.hardMaxMB > 0 ? this.watchdog.hardMaxMB : null,
      currentMB,
      watchdogEnabled: this.watchdog.enabled,
      intervalSec: this.watchdog.intervalSec,
    };
  }

  async applicationMemory(actor: InstanceActor, id: unknown): Promise<ApplicationMemoryInfo> {
    return await instanceMemoryStats(this.requireInstanceForActor(id, actor));
  }

  updateMemoryLimits(actor: InstanceActor, id: unknown, body: any) {
    const inst = this.requireInstanceForActor(id, actor);
    const soft = parseLimitPatch(body?.soft, 'soft');
    const hard = parseLimitPatch(body?.hard, 'hard');
    const finalSoft = soft === undefined ? inst.memSoftLimitMB ?? null : soft;
    const finalHard = hard === undefined ? inst.memHardLimitMB ?? null : hard;
    this.assertMemoryLimits(finalSoft, finalHard);
    try {
      return { instance: setInstanceMemLimits(inst.id, finalSoft, finalHard) };
    } catch (e: any) {
      throw httpError(400, e?.message || '阈值不合法');
    }
  }

  async regenerateMachineId(actor: InstanceActor, id: unknown) {
    await regenInstanceMachineId(this.requireInstanceForActor(id, actor));
    return { ok: true };
  }

  async remove(actor: InstanceActor, id: unknown, purge: boolean) {
    const inst = this.requireInstanceForActor(id, actor);
    await removeInstanceContainer(inst, purge);
    removeInstanceRecord(inst.id);
    if (purge) forgetUnusedVolume(inst.volumeName);
    else rememberUnusedVolume(inst.volumeName, inst.appType);
    return { ok: true };
  }

  rename(actor: InstanceActor, id: unknown, name: unknown) {
    const inst = this.requireInstanceForActor(id, actor);
    try {
      return { instance: renameInstance(inst.id, String(name ?? '')) };
    } catch (e: any) {
      throw httpError(400, e?.message || '重命名失败');
    }
  }

  setIcon(actor: InstanceActor, id: unknown, icon: unknown) {
    const inst = this.requireInstanceForActor(id, actor);
    try {
      return { instance: setInstanceIcon(inst.id, icon) };
    } catch (e: any) {
      throw httpError(400, e?.message || '设置图标失败');
    }
  }

  async start(actor: InstanceActor, id: unknown) {
    await ensureRunning(this.requireInstanceForActor(id, actor));
    return { ok: true };
  }

  async stop(actor: InstanceActor, id: unknown) {
    await stopInstance(this.requireInstanceForActor(id, actor));
    return { ok: true };
  }

  async restart(actor: InstanceActor, id: unknown) {
    await runInstance(this.requireInstanceForActor(id, actor));
    return { ok: true };
  }

  async upgrade(actor: InstanceActor, id: unknown) {
    await upgradeInstance(this.requireInstanceForActor(id, actor));
    return { ok: true };
  }

  async uploadTransferFile(actor: InstanceActor, id: unknown, name: unknown, stream: NodeJS.ReadableStream, size: number) {
    await uploadToInstance(this.requireInstanceForActor(id, actor), String(name || '').trim(), stream, size);
    return { ok: true };
  }

  async listTransferFiles(actor: InstanceActor, id: unknown) {
    return { files: await listInstanceFiles(this.requireInstanceForActor(id, actor)) };
  }

  async deleteTransferFile(actor: InstanceActor, id: unknown, name: unknown) {
    await deleteInstanceFile(this.requireInstanceForActor(id, actor), String(name || '').trim());
    return { ok: true };
  }

  async downloadTransferFile(actor: InstanceActor, id: unknown, name: unknown) {
    const filename = String(name || '').trim();
    return {
      filename,
      body: await downloadFromInstance(this.requireInstanceForActor(id, actor), filename, this.upload.transferDownloadBytes),
    };
  }

  async typeText(actor: InstanceActor, id: unknown, text: unknown) {
    const value = String(text ?? '');
    if (!value || value.length > 500) throw httpError(400, '文字为空或过长');
    await typeInInstance(this.requireInstanceForActor(id, actor), value);
    return { ok: true };
  }

  async keyInput(actor: InstanceActor, id: unknown, key: unknown) {
    const value = String(key ?? '');
    if (!/^[A-Za-z_]{1,20}$/.test(value)) throw httpError(400, '按键名不合法');
    await keyInInstance(this.requireInstanceForActor(id, actor), value);
    return { ok: true };
  }

  async logs(actor: InstanceActor, id: unknown) {
    return await instanceLogs(this.requireInstanceForActor(id, actor));
  }

  async listVolume(actor: InstanceActor, id: unknown, path: unknown) {
    return await listVolume(this.requireInstanceForActor(id, actor), String(path || ''));
  }

  async mkdirVolume(actor: InstanceActor, id: unknown, path: unknown) {
    await volMkdir(this.requireInstanceForActor(id, actor), String(path || ''));
    return { ok: true };
  }

  async moveVolume(actor: InstanceActor, id: unknown, from: unknown, to: unknown) {
    await volMove(this.requireInstanceForActor(id, actor), String(from || ''), String(to || ''));
    return { ok: true };
  }

  async deleteVolumePath(actor: InstanceActor, id: unknown, path: unknown) {
    await volDelete(this.requireInstanceForActor(id, actor), String(path || ''));
    return { ok: true };
  }

  async downloadVolumeFile(actor: InstanceActor, id: unknown, path: unknown) {
    const volumePath = String(path || '');
    const filename = volumePath.split('/').filter(Boolean).pop() || 'file';
    return {
      filename,
      body: await volDownloadFile(this.requireInstanceForActor(id, actor), volumePath, this.upload.volumeFileDownloadBytes),
    };
  }

  async uploadVolumeFile(actor: InstanceActor, id: unknown, path: unknown, name: unknown, stream: NodeJS.ReadableStream, size: number) {
    await volUploadFile(this.requireInstanceForActor(id, actor), String(path || ''), String(name || '').trim(), stream, size);
    return { ok: true };
  }

  async extractVolumeArchive(
    actor: InstanceActor,
    id: unknown,
    path: unknown,
    stream: NodeJS.ReadableStream,
    gzip: boolean,
    maxExtractedBytes: number,
  ) {
    await volExtractArchive(this.requireInstanceForActor(id, actor), String(path || ''), stream, gzip, maxExtractedBytes);
    return { ok: true };
  }

  async backupVolume(actor: InstanceActor, id: unknown) {
    const inst = this.requireInstanceForActor(id, actor);
    return {
      filename: `woc-${inst.name}-backup.tar.gz`,
      body: await volBackupStream(inst),
    };
  }

  async restoreVolume(actor: InstanceActor, id: unknown, stream: NodeJS.ReadableStream, gzip: boolean, maxExtractedBytes: number) {
    await volRestoreArchive(this.requireInstanceForActor(id, actor), stream, gzip, maxExtractedBytes);
    return { ok: true };
  }

  async getAppStatus(actor: InstanceActor, id: unknown) {
    return { status: await appStatus(this.requireInstanceForActor(id, actor)) };
  }

  async triggerAppInstall(actor: InstanceActor, id: unknown, command: 'install' | 'update') {
    await triggerAppInstall(this.requireInstanceForActor(id, actor), command);
    return { ok: true };
  }

  async ensureNetwork(): Promise<void> {
    await ensureNetwork();
  }

  async startRegisteredInstances(log: { warn(message: string): void }): Promise<void> {
    for (const inst of listInstances()) {
      try {
        await ensureRunning(inst);
      } catch (e: any) {
        log.warn(`[instance] 启动实例 ${inst.id} 失败: ${e?.message || e}`);
      }
    }
  }

  effectiveLimits(inst: Instance): { soft: number; hard: number } {
    return {
      soft: inst.memSoftLimitMB ?? this.watchdog.defaultSoftMB,
      hard: inst.memHardLimitMB ?? this.watchdog.defaultHardMB,
    };
  }

  private assertMemoryLimits(soft: number | null, hard: number | null): void {
    if (soft != null && hard != null && soft >= hard) {
      throw httpError(400, 'soft 阈值需小于 hard 阈值');
    }
    if (this.watchdog.hardMaxMB > 0 && hard != null && hard > this.watchdog.hardMaxMB) {
      throw httpError(400, `hard 阈值不能超过实例容器内存上限 ${this.watchdog.hardMaxMB} MiB`);
    }
  }

  private requireAdmin(actor: InstanceActor): void {
    if (!actor.isAdmin) throw httpError(403, '需要管理员权限');
  }

  private async normalizeReuseVolume(reuseVolume: unknown, actor: InstanceActor, appType: Instance['appType']): Promise<string | undefined> {
    if (reuseVolume == null || reuseVolume === false || reuseVolume === '') return undefined;
    this.requireAdmin(actor);
    if (typeof reuseVolume !== 'string' || !VOLUME_NAME_RE.test(reuseVolume)) {
      throw httpError(400, '复用卷名不合法');
    }
    if (listInstances().some((inst) => inst.volumeName === reuseVolume)) {
      throw httpError(409, '该数据卷已被另一个实例占用');
    }
    const retained = findUnusedVolumeOwnership(reuseVolume);
    let volumeAppType = retained?.appType;
    if (!volumeAppType) {
      try {
        volumeAppType = await inspectVolumeAppType(reuseVolume);
      } catch (e: any) {
        throw httpError(400, e?.message || '读取数据卷应用归属失败');
      }
    }
    if (!volumeAppType) {
      throw httpError(409, `数据卷 ${reuseVolume} 缺少应用归属标记，不能复用`);
    }
    if (volumeAppType !== appType) {
      throw httpError(409, `数据卷 ${reuseVolume} 属于 ${appLabel(volumeAppType)}，只能创建${appLabel(volumeAppType)}实例`);
    }
    return reuseVolume;
  }
}

const APP_LABELS: Record<Instance['appType'], string> = {
  wechat: '微信',
  qq: 'QQ',
  telegram: 'Telegram',
  chromium: 'Chromium',
};

function appLabel(appType: Instance['appType']): string {
  return APP_LABELS[appType];
}

function parseLimitPatch(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw httpError(400, `${field} 阈值必须是数字或 null`);
  }
  return Math.round(value);
}
