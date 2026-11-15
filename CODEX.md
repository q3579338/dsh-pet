# 大肥鱼 · Codex 适配版

基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的独立应用分支，基线版本为 `0.4.9`（`95aea3fba77259697d9ccd2121bfeb91d9ae4541`）。保留原版角色、114 段 WebM 动画、表情包、角色提示词、聊天记忆，以及原有点击、拖拽、抛掷、睡觉、漫游、多开与右键设置逻辑。新增连接层使用本机 Codex，不需要安装 DeepSeek Harness。

这是社区项目的 Codex 适配分支；原项目中的大肥鱼本身也是社区二创形象，并非 DeepSeek 或 OpenAI 官方桌宠。

## Windows 使用

1. 将整个 Windows 压缩包解压到一个目录，双击 `Codex-BigFish.exe`。旁边的 `resources` 等文件必须一起保留。
   升级前先从托盘退出旧版；同一数据目录只运行一个实例。设置页底部可核对版本号。`0.4.9-codex.5` 增加独立的原生聊天窗口，双击大肥鱼、右键「对话／语音对话」或托盘「打开聊天／语音」都能打开；重复打开复用窗口并保留草稿。原拖拽、抛掷和单击动画保留；弹弓手势改用 Shift 加双击按下。
2. 本机需已有可运行并已登录的 Codex。默认自动寻找 `codex.exe`，也识别指向它的 Windows `codex.cmd`。找不到时，可用环境变量 `DSH_PET_CODEX_PATH` 指定可执行文件的完整路径，然后重新打开大肥鱼。
3. 右键大肥鱼，打开 AI 设置，协议选择「本机 Codex（沿用已有登录）」，点击检查连接。模型为 `default` 时跟随本机 Codex 默认设置，也可读取当前账号可用的模型列表。
4. 打开原版聊天面板即可聊天。聊天和开启后的自动碎碎念会使用当前 Codex 连接的额度或计费。初次启动默认关闭自动碎碎念；可在宠物设置中自行开启，原版功能仍然保留。
5. 在配置页点击「刷新 Codex 额度与用量」，查看当前套餐、接口提供的窗口剩余额度和重置时间、额外 Credits、重置次数及 Token 活动。右键原来的余额菜单也能查询，点击气泡可在额度和统计页面之间切换。
6. 聊天窗口可「按住说话」；松开后识别结果填入输入框，检查后再发送。`0.4.9-codex.6` 固定录音提示所占空间，避免录音开始、结束或报错时话筒按钮挪动。悬停大肥鱼按 M 可打开语音对话窗口，再按住窗口的话筒。`0.4.9-codex.7` 首次启动默认使用原版「晓伊」联网朗读，录音继续使用 Windows 本机中文识别；已有音色选择会保留。手动播报控制聊天回复是否自动念出，每条回复旁也可点击喇叭朗读。已有明确关闭的设置会保留，可在「桌宠配置 → 语音」开启。自动碎碎念、通知和待办的播报开关继续独立。
7. 托盘「Codex 额度与设置」打开同一窗口的连接页，可查询真实额度、用量、可用模型并检查连接。需要直接打开聊天时，可以使用 `Codex-BigFish.exe --chat`；程序已运行时也会打开现有聊天窗口。默认仅启动桌宠，不自动抢键盘焦点。
8. 在「配置 → 语音 → 音色」选择后，点击「试听当前音色」即可试听草稿，不会立即改掉已保存的朗读音色；点击保存后用于回复。新增「大肥鱼 · 原创调音」分组：星铃（元气少女）、月棉（温柔少女）、糖芽（软萌萝莉）、团子（俏皮萝莉）。四套预设基于 Edge 女声设计音高和节奏组合。换音色、重绘配置或离开页面会停止试听并释放音频。

大肥鱼的偏好、聊天记忆与日志默认在 `%USERPROFILE%\.codex-bigfish`，Electron 窗口配置在 `%APPDATA%\codex-bigfish`。不会覆盖 Codex、原 DSH 或原版桌宠的数据。`DSH_HOME` 可以覆盖大肥鱼的数据目录；应使用独立目录。

## 原版体验与适配范围

- 原资源不重绘、不替换为精灵图；动画状态机和互动处理沿用上游实现。
- 聊天通过官方 [Codex app-server](https://learn.chatgpt.com/docs/app-server) 的本机 stdio 接口。角色提示词和原聊天面板的历史窗口继续生效；每次请求使用独立的临时会话，不续写桌面端已有聊天。连接可复用，空闲五分钟后释放；模型目录最多缓存一分钟，账号更新后失效。当前工具配置每次重读；停止、超时或出错会释放连接，不自动重发聊天。
- Codex 子进程继承明确配置的代理；没有环境代理时读取 Windows 已启用的静态 HTTP(S) 代理，仅作用于子进程。优先寻找桌面版当前的 Codex，模型与思考等级以账号目录为准；显式选择的型号不可用时说明原因。登录、额度、网络等错误使用固定中文提示，不回显服务响应原文。
- Windows 桌面版保留附图和截图入口：图片由 Electron 解码校验，存入独立的附件目录，再交给 Codex 看图。历史只保留引用，不重复发送旧图片。纯 Node CLI 没有 Electron 图片解码器，继续提供文本聊天。
- 本机 Codex 的工作状态通过只读 `%USERPROFILE%\.codex\sessions` 中最近七天、最多 64 个近期日志跟随，约两秒刷新一次；设置 `CODEX_HOME` 时跟随该目录。只转换开始、工具运行、等待、真实完成及中断事件，不把其他聊天正文、命令参数或工具输出交给大肥鱼模型。`DSH_PET_CODEX_OBSERVE=0` 可关闭跟随。
- 只有明确的 `task_complete` 才显示原版完成状态；模型吐出一段文字或单个工具结束不算整轮完成。未知日志格式不推测完成，未来 Codex 格式改变时可能需要更新适配层。
- Codex 余额入口已接入本机账户读取：按照服务端实际窗口长度显示余量和重置时间，额外点数保留 Credits 单位，Token 统计是账户活动。接口未提供的窗口、指标和金额会显示未提供或不可读；不从套餐或 Token 数估算现金余额。
- 新配置默认开启额度动画并每两分钟自动刷新；重复查询共享三十秒缓存，失败五秒后可重试。上版未编辑过的自动默认文件会启用额度查询，已有自定义配置继续保留。若之前自行关闭了某只宠物的余额显示，可在宠物配置中重新开启；设置页的主动查询始终可用。
- 查询仅调用官方 `account/read`、`account/rateLimits/read` 和 `account/usage/read`，不生成聊天，不执行充值、兑换重置次数或发送邮件。账户邮箱、账号 ID 和登录凭据不会加入显示数据或日志；查询快照只在内存中短时保存。
- API Key 或第三方连接不一定提供 Codex 订阅额度；此时显示对应原因，服务商 API 现金余额仍需由该服务商提供。
- Windows 录音识别使用系统已安装的中文语音组件，通过隐藏进程在内存中处理 WAV，不安装 DeepSeek、不需要语音密钥，也不上传录音。识别文字经用户确认发送后，作为正常聊天交给 Codex。朗读可选原版 Edge、原创调音或 Windows 本机音色：Edge 与原创调音需要联网发送待朗读文字，Windows 本机朗读使用已安装的系统组件。缺少组件或在线合成失败时明确报错，不悄悄替换音色。旧的默认 DSH 识别入口会迁移为 Windows，本机自定义设置继续保留。
- 原版的四个 Edge 预设继续保留：晓伊（活泼女声，原版默认）、晓晓（通用女声）、云希（年轻男声）、云健（沉稳男声）。它们通过在线文字转语音生成朗读；原仓库自带的音频仅有点击音效，没有成套的角色台词录音。原版另有需要 DeepSeek 接口的「海星／暗潮」，本分支的 Codex 模式不注册该接口。
- 陪伴聊天使用只读临时会话，关闭文件、浏览器、Apps、MCP 与插件等工具能力；仍拒绝任何额外工具授权。聊天完成不会写成工程任务完成状态，避免工作气泡盖住回复；真实工程任务的状态跟随继续保留。

## 从源码构建

需要 Node.js ≥ 22.12、Git，以及现有 Codex 登录。仓库的 npm 包目录是 `dsh-pet/`。

```powershell
cd dsh-pet
npm install --legacy-peer-deps --ignore-scripts
npm run typecheck:codex
npm run lint
npm test
npm run build
```

`--legacy-peer-deps` 用于不安装上游的 DSH 宿主 peer 包；独立模式沿用原仓库的三个本地兼容模块。类型检查和测试也使用同一套替身。不要为此安装 DeepSeek。

需要 Windows 桌面打包时，先运行 `npm run ensure:electron` 下载上游固定版本的 Electron，再运行 `npm run dist`。Electron 是桌面运行时，不是 DeepSeek。可设置 `DSH_PET_ELECTRON_DIST` 指向已有解压目录；输出在 `dsh-pet/dist-app/win-unpacked/`。源代码调试可用 `npm run start:app`，无窗口体检可用 `node lib/standalone.js --check`。

本次验证记录见 [CODEX-VALIDATION.md](CODEX-VALIDATION.md)。后台测试使用独立数据目录与静音无头浏览器；不会为了验证抢占当前桌面。未验证的原生窗口行为会在记录中明确列出。

## 来源与许可

原作者：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。代码沿用 [MIT License](LICENSE)，保留原作者声明。

Codex 连接复用、代理继承、可用模型选择、错误处理与普通原生管理窗口的方案参考 [bianbian-666/Codex-dafeiyu](https://github.com/bianbian-666/Codex-dafeiyu)。实现适配到本分支原有的类型、生命周期和注册表；其版权与 MIT 许可保留在 [CODEX-THIRD-PARTY-NOTICES.txt](CODEX-THIRD-PARTY-NOTICES.txt)。Windows 本机语音与设置页话筒入口由本分支新增。

按上游说明，宠物原型「溟月」来自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 女仆鲸鱼娘设计来自 [@ZipZipPipe](https://space.bilibili.com/4168597)。形象遵循 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，素材禁止商用，二创公开分发应署名并按原许可共享。保留原始[授权声明链接](https://www.bilibili.com/opus/1247156596114456581)和上游 README 中的完整说明。
