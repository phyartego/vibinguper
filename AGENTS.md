# vibinguper/AGENTS.md — Electron 上位机子模块

本文件继承仓库根 `AGENTS.md`，适用于 `vibinguper/`。

这是独立维护的 Electron + React + TypeScript Git submodule。除非用户明确要求，不要在固件任务中改动子模块内部内容、升级 submodule 指针或重写其依赖锁文件。

常用验证命令在 `vibinguper/` 内执行：

```powershell
npm run typecheck
npm run build
```

涉及打包、原生模块或发布脚本时，再按 `package.json` 选择 `rebuild-natives`、`release:*` 或对应断言。UI、IPC、BLE、终端和工作区读取逻辑按现有目录边界维护；跨端协议变更必须同步检查根 `docs/` 的 BLE/CDC 契约和固件调用方。

不要提交 `node_modules/`、构建产物、发布目录、测试报告或本地配置。
