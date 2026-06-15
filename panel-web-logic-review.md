# panel/web 前端逻辑分析

## 分析范围

- 目录：`panel/web`
- 重点文件：
  - `panel/web/src/pages/Admin.tsx`
  - `panel/web/src/pages/Desktop.tsx`
  - `panel/web/src/features/admin/*`
  - `panel/web/src/features/desktop/*`
  - `panel/web/src/features/instances/*`

## 可以优化的逻辑

### 管理页组件职责过重

`panel/web/src/pages/Admin.tsx` 当前约 889 行，除了 `Admin` 页面主体外，还包含以下多类逻辑：

- 实例重命名弹窗：`RenameInstance`
- 内存安全 / machine-id 弹窗：`InstanceSecurity`
- 删除实例弹窗：`DeleteInstance`
- 实例管理卡片：`InstanceAdminCard`
- 图标裁剪工具函数：`cropToDataUrl`
- 图标编辑弹窗：`InstanceIconEditor`
- 数据卷管理弹窗：`VolumeManager`
- 创建实例弹窗：`CreateInstance`

这些逻辑已经有部分业务状态被抽到 `features/admin` hook 中，例如 `useCreateInstance`、`useVolumeManager`、`useInstanceSecurity`，但展示组件、文件裁剪、数据卷浏览 UI、实例卡片动作仍集中在同一个页面文件里。后续继续增加实例管理能力时，`Admin.tsx` 会成为高冲突、高认知成本文件。

建议优化方向：

- 将 `RenameInstance`、`InstanceSecurity`、`DeleteInstance`、`InstanceIconEditor`、`VolumeManager`、`CreateInstance` 拆到 `panel/web/src/features/admin/components/`。
- 将 `cropToDataUrl` 这类纯工具逻辑移动到 `panel/web/src/features/admin/iconCrop.ts` 或 `panel/web/src/utils/image.ts`。
- 保留 `Admin.tsx` 只负责页面编排、弹窗开关状态和列表渲染入口。

预期收益：

- 降低单文件修改冲突。
- 页面层更接近“业务编排”，组件层更接近“展示和交互”。
- 图标裁剪、数据卷管理等逻辑可以单独测试或复用。

## 存在的 bug

### `InstanceView` 在 render 阶段触发路由跳转

位置：`panel/web/src/pages/Desktop.tsx:112`

当前逻辑：

```tsx
if (!id) {
  nav('/', { replace: true });
  return null;
}
```

问题：

- `nav()` 本质会更新 router 状态，属于副作用。
- 这段代码发生在组件 render 阶段，而不是 `useEffect` 或 `<Navigate />` 中。
- 在 React StrictMode、并发渲染或异常路由参数场景下，可能触发 “渲染期间更新其他组件状态” 的警告，也可能导致导航时机不稳定。

建议修复方向：

优先使用声明式跳转：

```tsx
if (!id) {
  return <Navigate to="/" replace />;
}
```

如果需要保留命令式导航，则应放入 `useEffect`：

```tsx
useEffect(() => {
  if (!id) nav('/', { replace: true });
}, [id, nav]);
```

并在 render 中只返回 `null` 或加载态。

