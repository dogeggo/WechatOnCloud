import { useState } from "react";
import type { InstanceWithStatus } from "../../../api";
import { InstanceIcon } from "../../../AppIcon";
import { Icons } from "../../../components/icons";
import {
  adminCardState,
  appProfile,
  type AppInstallAction,
} from "../../../domain/instances";
import { vncServerProfileLabel } from "../../../domain/vncServerProfile";

export function InstanceAdminCard({
  inst,
  acting,
  onEnter,
  onTrigger,
  onStart,
  onStop,
  onRestart,
  onUpgrade,
  onRename,
  onIcon,
  onLogs,
  onDelete,
  onSecurity,
  onVncServerProfile,
  onVolume,
  showOwner = false,
}: {
  inst: InstanceWithStatus;
  acting?: string;
  onEnter: () => void;
  onTrigger: (inst: InstanceWithStatus, kind: AppInstallAction) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onUpgrade: () => void;
  onRename: () => void;
  onIcon: () => void;
  onLogs: () => void;
  onDelete: () => void;
  onSecurity: () => void;
  onVncServerProfile: () => void;
  onVolume: () => void;
  showOwner?: boolean;
}) {
  const appStatus = inst.app;
  const profile = appProfile(inst.appType);
  const { badge, sub, installed, offline, working } = adminCardState(
    inst,
    acting,
  );
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="inst-card">
      <div className="inst-head">
        <div className="inst-title">
          <span className="inst-avatar">
            <InstanceIcon
              icon={inst.icon}
              appType={inst.appType}
              size={40}
              radius={12}
            />
          </span>
          <span className="inst-name">{inst.name}</span>
        </div>
        <span className={"tag " + badge.cls}>{badge.text}</span>
      </div>
      <div className="inst-sub">{sub}</div>
      <div className="inst-meta-line">
        {showOwner && <div>创建者：{inst.createdBy}</div>}
        <div>VNC编码：{vncServerProfileLabel(inst.vncServerProfile)}</div>
      </div>

      {working && (
        <div className="app-progress">
          <div
            className={
              "app-progress-bar" +
              (acting || appStatus.percent < 0 ? " indeterminate" : "")
            }
            style={
              !acting && appStatus.percent >= 0
                ? { width: `${appStatus.percent}%` }
                : undefined
            }
          />
        </div>
      )}

      {!working && (
        <>
          <div className="inst-actions">
            {offline ? (
              <button
                className="btn btn-primary inst-act-wide"
                onClick={onStart}
              >
                {inst.runtime === "missing" ? "创建并启动" : "启动实例"}
              </button>
            ) : (
              <button
                className="btn btn-primary inst-act-wide"
                disabled={!installed}
                onClick={onEnter}
                title={installed ? "" : profile.installButtonTitle}
              >
                进入实例
              </button>
            )}
          </div>

          <button
            className={"inst-menu-toggle" + (menuOpen ? " open" : "")}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span>管理</span>
            <span className="inst-menu-caret">{Icons.caret}</span>
          </button>

          {menuOpen && (
            <div className="inst-menu">
              <div className="inst-menu-group">
                <div className="inst-menu-label">运维</div>
                <div className="inst-menu-items">
                  {!offline && profile.needsInstall && (
                    <button
                      className="btn-text"
                      onClick={() =>
                        onTrigger(inst, installed ? "update" : "install")
                      }
                    >
                      {installed ? profile.updateLabel : "下载安装"}
                    </button>
                  )}
                  <button
                    className="btn-text"
                    onClick={onUpgrade}
                    title="拉取最新镜像并重建（保留应用数据）"
                  >
                    升级实例
                  </button>
                  {!offline && (
                    <button className="btn-text" onClick={onRestart}>
                      重启
                    </button>
                  )}
                  {!offline && (
                    <button className="btn-text" onClick={onStop}>
                      停止
                    </button>
                  )}
                </div>
              </div>
              <div className="inst-menu-group">
                <div className="inst-menu-label">设置</div>
                <div className="inst-menu-items">
                  <button className="btn-text" onClick={onRename}>
                    重命名
                  </button>
                  <button
                    className="btn-text"
                    onClick={onIcon}
                    title="设置实例图标"
                  >
                    图标
                  </button>
                  <button
                    className="btn-text"
                    onClick={onLogs}
                    title="查看实例容器日志"
                  >
                    日志
                  </button>
                  <button
                    className="btn-text"
                    onClick={onSecurity}
                    title="内存阈值自愈"
                  >
                    安全
                  </button>
                  <button
                    className="btn-text"
                    onClick={onVncServerProfile}
                    title="调整 KasmVNC 服务端编码参数，保存后重启实例容器"
                  >
                    VNC编码
                  </button>
                  <button
                    className="btn-text"
                    onClick={onVolume}
                    title="数据卷：备份/恢复、上传应用数据、文件管理"
                  >
                    数据卷
                  </button>
                </div>
              </div>
              <div className="inst-menu-group inst-menu-danger">
                <div className="inst-menu-items">
                  <button className="btn-text danger" onClick={onDelete}>
                    删除实例
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
