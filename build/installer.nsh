; DYdown 自定义 NSIS 卸载脚本
;
; 卸载时询问是否删除应用数据（登录状态 / 设置 / 下载清单等）。
; 数据目录位于 %APPDATA%\dydown（Electron 的 userData，取自 package.json 的 name）。
;
; - 交互卸载：弹窗询问，选「是」删除、「否」保留；
; - 静默卸载（/S）：按 /SD IDNO 默认「保留」（安全默认，避免自动化场景误删）；
; - 命令行传入 --delete-app-data 时仍由 electron-builder 框架段删除（与配置无关）。
;
; 注意：electron-builder 的 deleteAppDataOnUninstall 保持 false（不用框架的无条件删除），
; 完全由本宏接管询问逻辑。

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除应用数据？$\r$\n$\r$\n将删除：登录状态、设置、下载清单与缓存（位于 %APPDATA%\dydown）。$\r$\n选择「否」将保留这些数据，以后重装可以继续使用。" \
    /SD IDNO IDYES dydownDeleteData IDNO dydownKeepData

  dydownDeleteData:
    RMDir /r "$APPDATA\dydown"
    Goto dydownUninstallDone

  dydownKeepData:
    ; 保留数据：不做任何事

  dydownUninstallDone:
!macroend
