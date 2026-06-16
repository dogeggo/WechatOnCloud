import { useRef, useState, type ChangeEvent } from 'react';
import Cropper from 'react-easy-crop';
import { api, type InstanceWithStatus, type PanelInstance } from '../../../api';
import { ICON_CHOICES, InstanceIcon } from '../../../AppIcon';
import { useUI } from '../../../ui';
import { errorMessage } from '../../../utils/errors';
import { cropToDataUrl, type CropArea } from '../iconCrop';

export function InstanceIconEditor({
  inst,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onDone: (instance: PanelInstance) => void;
}) {
  const { toast } = useUI();
  const [selected, setSelected] = useState(inst.icon || '');
  const [busy, setBusy] = useState(false);
  const [cropSrc, setCropSrc] = useState('');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropArea | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('图片不能超过 8MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCropSrc(String(reader.result));
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setArea(null);
    };
    reader.onerror = () => toast('读取图片失败', 'error');
    reader.readAsDataURL(file);
  };

  const confirmCrop = async () => {
    if (!cropSrc || !area) return;
    try {
      setSelected(await cropToDataUrl(cropSrc, area));
      setCropSrc('');
    } catch (error) {
      toast(errorMessage(error, '裁剪失败'), 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const { instance } = await api.setInstanceIcon(inst.id, selected || null);
      toast('已保存图标', 'ok');
      onDone(instance);
      onClose();
    } catch (error) {
      toast(errorMessage(error, '保存失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2>图标 · {inst.name}</h2>
        {cropSrc ? (
          <>
            <div className="icon-crop">
              <Cropper
                image={cropSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, nextArea) => setArea(nextArea)}
              />
            </div>
            <input className="icon-zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCropSrc('')}>
                返回
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmCrop} disabled={!area}>
                裁剪并使用
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="icon-edit-top">
              <InstanceIcon icon={selected || undefined} appType={inst.appType} size={56} radius={14} />
              <div className="muted small">
                {selected.startsWith('data:') ? '自定义图片' : selected.startsWith('builtin:') ? '内置图标' : '应用默认'}
              </div>
            </div>
            <div className="field-label">内置图标</div>
            <div className="icon-grid">
              <button type="button" className={'icon-pick' + (selected === '' ? ' sel' : '')} onClick={() => setSelected('')}>
                <InstanceIcon appType={inst.appType} size={38} radius={11} />
                <span>默认</span>
              </button>
              {ICON_CHOICES.map((choice) => (
                <button
                  type="button"
                  key={choice.key}
                  className={'icon-pick' + (selected === `builtin:${choice.key}` ? ' sel' : '')}
                  onClick={() => setSelected(`builtin:${choice.key}`)}
                >
                  <InstanceIcon icon={`builtin:${choice.key}`} size={38} radius={11} />
                  <span>{choice.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              上传图片并裁剪...
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                保存
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
