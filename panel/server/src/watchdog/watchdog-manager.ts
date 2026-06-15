import type { FastifyBaseLogger } from 'fastify';
import {
  instanceMemoryMB,
  instanceRuntime,
  runInstance,
  stopInstance,
} from '../docker/docker.js';
import type { WatchdogConfig } from '../config/panel-config.js';
import type { ControlManager } from '../instance/control-manager.js';
import type { InstanceManager } from '../instance/instance-manager.js';
import { findInstance, listInstances, type Instance } from '../instance/store.js';

export function startWatchdog(
  config: WatchdogConfig,
  instances: InstanceManager,
  control: ControlManager,
  log: FastifyBaseLogger,
): void {
  if (!config.enabled) return;

  const recovering = new Set<string>();

  const recover = async (inst: Instance, reason: string, detail: string) => {
    recovering.add(inst.id);
    log.warn(`[watchdog] ${inst.containerName} ${detail}`);
    try {
      await stopInstance(inst);
      await runInstance(inst);
      log.info(`[watchdog] ${inst.containerName} 自愈完成（${reason}）`);
    } catch (e: any) {
      log.error(`[watchdog] ${inst.containerName} 自愈失败（${reason}）: ${e?.message || e}`);
    } finally {
      recovering.delete(inst.id);
    }
  };

  const tick = async () => {
    for (const pub of listInstances()) {
      const inst = findInstance(pub.id);
      if (!inst || recovering.has(inst.id)) continue;
      try {
        if ((await instanceRuntime(inst)) !== 'running') {
          continue;
        }

        const mb = await instanceMemoryMB(inst);
        if (mb > 0) {
          const { soft, hard } = instances.effectiveLimits(inst);
          const active = control.hasActiveSession(inst.id);
          if (hard > 0 && mb >= hard) {
            await recover(inst, 'hard', `mem=${mb}MiB >= hard=${hard}MiB，强制重启（active=${active}）`);
            continue;
          }
          if (soft > 0 && mb >= soft && !active) {
            await recover(inst, 'soft', `mem=${mb}MiB >= soft=${soft}MiB 且无活跃会话，柔和重启`);
            continue;
          }
          if (soft > 0 && mb >= soft && active) {
            log.info(`[watchdog] ${inst.containerName} mem=${mb}MiB >= soft=${soft}MiB 但用户在使用，延后`);
          }
        }
      } catch (e: any) {
        log.warn(`[watchdog] ${pub.id} 检查异常: ${e?.message || e}`);
      }
    }
  };

  setInterval(() => void tick(), config.intervalSec * 1000).unref();
  log.info(
    `[watchdog] 已启用 · soft=${config.defaultSoftMB} MiB · hard=${config.defaultHardMB} MiB · 间隔=${config.intervalSec}s`,
  );
}
