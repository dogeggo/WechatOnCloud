import {
  createInstance,
  findInstance,
  listInstances,
  normalizeAppType,
  publicInstance,
  removeInstance as removeInstanceRecord,
  renameInstance,
  setInstanceIcon,
  setInstanceMemLimits,
  setInstanceVncServerProfile,
  type Instance,
} from './store.js';
import {
  deleteInstanceFile,
  downloadFromInstance,
  ensureRunning,
  instanceLogs,
  instanceMemoryMB,
  instanceRuntime,
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
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
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

  async listWithStatus() {
    const rows = await Promise.all(
      listInstances().map(async (inst) => {
        const [runtime, status] = await Promise.all([instanceRuntime(inst), appStatus(inst)]);
        return { ...publicInstance(inst), runtime, app: status };
      }),
    );
    return { instances: rows };
  }

  async createForUser(name: unknown, createdBy: string, reuseVolume: unknown, appType: unknown) {
    const reuseVolumeName = this.normalizeReuseVolume(reuseVolume);
    let inst: Instance;
    try {
      inst = createInstance(String(name ?? ''), createdBy, reuseVolumeName, normalizeAppType(appType));
    } catch (e: any) {
      throw httpError(400, e?.message || '创建实例失败');
    }

    try {
      await runInstance(inst);
    } catch (e: any) {
      removeInstanceRecord(inst.id);
      throw httpError(500, '创建容器失败：' + (e?.message || e));
    }
    return { instance: publicInstance(inst) };
  }

  async listUnusedVolumes() {
    const referenced = new Set(listInstances().map((inst) => inst.volumeName));
    return { volumes: await listOrphanVolumes(referenced) };
  }

  async listUnusedContainers() {
    const known = new Set(listInstances().map((inst) => inst.containerName));
    return { containers: await listOrphanContainers(known) };
  }

  async removeUnusedContainer(idOrName: unknown) {
    if (!idOrName || typeof idOrName !== 'string') throw httpError(400, '参数不合法');
    const known = new Set(listInstances().map((inst) => inst.containerName));
    if (known.has(idOrName)) throw httpError(409, '该容器属于现存实例，不能在此删除');
    await removeContainerById(idOrName, known);
    return { ok: true };
  }

  async removeUnusedVolume(name: unknown) {
    if (!name || typeof name !== 'string' || !VOLUME_NAME_RE.test(name)) {
      throw httpError(400, '卷名不合法');
    }
    if (listInstances().some((inst) => inst.volumeName === name)) {
      throw httpError(409, '该数据卷正被某个实例使用，不能删除');
    }
    await removeVolume(name);
    return { ok: true };
  }

  async memoryLimits(id: unknown): Promise<MemoryLimitInfo> {
    const inst = this.requireInstance(id);
    const currentMB = (await instanceRuntime(inst)) === 'running' ? await instanceMemoryMB(inst) : 0;
    return {
      soft: inst.memSoftLimitMB ?? null,
      hard: inst.memHardLimitMB ?? null,
      defaultSoft: this.watchdog.defaultSoftMB,
      defaultHard: this.watchdog.defaultHardMB,
      currentMB,
      watchdogEnabled: this.watchdog.enabled,
      intervalSec: this.watchdog.intervalSec,
    };
  }

  updateMemoryLimits(id: unknown, body: any) {
    const inst = this.requireInstance(id);
    const soft = parseLimitPatch(body?.soft, 'soft');
    const hard = parseLimitPatch(body?.hard, 'hard');
    const finalSoft = soft === undefined ? inst.memSoftLimitMB ?? null : soft;
    const finalHard = hard === undefined ? inst.memHardLimitMB ?? null : hard;
    try {
      return { instance: setInstanceMemLimits(inst.id, finalSoft, finalHard) };
    } catch (e: any) {
      throw httpError(400, e?.message || '阈值不合法');
    }
  }

  async updateVncServerProfile(id: unknown, body: any) {
    const inst = this.requireInstance(id);
    let instance;
    try {
      instance = setInstanceVncServerProfile(inst.id, body?.profile);
    } catch (e: any) {
      throw httpError(400, e?.message || 'VNC 服务端档位不合法');
    }
    await runInstance(this.requireInstance(inst.id));
    return { instance };
  }

  async regenerateMachineId(id: unknown) {
    await regenInstanceMachineId(this.requireInstance(id));
    return { ok: true };
  }

  async remove(id: unknown, purge: boolean) {
    const inst = this.requireInstance(id);
    await removeInstanceContainer(inst, purge);
    removeInstanceRecord(inst.id);
    return { ok: true };
  }

  rename(id: unknown, name: unknown) {
    try {
      return { instance: renameInstance(String(id || ''), String(name ?? '')) };
    } catch (e: any) {
      throw httpError(400, e?.message || '重命名失败');
    }
  }

  setIcon(id: unknown, icon: unknown) {
    const inst = this.requireInstance(id);
    try {
      return { instance: setInstanceIcon(inst.id, icon) };
    } catch (e: any) {
      throw httpError(400, e?.message || '设置图标失败');
    }
  }

  async start(id: unknown) {
    await ensureRunning(this.requireInstance(id));
    return { ok: true };
  }

  async stop(id: unknown) {
    await stopInstance(this.requireInstance(id));
    return { ok: true };
  }

  async restart(id: unknown) {
    await runInstance(this.requireInstance(id));
    return { ok: true };
  }

  async upgrade(id: unknown) {
    await upgradeInstance(this.requireInstance(id));
    return { ok: true };
  }

  async uploadTransferFile(id: unknown, name: unknown, stream: NodeJS.ReadableStream, size: number) {
    await uploadToInstance(this.requireInstance(id), String(name || '').trim(), stream, size);
    return { ok: true };
  }

  async listTransferFiles(id: unknown) {
    return { files: await listInstanceFiles(this.requireInstance(id)) };
  }

  async deleteTransferFile(id: unknown, name: unknown) {
    await deleteInstanceFile(this.requireInstance(id), String(name || '').trim());
    return { ok: true };
  }

  async downloadTransferFile(id: unknown, name: unknown) {
    const filename = String(name || '').trim();
    return {
      filename,
      body: await downloadFromInstance(this.requireInstance(id), filename, this.upload.transferDownloadBytes),
    };
  }

  async typeText(id: unknown, text: unknown, submit: unknown, submitKey: unknown) {
    const value = String(text ?? '');
    if (!value || value.length > 500) throw httpError(400, '文字为空或过长');
    await typeInInstance(this.requireInstance(id), value, {
      submit: submit === true,
      submitKey: submitKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    });
    return { ok: true };
  }

  async keyInput(id: unknown, key: unknown) {
    const value = String(key ?? '');
    if (!/^[A-Za-z_]{1,20}$/.test(value)) throw httpError(400, '按键名不合法');
    await keyInInstance(this.requireInstance(id), value);
    return { ok: true };
  }

  async logs(id: unknown) {
    return await instanceLogs(this.requireInstance(id));
  }

  async listVolume(id: unknown, path: unknown) {
    return await listVolume(this.requireInstance(id), String(path || ''));
  }

  async mkdirVolume(id: unknown, path: unknown) {
    await volMkdir(this.requireInstance(id), String(path || ''));
    return { ok: true };
  }

  async moveVolume(id: unknown, from: unknown, to: unknown) {
    await volMove(this.requireInstance(id), String(from || ''), String(to || ''));
    return { ok: true };
  }

  async deleteVolumePath(id: unknown, path: unknown) {
    await volDelete(this.requireInstance(id), String(path || ''));
    return { ok: true };
  }

  async downloadVolumeFile(id: unknown, path: unknown) {
    const volumePath = String(path || '');
    const filename = volumePath.split('/').filter(Boolean).pop() || 'file';
    return {
      filename,
      body: await volDownloadFile(this.requireInstance(id), volumePath, this.upload.volumeFileDownloadBytes),
    };
  }

  async uploadVolumeFile(id: unknown, path: unknown, name: unknown, stream: NodeJS.ReadableStream, size: number) {
    await volUploadFile(this.requireInstance(id), String(path || ''), String(name || '').trim(), stream, size);
    return { ok: true };
  }

  async extractVolumeArchive(
    id: unknown,
    path: unknown,
    stream: NodeJS.ReadableStream,
    gzip: boolean,
    maxExtractedBytes: number,
  ) {
    await volExtractArchive(this.requireInstance(id), String(path || ''), stream, gzip, maxExtractedBytes);
    return { ok: true };
  }

  async backupVolume(id: unknown) {
    const inst = this.requireInstance(id);
    return {
      filename: `woc-${inst.name}-backup.tar.gz`,
      body: await volBackupStream(inst),
    };
  }

  async restoreVolume(id: unknown, stream: NodeJS.ReadableStream, gzip: boolean, maxExtractedBytes: number) {
    await volRestoreArchive(this.requireInstance(id), stream, gzip, maxExtractedBytes);
    return { ok: true };
  }

  async getAppStatus(id: unknown) {
    return { status: await appStatus(this.requireInstance(id)) };
  }

  async triggerAppInstall(id: unknown, command: 'install' | 'update') {
    await triggerAppInstall(this.requireInstance(id), command);
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

  private normalizeReuseVolume(reuseVolume: unknown): string | undefined {
    if (reuseVolume == null || reuseVolume === false || reuseVolume === '') return undefined;
    if (typeof reuseVolume !== 'string' || !VOLUME_NAME_RE.test(reuseVolume)) {
      throw httpError(400, '复用卷名不合法');
    }
    if (listInstances().some((inst) => inst.volumeName === reuseVolume)) {
      throw httpError(409, '该数据卷已被另一个实例占用');
    }
    return reuseVolume;
  }
}

function parseLimitPatch(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw httpError(400, `${field} 阈值必须是数字或 null`);
  }
  return Math.round(value);
}
