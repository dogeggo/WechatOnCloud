import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type DesktopFile } from '../../api';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

function dragHasFiles(event: globalThis.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

export function useDesktopFiles({
  active,
  showVnc,
  id,
}: {
  active: boolean;
  showVnc: boolean;
  id: string | undefined;
}) {
  const { toast, confirm } = useUI();
  const [dragging, setDragging] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<DesktopFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    setDragging(false);
    setShowFiles(false);
    setFiles([]);
  }, [id]);

  useEffect(() => {
    if (!active || !showVnc) return;
    const onEnter = (event: globalThis.DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (event: globalThis.DragEvent) => {
      if (dragHasFiles(event)) event.preventDefault();
    };
    const onLeave = (event: globalThis.DragEvent) => {
      if (!dragHasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDropWindow = (event: globalThis.DragEvent) => {
      if (dragHasFiles(event)) event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropWindow);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropWindow);
    };
  }, [active, showVnc]);

  const refreshFiles = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.listFiles(id);
      setFiles(result.files);
    } catch (error) {
      toast(errorMessage(error, '读取文件列表失败'), 'error');
    }
  }, [id, toast]);

  const uploadFiles = useCallback(
    async (list: FileList | File[]) => {
      if (!id) return;
      const selected = Array.from(list);
      if (!selected.length) return;
      setUploading(true);
      let successCount = 0;
      for (const file of selected) {
        try {
          await api.uploadFile(id, file);
          successCount++;
        } catch (error) {
          toast(`${file.name}: ${errorMessage(error, '上传失败')}`, 'error');
        }
      }
      setUploading(false);
      if (successCount) {
        toast(`已上传 ${successCount} 个文件到桌面，应用里可直接选取`, 'ok');
        await refreshFiles();
      }
    },
    [id, refreshFiles, toast],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      dragDepth.current = 0;
      if (event.dataTransfer.files?.length) void uploadFiles(event.dataTransfer.files);
    },
    [uploadFiles],
  );

  const deleteFile = useCallback(
    async (name: string) => {
      if (!id) return;
      const ok = await confirm({
        title: `删除「${name}」？`,
        body: '将从应用桌面（~/Desktop）移除该文件。',
        danger: true,
        confirmText: '删除',
      });
      if (!ok) return;
      try {
        await api.deleteFile(id, name);
        toast('已删除', 'ok');
        await refreshFiles();
      } catch (error) {
        toast(errorMessage(error, '删除失败'), 'error');
      }
    },
    [confirm, id, refreshFiles, toast],
  );

  const toggleFiles = useCallback(() => {
    setShowFiles((visible) => {
      if (!visible) void refreshFiles();
      return !visible;
    });
  }, [refreshFiles]);

  return {
    dragging,
    showFiles,
    setShowFiles,
    files,
    uploading,
    fileInput,
    refreshFiles,
    uploadFiles,
    onDrop,
    deleteFile,
    toggleFiles,
  };
}
