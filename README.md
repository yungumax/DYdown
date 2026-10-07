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

## 使用说明

1. **下载单条视频 / 图集**：复制抖音分享链接或整段分享口令，粘贴到「解析」输入框点「开始解析」，勾选后点「下载所选」。
2. **批量下载某个博主**：粘贴用户主页链接解析后，点「加载全部」；弹出的窗口会**自动加载全部作品**（也可用鼠标滚轮辅助），加载完点窗口底部「完成加载」回传，再全选或挑着下载。
3. **下载合集 / 系列**：粘贴主页「合集」标签页链接（或从合集里点开视频后复制的链接），解析后列出全部合集；点「加载视频」拉取某个合集的全部集数，或「展开全部合集」逐个加载。视频列表展开在合集卡片下方，可折叠、可一键「下载合集」。
4. **下载管理**：「传输」页可暂停 / 继续单个任务，或「全部暂停 / 全部开始」；中断任务支持断点续传。
5. **登录（可选）**：标题栏右上角「免登录」扫码登录。登录后主页与合集解析更稳定、清晰度档位更完整（登录默认 4K 优先，未登录 1080P 优先）。
6. **设置与更新**：「设置」页修改保存目录 / 清晰度 / 命名规则；「检查更新」检测到新版本后应用内一键升级。

> 提示：解析与下载全部在本机直连抖音完成，不经过任何第三方服务。

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
