# DYdown · 抖音视频无水印下载（桌面版）

**Windows EXE 桌面工具**，主题为抖音黑（纯黑底 + 抖音红 `#FE2C55` / 抖音青 `#25F4EE`），内置应用内自动更新。

> 主仓库：<https://github.com/yungumax/DYdown>

## 功能

- **首启引导页**：安装后第一次打开引导配置保存目录、清晰度、背景音乐与文案开关
- **解析**：粘贴抖音分享链接或整段口令（每行一个，自动去重），解析后进「选择内容」表格勾选下载
- **下载**：无水印视频 mp4 / 图集原图逐张 / 背景音乐 mp3 / 文案 txt；并发任务、进度条、取消、重名处理
- **传输**：队列状态、实时速度、打开文件 / 打开位置
- **设置**：保存目录、命名模板与魔法变量、文件夹层级、并发重试限速、应用更新、主题（抖音黑默认 / 浅色 / 跟随系统）
- **自动更新**：electron-updater + GitHub Releases；设置里可手动检测 → 下载（带进度）→ 立即重启安装
- **本地解析引擎**：短链跳转 → ttwid Cookie → 分享页数据直连提取，不经过任何第三方接口

## 开发

前置：Node.js 18+。

```bash
npm install
npm run dev        # 仅前端（浏览器预览，后端能力受限）
npm start          # 构建 + 打开 Electron 窗口（完整功能）
```

## 打包 EXE

```bash
npm run dist       # vite 构建 + 生成图标 + electron-builder 打包
```

产物在 `dist/`：`DYdown-Setup-1.0.0.exe`（NSIS 静默安装包，**应用内自动更新只支持安装版**）+ `latest.yml` + blockmap。

## 发布新版本（自动更新生效流程）

1. 改 `package.json` 的 `version`
2. `git add . && git commit -m "release: v1.0.1" && git tag v1.0.1 && git push origin main --tags`
3. GitHub Actions 自动打包并发布 Release（含 exe + latest.yml）
4. 已安装用户在设置里检测更新即可应用内升级

> 首次推送前：仓库 Settings → Actions → Workflow permissions 选 "Read and write permissions"。

## 目录结构

```
DYdown/
├── main.cjs              # Electron 主进程：无边框窗口 / IPC / 自动更新
├── preload.cjs           # 渲染进程安全桥（窗口控制/剪贴板/目录/更新）
├── server.cjs            # 本地服务：静态托管 + 抖音解析 + 下载队列 + SSE 进度
├── vite.config.js        # 前端构建（输出 dist-web/）
├── scripts/gen-icon.js   # 应用图标生成
├── build/icon.ico        # 应用图标
├── .github/workflows/release.yml  # 打 tag 自动构建发布
├── public/fonts/         # 钉钉进步体（备用字体）
└── src/                  # Vue 3 前端
    ├── components/       # TitleBar / Sidebar / Onboarding / TaskRow / StepHeader / Icon
    ├── pages/            # ParsePage / TransferPage / SettingsPage / AboutPage
    ├── api.js            # 后端接口层（HTTP + dybridge）
    └── styles.css        # 设计令牌（抖音黑）
```

## 免责声明

仅供个人学习与离线观看使用，请遵守抖音用户协议，不要用于传播或商业用途。内容版权归原作者所有。
