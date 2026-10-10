# vibinguper

Electron + React + TypeScript 子模块。用户未明确要求时，不改子模块内容、不升级指针、不重写依赖锁。验证在本目录：`npm run typecheck`、`npm run build`。打包、原生模块或发布再按 `package.json` 选 `rebuild-natives`、`release:*` 或对应断言。UI、IPC、BLE、终端、工作区按现有目录边界。跨端协议改动同时查根 `docs/` 的 BLE/CDC 契约和固件调用方。插件页「保存」是 Ctrl+S（`run=false`，只写草稿，不改开机版本，也不停正在跑的实例），「保存并运行」是 Ctrl+Shift+S（`run=true`，20 秒内 `vibing.confirm()` 后才成为开机版本）。启用/停用走 `PLUGIN_ENABLE` `0x0064`；启用拉起已确认版本。USB `SESSION_FOCUS` `0x0204` 与 BLE FocusCmd 共用 `handleFocus`，500ms 内同一短 id 只聚焦一次。不提交 `node_modules/`、构建产物、发布目录、测试报告、本地配置。
