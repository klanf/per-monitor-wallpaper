# 更新日志

> 这份文档是开发过程的完整记录：每一轮改了什么、踩了哪些坑、怎么验证的。
> 想快速上手看 [README.md](README.md)。

从 `wallpaper_change.py`（Tkinter + Pillow，3886 行单文件）移植而来。
核心目标不是复刻全部功能，而是**把原来被技术栈卡住的四件事打通**：
GPU 合成动画、原生图片缩放、不靠 ctypes 硬啃系统 API，以及**每台显示器各自独立轮播**。

在第一轮「每屏独立」之后，第二轮补齐了把它当日常工具用的四块拼图：
**缩略图胶片条**、**托盘 + 开机自启**、**EXIF 完整信息面板**、**图片右键菜单**。
详见「[本轮新增的四个功能](#本轮新增的四个功能)」。

## 快速开始

```bash
cd electron-wallpaper
npm start
```

出厂配置（已按你的两块屏设好，可在设置面板里随时改）：

| 屏幕 | 来源 | 间隔 |
|---|---|---|
| 3840×2160 主屏（横） | `D:\壁纸\横屏`（30348 张） | 60 秒 |
| 1600×2560 副屏（竖） | `D:\壁纸\竖屏`（954 张） | 180 秒 |

快捷键：

| 按键 | 动作 |
|---|---|
| `←` / `→` | 上一张 / 下一张（作用于当前预览的那块屏） |
| `空格` | 暂停 / 继续 |
| `F` 或 `F11` | 全屏切换 |
| `Esc` | 关闭设置面板 / 图片信息面板 |
| `Ctrl+O` | 为当前预览的屏幕选择文件夹 |
| `Ctrl+R` | 重新扫描 |
| `Ctrl+,` | 设置面板 |
| `Ctrl+S` | 立即写入当前预览的屏幕 |
| `Ctrl+B` | 显示 / 隐藏胶片条 |
| `Ctrl+I` | 当前图片的完整信息 |

```bash
npm run start:debug        # 带远程调试端口（9222）与日志启动
npm run status             # 一眼看清「每块屏现在挂着什么」+ 应用侧频道状态
npm run verify:unit        # 调度器逻辑单测（111 项，不碰桌面）
npm run verify:resume      # 播放位置存档单测（28 项，模拟「关机再开机」，不碰桌面）
npm run verify:e2e         # 每屏独立端到端验证（40 项，需要 start:debug 先跑起来）
npm run verify:features    # 四个新功能端到端验证（106 项，需要 start:debug 先跑起来）
npm run verify:fixes       # 第五轮四个反馈的修复（29 项，需要 start:debug 先跑起来）
npm run verify:ui          # 第六轮交互修复（36 项，含原生确认框的完整驱动）
npm run verify:order       # 随机顺序端到端（25 项，需要 start:debug）
npm run sim:random         # 两种随机策略的长跑对比（纯计算，不碰系统）
npm run find-dups "D:\壁纸\横屏" --recursive --md 清单.md   # 找内容完全相同的重复图
npm run fixtures           # 重新生成纯色测试图
npm run shot:new           # 抓新功能界面截图（自动避开真实壁纸库）
npm run restore-wallpaper  # 还原壁纸（不带参数＝按存档逐屏还原）
npm run dist               # 打包（需先 npm i -D electron-builder）
```

## 第六十八轮：DA3 弃用 —— 深度模型还原 V2（方案一）（2026-10-14）

### 现象

用户真机 A/B 对照（git 切 master vs feature/newbiz 重启实测）：V2 老效果全面好于 DA3——①形变轻（DA3 发丝穿透梳齿）；②立体感强（V2 动起来很立体，DA3 像「2D 图在原地旋转」）。用户质疑「接入 V3 后改了不少代码，形变可能是后处理引入的」。

### 归因（2×2 隔离对拍，tmp-ab24-gen.js + tmp-ab24-sim.py）

同图（Anima-20260823163326_00011_.png）四格深度：A=V2裸（master 做法）/ B=V2+repair / C=DA3裸 / D=DA3+repair（现状），右上发丝区+躯干区双区域、纯 POM 同视差量化：

- **「2D 纸片」是 DA3 模型特性**：裸深度（C 格）人物区深度σ就比 V2 低 18%（右上 0.186 vs 0.227）~15%（躯干 0.081 vs 0.095）——DA3 把人物当整体几何面压平内部起伏、只拉开前后景，与后处理无关。深度图对比一目了然：V2 猫耳发丝/锁骨结构清晰，DA3 人物内部糊成一片。
- **repair（r10）在 V2 上无害微益**：B≈A（σ 微升 0.227→0.229，场剪切 P99.9 4.95→2.29），保留给 V2 细发丝留保险。
- **repair 在 DA3 上帮倒忙**：躯干区σ 0.081→0.073，把本已扁平的人物区再抹平 10%。
- **指标修正**：场剪切 P99.9 把「立体锐边」也算剪切——V2 裸 4.95 最高但渲染边缘锐利干净发丝根根分明，r67 用它判 repair -81% 有水分；该指标单看会误判，需配渲染图对拍。

### 决定

DA3 弃用（方案一），候选链还原 master 只认 V2；repair 保留（V2 实测无害微益）；idle/相簿等新业务全不动。不行再退回彻底还原（方案二，repair 也撤）。

### 改动

- depthService.js：resolveRuntime 候选链删 DA3 分支与 depthModel 偏好逻辑（V2：override → 打包布局 → legacy）；configure 删 depthModel 键与白名单
- main.js：删 depthModel 实时转发块与初始 configure 传参
- renderer/app.js + index.html：删设置页「深度模型」下拉及 change 监听
- package.json：extraResources filter da3_small.onnx → depth_anything_v2_small.onnx（100MB DA3 不再进安装包）

### 验证

- node --check ×3；grep 无 depthModel/cfg-depth-model 残留（depthModelDir 为另一键保留）
- check-wiring 56/0；单测 depth-service 20/0 + desktop-host 41/0 + fullscreen-watch 43/0 + live-desktop 42/0 + scheduler 185/0 + slideshow-guard 14/0
- 真机待验收：重启后深度按 V2 候选链重生成（缓存键含模型路径自动隔离，DA3 旧缓存不串）


## 第六十九轮：r67 深度修复撤销 —— 深度管线彻底还原 master（方案二）（2026-10-14）

### 现象

第六十八轮（深度模型还原 V2 + repair 保留）真机验收仍不行，用户拍板「还原 master」。

### 决定

撤掉 r67 mask 引导的深度修复（repairDepthWithMask）：2×2 隔离对拍实锤 repair 在 V2 上虽无害微益，但「还原 master 的做法」要求深度本体落盘前零改动——现在与 master 完全一致（推理→归一化→引导滤波→落盘），seg 只服务于 idle 前景层 mask。深度缓存 schema r10→r11 全量失效重生成。

### 改动

- depthEngineJs.js：删 repairDepthWithMask 函数与 generate 内调用、__test 导出项；seg 注释改「只服务于 idle mask」
- depthService.js：DEPTH_CACHE_SCHEMA 'depth-png-r10' → 'depth-png-r11'

### 验证

- node --check ×2；grep repairDepthWithMask 零残留；check-wiring 56/0；test-depth-service 20/0
- 负向控制（负向对照实证撤干净）：重跑 tmp-ab24-gen.js 四格，带 mask 管线深度与裸深度 md5 逐字节一致（A=B=cb51e86c、C=D=c4011b50）——深度本体零后处理


## 第七十轮：顶栏新增「鼠标影响动效」开关（pointerFx）（2026-10-14）

### 需求

用户：顶栏加一个开关控制「鼠标能否影响动效风格的运作」——开=受鼠标影响（现状），关=不管鼠标怎么动都按预设轨迹运行。

### 实现（与 idleFx 完全同构，跟显示器走）

- 新 profile 键 `pointerFx`（不写 = 默认开，保持现状行为）：store.js PROFILE_KEYS 透传
- stage.js：cfg 默认 true；闸门放在两个鼠标喂入口（本地 mousemove + 主进程 GetCursorPos 轮询）——只挡 glState.mouse/mouseUntil 喂送，粒子避让光标喂送不受此闸门管（独立开关 particleCursor）；关闭时立即清 mouseUntil=0，混合权重 mouseW 按 0.02/帧平滑衰减（~2s 无跳变回到预设轨迹）
- 顶栏第 5 枚 qchip `qt-pointer`（光标图标）：开关走 quickToggles 组监听新增分支，pushProfile 写 profile 实时生效
- app.js：resolvedPointerFx（不写 = 默认开，与 stage 默认一致）+ updateQuickToggles 点亮态

### 验证

- node --check ×3；check-wiring 56/0；单测 depth-service 20 + desktop-host 41 + fullscreen-watch 43 + live-desktop 42 + scheduler 185 + slideshow-guard 14 全 0 失败
- 真机待验收：关闭后鼠标狂动镜头应恒走预设轨迹（含 idle 目标喂送同源失效）；重开立即恢复跟随


## 第七十一轮：分时段分层氛围 —— 时段光照 + 环境雾 + 主体金边（depthAtmo）（2026-10-14）

### 需求

用户提出两个构想（分时段分层光照 A + 环境雾与空气透视 B），并拍板开工（理由：旧时段滤镜 tod 全图色彩矩阵「效果没法看，会把整个图片的颜色都改了」）。原构想宣称需 V3 深度支撑 —— 不成立：正确实现按**连续深度值**平滑混合，无离散分层即无「串层」；V2 人物区深度起伏比 DA3 高 15~18%（r68 对拍），前后关系更清楚，且 mask（uMask）现成可打金边。

### 实现（shader 单点挂 POM 路径，配置与 idleFx 同构）

- stage.js DEPTH_FS：`atmoParams`（四档参数表：色温/亮度/雾色/雾浓度/远景压暗/金边强度）+ `atmoApply`（按屏幕基准点深度连续混合：`band=smoothstep(0.10,0.85,dN)` 深度带亮度、`fogW=fogDen*smoothstep(0.25,0.95,far)` 空气透视远浓近淡、金边=mask 边缘梯度×mask 强度×雾色（黄昏档 rimK=1））。四档：清晨冷调薄雾/白天中性高亮/黄昏暖橙金边/夜晚蓝紫压背景（farDark 0.68）
- uAtmoPhase（0=清晨 1=白天 2=黄昏 3=夜晚，小数=相邻档过渡）：JS 关键帧线性插值（[0,3][4.5,3][6.5,0][9,1][16.5,1][18,2][20,3][24,3]，夜晚跨午夜），60s 失效缓存
- flowSample 末尾接 atmoApply（stB 基准锚点，效果不随视差游走）；仅 POM+有深度图路径生效（2D 平移缩放层不挂）
- profile 键 `depthAtmo`（跟显示器走，不写=默认关）；顶栏第 6 枚 qchip `qt-atmo`（太阳图标）；app.js resolvedAtmo+点亮态+组监听分支

### 验证

- node --check ×3；check-wiring 56/0；单测 depth-service 20 + desktop-host 41 + fullscreen-watch 43 + live-desktop 42 + scheduler 185 + slideshow-guard 14 全 0 失败
- GLSL ES 1.0 合规自查：无动态数组索引（分支+out 参数实现四档选择）、texMirror 采样域与 idleWarp 一致
- 真机待验收：顶栏点亮太阳图标看四档观感（当前时段即插值值）；若视差整体消失=shader 编译失败（catch 降级 2D，slog 有日志）
- 旧 todRandom 时段滤镜未动（用户自行关闭）；后续若定版可考虑退役


## 第七十一轮修复：depthAtmo shader 编译炸裂导致深度视差整体降级 2D（2026-10-14）

### 现象

r71 提交后用户真机反馈「深度视差图功能挂掉了」。GLSL 编译失败走 stage.js 的 catch 静默降级 2D（警告只进 devtools console，live-debug.log 无记录）——与日志空白吻合。

### 根因（Edge headless + SwiftShader 真实编译器实证）

DEPTH_FS 无 #version 指令 = GLSL ES 1.00，**没有 int 版 min/max/clamp 内建**（ES 3.0 才加入）。r71 新增 `int i1 = min(i0 + 1, 3);` 编译失败：`ERROR: 0:97: 'min' : no matching overloaded function found`。

### 修复

- stage.js：`min(i0+1,3)` 改为 `int i1 = i0 + 1; if (i1 > 3) i1 = 3;`

### 验证（新工具 tmp-glsl-gen-page.js：抽 DEPTH_FS 生成编译测试页，Edge headless --virtual-time-budget 等 JS 跑完再 dump-dom）

- 修复版：GLSL-COMPILE-OK ×3（稳定复现）
- 负向控制（--neg 还原旧写法）：必失败 `ERROR: 0:97: 'min' : no matching overloaded function found`——正负对照闭环
- node --check；check-wiring 56/0；单测 depth-service 20 + desktop-host 41 + fullscreen-watch 43 + live-desktop 42 + scheduler 185 + slideshow-guard 14 全 0 失败
- 陷阱记录：dump-dom 早于脚本执行时 div=PENDING/匹配到源码字面量，必须 virtual-time-budget 等待；bash 内联 node -e 的 ! 触发 history 展开破坏字符串

### 教训

shader 改动必须有真实编译器验证环节（本机 Electron 无沙箱也起不来 GPU 进程，Edge headless 是现成替代）；int 值截断一律 if，不碰 min/max。

\n## 第七十二轮：氛围调色重构 —— luma 分层调色 + split-toning + 指数雾（2026-10-14）

### 现象

用户真机反馈 r71「只会增加亮度，把暗处细节弄没了」。根因：全图乘法调色（col *= tint*lum）是亮度同比缩放——夜档 tint 红通道 0.80×lum 0.78 把暗部乘没，白天 lum 1.05 把高光推出剪裁；「亮度变化」≠「调色」。

### 社区调研结论

DepthFlow 官方无时段光照/雾（仅 vignette/DOF/镜头畸变，且均未内置时段语义）；游戏工业标准做法 = Crytek GDC08 Photo Filter（按 luma 决定染色强度）+ ASC CDL Lift/Gamma/Gain；雾用 IQ 指数平方公式替代线性 smoothstep（后者有「中间突然一截」断层风险）。

### 实现（atmoApply 重构，仅 shader 内部，配置/UI 不变）

- atmoParams 改 struct AtmoP 出参：tintS/tintH（阴影/高光分开染色）、gamma（luma 曲线指数）、fogCol/fogDen、farDark、rimK
- 四档新参数：白天近无操作（gamma 1.0 中性，不再整体提亮）；黄昏 split-toning（阴影暖暗/高光染金）；夜晚 tintS 偏蓝+gamma 1.22 压中间调
- 调色链：① luma gamma（比例因子回填 RGB，色相/饱和不动）→ ② 深度带远景压暗 → ③ split-toning 染色 → ④ luma key（深阴影 luma<0.05 混合权重 0.22，中间调 1.0——保暗部细节）
- 雾换 IQ 指数平方：fogW = fogDen*(1-exp(-2.2*far²))；雾色亮度取当前像素 luma（不再用档位常量）
- 金边逻辑不变

### 验证

- tmp-glsl-gen-page.js + Edge headless 真实编译：GLSL-COMPILE-OK（struct 出参 GLSL ES 1.0 合规）
- 夜档暗部保留率数值对照（灰像素）：luma 0.02 深阴影 0.66→0.86（+30%）、0.80 高光 0.66→0.88（不再压死）、0.30 中间调 0.67（夜景压暗力度保持）
- check-wiring 56/0；六套单测 345 项全 0 失败；真机待验收（重点看夜档暗部与白天是否还整体提亮）

\n## 第七十三轮：氛围改调色板体系 + 雾浓度滑杆 + 景深虚化 + 丁达尔光束（2026-10-14）

### 需求（用户五条）

① 清晨/白天观感不明显→合并、夜晚档删（auto 只剩白天/黄昏）；② 雾看不出用、没开关→加浓度滑杆 0~2×（0=关）；③ 时段滤镜改成社区调色板预设，工具栏只留总开关、具体效果设置页选（含 auto）；④ 景深加开关体验对比；⑤ 丁达尔也做。

### 社区调研（选型依据）

DepthFlow 官方仅 vignette/DOF/镜头畸变且无时段语义；调色板选社区公认六大盘中五个（luttie.app/Motion Array/Bitcut 评价页）：黄金时刻 Golden Hour、好莱坞青橙 Teal & Orange（影史最稳：肤色暖橙+环境推青，色轮对位）、赛博朋克 Cyberpunk（品红青霓虹）、月光蓝 Moody Blue（暗而不闷）、褪色胶片 Faded Film（抬黑低饱和）。丁达尔=Mitchell 2004/Crysis Sun Shafts 屏幕空间径向采样（GDC 经典，游戏业十余年标准）。

### 实现

- shader：atmoParams 4 档→7 档（0=白天 1=黄昏 auto 用；2~6=固定调色板），AtmoP 增 lift（抬黑）/sat（饱和）成员；godRays 函数（向 SUN_POS 右上 20 步径向采样，亮度阈值 smoothstep(0.70,0.92) 提亮源，每步 mask 遮挡×(1-mask*0.85)→光柱不打人，衰减 w*=0.93 归一 *0.035）；DOF（焦点=屏幕中心深度，CoC=|该点深度-焦点|*uDof，黄金角螺旋 16 tap，CoC<0.015 保原图，rad 上限 9px/uCanvas.y）；uniforms uAtmoPhase→uAtmoSel（连续档位）+uFogK/uDof/uGodR
- JS：ATMO_AUTO_FRAMES 改白天/黄昏两档（[[0,0],[6,0],[16.5,0],[18,1],[20.5,1],[21.5,0],[24,0]]，清晨并入白天、夜晚档删）；atmoSel 每帧 0.08 缓动（调色板切换不跳变）；调色板链路 save() 全局键→stage profile 合并（同 flowIntensity）
- 设置页（深度视差区）：氛围调色板下拉（auto+5）、雾浓度滑杆 0~2×、景深虚化 checkbox、丁达尔光束 checkbox；顶栏太阳图标仍是总开关（跟显示器），设置页管「开起来之后长什么样」
- store 不加键（全局 config 透传，同 flowIntensity 先例）

### 验证

- node --check ×2；Edge headless 真实编译 GLSL-COMPILE-OK（const vec2/struct 出参/三新 uniform 全合规）；grep atmoPhaseNow|uAtmoPhase 零残留
- check-wiring 56/0；六套单测 345 项全 0 失败
- 真机待验收：①调色板五档逐个切看观感（顶栏氛围先点亮）②雾拉 2× 看远景空气透视、0 看无雾 ③景深开关对比人物清晰/背景糊 ④丁达尔对天空/窗光类壁纸看光柱，人物图若无亮源属预期（光柱需要画面里有亮的天空/窗口）

\n## 第七十三轮修复：r73 四个新设置键被 resolveProfile 白名单过滤 —— 开关全无效果（2026-10-14）

### 现象

用户真机反馈 r73「开启和关闭都看不出来」。设置页写全局 config 正常，但 stage 永远收不到。

### 根因

store.js resolveProfile 的 base 只从 PROFILE_KEYS 逐键拷贝（`for (const key of PROFILE_KEYS) base[key] = config[key]`）——r73 四个新键（atmoPalette/atmoFog/depthDof/godRays）未加进白名单，被整体过滤。r73 决策「不加 store 键、同 flowIntensity 先例」是误记：flowIntensity 恰恰在 PROFILE_KEYS 里（第 261 行）。

### 修复

store.js PROFILE_KEYS 补 4 键（atmoPalette/atmoFog/depthDof/godRays）。

### 验证

- node --check ×2；check-wiring 56/0；六套单测 345 项全 0 失败
- 真机待验收：设置页改调色板/雾/景深/丁达尔应立即生效（save→config→推送→applyProfile）
- 附注：auto 档白天时段近无操作是 r72 设计（用户嫌「只增亮度压暗部」），白天空看氛围请选固定调色板或等黄昏窗


## 第七十三轮精简：撤掉雾浓度滑杆 / 景深虚化 / 丁达尔光束 —— 只留调色板体系（2026-10-14）

### 需求

用户验收后拍板：「2,3,4还是拿掉吧」——撤雾浓度滑杆、景深虚化、丁达尔光束三个特性，氛围只留调色板选择（顶栏太阳总开关 + 设置页调色板下拉不变）。

### 撤除清单（三端全清）

- stage.js：shader 删 uFogK/uDof/uGodR 声明+注册+上传、godRays 函数（含 SUN_POS）、flowSample 内 DOF 螺旋采样块与 godRays 调用；雾还原固定档位密度（fogW = fogDen*(1-exp(-2.2far²))）；cfg 默认值与 applyProfile 解析删 atmoFog/depthDof/godRays 三键
- app.js：回填与 change 监听删三控件
- index.html：设置页删雾浓度滑杆行 + 景深/丁达尔两 checkbox 行
- store.js：PROFILE_KEYS 删三键（atmoPalette 保留）

### 验证

- node --check ×3；grep 全仓零残留（RESIDUE-GREP-EXIT=1）
- Edge headless 真实编译：GLSL-COMPILE-OK
- check-wiring 56/0；六套单测 345 项全 0 失败
- 真机待验收：氛围 = 顶栏太阳开关 + 设置页调色板（auto 按时间白天/黄昏 / 黄金时刻 / 青橙 / 赛博朋克 / 月光蓝 / 褪色胶片）


## 第七十三轮收尾：时段滤镜（r21）整体退役 —— 与氛围调色板合并（2026-10-14）

### 需求

用户指出设置里「时段滤镜」与「氛围调色板」重复。确认属实：两者都是按时段给画面上色——旧 tod 是全图罩层（DOM #tod 渐变 + .layer CSS filter，用户此前评「效果没法看，把整个图片的颜色都改了」），新 depthAtmo 是深度感知 shader 调色，同时开互相污染。

### 退役清单（四端全清）

- stage.js：删 TOD_FILTERS、cfg 默认三键（timeOfDay/todRandom/todPool）、applyTod、pickTod、applyProfile 解析、换图同拍重抽、#tod 元素查询；.profile 解析处留退役注释
- app.js：删 TOD_KINDS、三行回填、两个监听（随机开关/随机池）、TOD_LABEL + timeOfDay 监听；renderPoolChips 保留（粒子池共用）
- index.html：画面动效组删时段滤镜下拉/随机开关/池 chips，data-tip 改为指引「按时段上色用深度视差 › 氛围调色板」
- stage.html：删 #tod 罩层元素；stage.css：删 #tod 全部样式块与分区注释（47 行）
- store.js：PROFILE_KEYS 删三键、BOOL_KEYS 删 todRandom、删 todPool 清洗与 TOD_KIND_WHITELIST

### 兼容性

旧配置里 timeOfDay/todRandom/todPool 残留值：移出白名单后 resolveProfile 不透传、sanitize 不再清洗——无人读取，无害。

### 验证

- node --check ×3；全仓 grep 零残留（仅存三条退役注释）；check-wiring 56/0；六套单测 345 项全 0 失败
- 真机待验收：设置 › 画面动效只剩呼吸缩放；按时段/风格上色统一在深度视差 › 氛围调色板（顶栏太阳总开关）


## 第七十四轮：粒子深度遮挡（r74）—— 樱花落进人物身后、雨丝被屋檐挡住（2026-10-14）

### 需求

用户带来外部提案两则：粒子深度遮挡（S 级）与粒子深度衰减（A 级）。评估修正两点后落地：① 提案说「V3 支撑 / V2 深度漂移会违和」不成立——r69 已定版 V2_small，遮挡只需要相对深度序，V2 足够；② 提案说「shader 里对比、零改动」不符合架构——粒子是独立 2D canvas（particles.js），不在深度 shader 里，实现走 CPU 查表。小步验收：本轮只做遮挡（雨/雪/樱花首批），纵深衰减（用同一个 z）留 r75。

### 实现（数据流：depBmp → CPU 像素表 → 粒子逐粒判定 → draw 乘系数）

- stage.js：`depthPixelsFor()` 把深度位图缩采样成长边 256 的 CPU 像素表（必须在 `depBmp.close()` 前抓，glLoadLayer 建完纹理就关位图）；layer 携带 `depthPx` + 原图 `iw/ih`；showFrame 入口默认 `feedParticleDepth(null)`（2D/拼接/网页/视频各路都不吃上一张的深度），GL 深度帧上屏且 fit=cover 才喂；fit 换挡与 particleDepth 值真变时也作废（后者只在值变时清——applyChannelConfig 每次广播带全量键，无脑清会把正在播的遮挡掐到下次换图）
- particles.js：`applyDepthOcclusion()` 纯函数——粒子 z∈[0,1] 懒分配（近=1，与深度图同域），屏幕坐标反推 cover 映射采样深度 d（R 通道近=1 远=0，与 shader 同向），z<d 即「在物体后面」，软过渡带宽 0.10 线性淡出（防物体边缘硬消失闪烁）；深度图外出界恒可见（防御）；批量 drawAll（雨/雪）拆「全可见桶 / 被遮挡散画」两条路，常态边缘少数散画，批量路径不劣化
- 排除项：stars（远景装饰）/raindrops（贴屏幕的水珠）不参与；无深度图自动失效（整层照旧）
- 五端接线：store.js PROFILE_KEYS 补 `particleDepth`（r73 白名单教训）；stage.js cfg 默认开 + applyChannelConfig 守卫；index.html 粒子区加「粒子深度遮挡」checkbox；app.js 回填 + change 监听（照 particleCursor 模式）

### 验证

- node --check ×5（particles/stage/app/store/test-particles）；check-wiring 56/0；verify:unit 全链 0 失败
- 新建 tools/test-particles.js（17 项，挂进 verify:unit）：遮挡判定 13 项（z 懒分配 / 天空恒可见 / 满屏前景挡 / 软过渡线性 / cover 超宽映射三点采样 / 出界防御 / 坏输入不炸）+ 回归 4 项（老别名迁移 / 脏值回落 / spawn 白名单）。期间抓到一处**测试自身坐标错**（x=95 → u=0.725 落在自涂的前景列），非实现错，已修
- 真机待验收：开雨/雪/樱花 + 有深度图的壁纸，粒子应被前景物体挡住；设置 › 外观 › 粒子特效可关


## 第七十六轮：切换动画在深度视差帧上生效 —— GL 过渡不再写死交叉淡化（r76）（2026-10-14）

### 现象（用户真机反馈）

「切换动画没有在舞台生效」。排查实锤：GL 路径（深度视差帧）的过渡**从 r38 起就写死交叉淡化**，从不读 `cfg.animation`——`variantFor`/`RANDOM_POOL` 只有 2D 路径在用。master 同样如此（不是 r74/r75 回归）：以前深度生成不稳、常掉 2D 路径时动画能看到；现在深度管线稳了，几乎每张图都走 GL，设置里的切换动画（两块屏都是 random + 1500ms）等于整体失效。

### 方案：变换型在 GL 等价复刻，自绘型降级 fade

| 变体族 | GL 实现 |
|---|---|
| fade / zoom / zoom-in / zoom-out / slide / slide-zoom | 新 uniform `uXf`（cover：采样坐标平移+绕中心缩放+层外 alpha 0）；contain/mirror 走 uCore 核心矩形变换（shader 不读 uCore 的 cover 必须单独走 uXf，这是实现中发现的关键）——参数与 2D variantFor 逐项对齐，slide 两层同一缓动 → 可见区严丝合缝互补 |
| wipe / iris / blur-dissolve / clock / blinds / split | clip 系片元表达不了 → 降级 fade（slog 只提示一次），视差连续性优先 |

调度规则：`glShowFrame`/`glShowFrameCollage` 挂 `glv`（animate=false → duration 0 瞬上，与 2D 语义对齐；**depth:ready 升级 variant=false → 保持淡化**——同一张图加视差，平移缩放会穿帮）；`glTick` 按 glv 插值，glv=null 恒等于现行交叉淡化。2D 与 GL 共用新的 `pickAnimName()` 抽签。

### 验证（含一次负向哑弹修复）

- **tmp-glsl-gen-page.js 的 --neg 负向控制实为哑弹**：r71 的注入目标串被 r73 重构删掉后 `replace` 静默 no-op，「负向通过」验了个寂寞。改为 main() 注入未声明变量（任何后端必炸）——现在正向 `GLSL-COMPILE-OK`、负向 `RESULT-FAIL: undeclared identifier`，对照闭环
- Edge headless 真实编译通过（uXf 全 GLSL ES 1.0 合规）；check-wiring 56/0；verify:unit 全链 0 失败（调度 199/0）；node --check
- 真机待验收：动画选 random → GL 帧上应能看到 zoom/slide 系花样（clip 系显示为淡化属预期）；单选 slide/zoom 逐个对比 2D 观感

## 第七十五轮：拼接整页推进 —— 相邻两幅拼图零重复（r75）（2026-10-14）

### 现象（用户真机反馈）

「填充拼接的模式好像还是一张一张的切，会有重复」——拼接是「中心图 ± 邻居」构图，而调度器每 tick 只推进 1 张：上一幅的**右格就是下一幅的中格**，每张图必然连播两次（n=3 时 2/3 格是旧的）。

### 方案：页宽回报 → 整页步进

调度器不知道自己在服务拼接（拼格数 n 还按中心图比例浮动 1~4），让渲染端告诉它：

| 端 | 改动 |
|---|---|
| stage.js | `reportCollagePage(n)`：拼接帧建成回报页宽（同 n 去重）；fit 换挡 / 深度开关关闭 / 退化单图回报 1 还原步长 |
| preload.js / main.js | 新 IPC `channel:collage-page` → `scheduler.setCollagePage(id, n)` |
| scheduler.js | `ch.collageStep`（内存态不落盘）：timer 与手动「下一张/上一张」按 ±页宽推进；**跳过的中间张也标 played**（页面里每张都出现过）；跨轮重洗判定从「落点=开头」改成「本次跨过末尾」（页步长踩不准 n-1）；步长 clamp 到 n-1 防短列表原地绕圈；video-ended 保持 1（视频不进拼格） |

**手动「下一张」也整页跳**：拼接模式下点下一张看到的是全新一幅而不是右移一格（右移=又看到 n-1 张旧图）。

### 验证

- test-scheduler.js 新增「拼接整页步进」块 10 项：页宽记录/clamp、手动±整页、中间张标 played、timer 同款、video-ended 例外、跨末尾触发重洗——**195/0**
- check-wiring 56/0；verify:unit 全链 0 失败；node --check ×5
- 真机待验收：填充方式=拼接 + 深度视差开，每次换图整幅换血；手动下一张同理

## 第七十五轮追记：拼接左邻次序颠倒 —— 中心 3 显示成 1 3 4（2026-10-14）

### 现象（用户真机反馈）

「当前查看的是 3，桌面显示 1 3 4，而不是 2 3 4」——左格拿到的是**左二**那张。

### 根因（r38 就埋着的老 bug）

main.js 的 `walk(-1)` 本来就返回「距中心由近到远」（s=1 是最近邻），但返回前被 `.reverse()` 翻成了**由远到近**；而 stage.js 拼格是**从内到外**取（`paths[centerIdx-k] = left[k-1]`，k=1 是最内格）→ 最内格拿到的是最远那张。注释「距中心由近到远 → 拼格从内到外」与实现刚好相反，自审时被注释骗过去了。

### 修复

- 邻居逻辑从 main.js 搬进 `scheduler.collageNeighbors(id, index, span)`（可单测），main.js 只剩转发
- 去掉 `.reverse()`，left/right 统一「由近到远」，注释改正
- 单测补 4 项：中心正确、左邻由近到远（p-4 在 p-3 前）、右邻同、跨列表头尾回绕——**199/0**

## 第七十四轮追记：粒子遮挡首帧 rand 未定义炸掉 rAF 循环 —— 视差被粒子拖死（2026-10-14）

### 现象（用户真机反馈）

「粒子特效有可能卡死深度视差的效果」——雨/雪/樱花 + 深度壁纸时视差冻结，无深度图或别的粒子种类则正常。

### 根因（实锤）

两层叠加：

1. **直接根因**：stage.js 的 `createParticles(canvas)` 是单参调用，particles.js 闭包里 `rand=undefined`。既有的 `step()`/`spawn()` 都做了 `rand || Math.random` 兜底，r74 新加的 `applyDepthOcclusion` 漏了——深度帧喂入后首帧判定，第一颗无 z 粒子走到 `p.z = rand()` → TypeError。
2. **杀伤半径（架构弱点）**：`ensureRaf` 的循环体没有任何 try/catch，任一 tick 抛异常 → 结尾的 `requestAnimationFrame(loop)` 不执行 → **整个循环死透**，视差/过渡/粒子全冻结且无人重启（下一次换图 showFrame 才 ensureRaf，原异常再炸再死，确定性循环）。

单测没抓到它：test-particles.js 是纯函数测试，每处都显式传了 mulberry32 种子 rng，恰恰漏了浏览器绑定的 undefined 路径。

### 修复

- particles.js：`applyDepthOcclusion` 补 `const rr = rand || Math.random`（与 step/spawn 同款兜底）
- stage.js：ensureRaf 循环体加固——五个 tick（anim/ken/gl/pan/video/粒子）各自包 `safeTick` 独立隔离，一个挂了别的照跑、循环必续，异常落 slog 限频（前 5 次）。装饰性 tick 从此不可能拖死视差本体

### 验证

- test-particles.js 补 2 项负向用例（rand=undefined 不炸 + z 仍懒分配）→ 19/19；check-wiring 56/0；node --check ×3
- 真机待验收：雨/雪/樱花 + 深度壁纸，视差应正常流动且粒子被前景遮挡


## 第四轮：四个新功能

### 1. 缩略图胶片条

底栏一条横向缩略图：**当前 / 已经看过的 / 还没轮到的**用三种状态区分，点一下就跳过去。
原本打算做的「播放历史」被它取代了 —— 能直接点回上一张，比翻历史列表更直接。

![胶片条](docs/界面-胶片条.png)

两个关键设计：

- **缩略图走自定义协议 `wpthumb://`，不在渲染层做缩放。**
  渲染层只拿到 URL，真正生成缩略图的是主进程的 `nativeImage.createThumbnailFromPath`
  （Windows 底层是 IShellItemImageFactory）。实测冷调用 60–180 ms，命中系统缩略图缓存后 6–7 ms；
  生成结果按 `sha1(路径|mtime|size)` 落盘缓存，并发闸门 6，失败回退原图。
  如果让渲染层自己 `img` + CSS 缩放到 40px，两万张的目录第一次滚过去就是灾难。
- **只渲染窗口内的节点。** `syncFilmWindow()` 把 DOM 对齐到 `[start, end)`：
  两端增删、中间复用，切换一张不会重建几百个 `<img>`。
  当前左右的显示数量在设置里可调（默认各 40）。

「看过的」标记存在主进程的 `scheduler.played` 里，跨 rebuild 不丢；
删除/移动文件时序号会跟着列表一起位移，不会把新图片误标成「看过」。

### 2. 托盘图标 + 开机自启

窗口右上角关掉不等于退出：默认隐藏到托盘，桌面继续轮播（第一次会弹一个托盘气泡说明）。
托盘右键菜单里能逐屏控制 —— 下一张 / 上一张 / 暂停 / 设为壁纸 / 重新扫描，以及全部暂停、开机自启开关。

**开机自启有个必须知道的坑**：Windows 上 `app.getLoginItemSettings()` 返回的 `openAtLogin`
**永远是 `false`**，真正表示「启动项存在且指向当前可执行文件」的是 `executableWillLaunchAtLogin`。
只看 `openAtLogin` 的话，开关会一直显示关闭状态。两个字段都读、任一为真即视为开启（见 `src/tray.js`）。

开发模式与打包后的自启命令不同，`loginArgs()` 会分别生成
`electron.exe <项目目录> --hidden` 和 `<exe> --hidden`，否则重启后会弹出一个空窗口。

### 3. EXIF 完整信息面板

![图片信息面板](docs/界面-图片信息.png)

`Ctrl+I` 或顶栏按钮打开，用 exifr 解析后按 **文件 / 图像 / 拍摄参数 / 位置 / 来源 / 其他** 分组：

| 分组 | 内容 |
|---|---|
| 文件 | 名称、目录、体积、修改时间 |
| 图像 | 尺寸、宽高比、位深、通道、色彩类型、是否渐进 / 隔行 / 含 Alpha |
| 拍摄参数 | 相机、镜头、光圈、快门、ISO、曝光补偿、焦距、测光 / 曝光 / 白平衡模式、闪光灯 |
| 位置 | 经纬度、海拔、坐标基准、拍摄方向、定位时间 |
| 来源 | 软件、作者、版权、Artist、日期 |

两个细节：枚举值不显示裸数字（`ColorSpace=1` → `sRGB`，`ResolutionUnit=2` → `inches`）；
宽高比命中常见比例时给名字（`16:9`），否则只给小数 —— 否则会出现 `181:128` 这种毫无意义的化简结果。

### 4. 图片右键菜单

在画面上右键，或在胶片条上右键任意一张：

| 菜单项 | 说明 |
|---|---|
| 把这张设为壁纸 / 图片信息… | 直接写入当前预览的屏 / 打开信息面板 |
| 复制图像到剪贴板 | 复制像素，可直接粘进 Word、画图、PS |
| 复制文件到剪贴板 | 在资源管理器里 Ctrl+V 能粘贴出这个文件 |
| 复制文件路径 | 复制完整路径 |
| 移动到 / 复制到 | 子菜单里是「预设文件夹」（可在设置里维护），常用于把不想要的图一键挪进「垃圾桶」目录 |
| 在资源管理器中显示 / 打开所在文件夹 / 用默认程序打开 / 选择打开方式… | 交给系统 |
| 删除到回收站 | **只提供回收站，不做永久删除** |

用 Electron **原生 Menu** 而不是 HTML 自绘：要能弹出系统的「打开方式」对话框、
要跟随系统主题与高 DPI 缩放，自绘得把这些全重做一遍。

移动 / 删除后**不重建整个轮播**：`scheduler.applyFileMutation()` 就地更新文件列表 ——
同目录改名只换路径，移到别处则从这条轮播里摘掉（"这张我不想要了"），
索引和「看过」的序号一起位移，正在显示的那张被删掉时立刻补写下一张，
否则桌面会挂着一张已经进了回收站的图。

## 第五轮：四个反馈的修复

### 1. 「偶尔重复加载同一张图片」→ 不是路径解析的问题，是图库里有重复文件

现象有三种同时出现：预览区同一张图重新淡入、胶片条上两张缩略图一模一样、
桌面连着两轮挂着同一张。三者同时出现只有一个解释：**同一张图被当成了列表里两个序号**。

先排除了程序侧的可能：

| 检查项 | 结果 |
|---|---|
| 同一路径被列出两次（扫描器重复） | 0 处 |
| 符号链接 / junction 导致重复遍历 | 0 个 |
| 胶片条窗口 `syncFilmWindow` 增删逻辑（300 轮压力复现） | 0 次不变量被破坏 |
| **内容字节完全相同的重复文件** | **70 组 / 140 个文件 / 351 MB** |

也就是说扫描和渲染都没问题，是图库里同一张图存了两份（例如同一张图同时有
日文名 `ミルクセーキ 2023-05-04 …` 和罗马音名 `milkshakework [2023-05-04] …` 两个文件）。
30348 张里抽中孪生兄弟的概率约 0.23%/次，11 秒间隔下一小时约 0.7 次 —— 正好是那个「偶尔」。

两边都做了处理：

- **程序侧加护栏**：随机模式下避开**体积与当前这张相同**的候选
  （内容相同 ⇒ 体积必然相同，所以这一步能挡住所有「连着出现同一张」的情况）。
  扫描器为了速度刻意不 stat 每个文件（30348 个全量 stat 要 20 秒以上），
  所以体积是在每轮只对「当前 + 候选」按需取、带缓存的，代价可忽略。
  配置项 `skipSizeTwin`（默认开）。
- **数据侧给工具**：`npm run find-dups` 按「体积分组 → 只对候选做完整 SHA-256」
  找出内容相同的组，`--md` 直接生成一份「保留哪个、删哪个」的清单。

护栏的有效性用**确定性夹具**验证（3 张图里两张字节相同），不做概率碰运气：

```
开启护栏：30 步 → 相邻同体积 0 次
关闭护栏：30 步 → 相邻同体积 6~11 次      ← 对照，证明护栏真的在起作用
```

### 2. 每屏独立 → 播放顺序：切到「按名称」之后切不回「随机」

根因（真实配置里抓到的）：每个屏卡片里的「播放顺序」seg 控件把 `data-value`
原样写进了配置，于是存下去的是 `"shuffle": "random"` 这个**字符串**，
而 `resolveProfile` 里判的是 `shuffle === true` —— 恒不成立。

```
用户配置里真实存在的这一行：
  "\\?\DISPLAY#AAAA1234#…#{…}": { "shuffle": "random", "interval": 5, … }
  → 解析出来 shuffle=false → 卡片高亮停在「按名称」，怎么点都回不到随机
```

修复分三层，确保别的字段不会再踩同一个坑：

1. 渲染层按字段声明取值方式（`SEG_VALUE.shuffle = v => v === 'random'`），布尔字段不再漏字符串；
2. `store.js` 增加 `normalizeBooleans()`，写盘前统一收一遍（14 个布尔键）；
3. `resolveProfile` 用宽松 `toBool()` 读 —— **已经写坏的配置下次启动就自动恢复**，
   不用手动改 JSON。

### 3. 设置面板里的「当前图片」删除按钮

设置面板新增一节「当前图片」：显示当前这张的文件名 + 三个按钮
（查看信息 / 打开所在文件夹 / 删除到回收站）。

删除走 `file:trash-confirm`：**先弹系统确认框再删**。
右键菜单里的删除是一次明确的手势，不需要确认；但面板里这颗按钮夹在一排普通按钮中间，
误点代价太高（壁纸库是长期积累的），所以两条路径的确认策略刻意不同。
没有图片时三个按钮自动置灰。

### 4. 「打开所在文件夹」要定位到图片本身

原来走的是 `shell.openPath(path.dirname(file))` —— 只把文件夹打开，
子目录一多还得自己进去找。改用 `shell.showItemInFolder`，
等价于 Explorer 的 `/select,` 参数：打开 + 选中 + 滚动到可见位置。

顺带合并了一个冗余：菜单里原先同时有「在资源管理器中显示」（选中）和
「打开所在文件夹」（只打开），其实是同一件事，摆两项只会让人犹豫点哪个。现在只留一项。

### 5. 顺带修掉的：切模式时每屏卡片不刷新

`channels:changed` 广播只带 `channels`，而渲染层的 `state.perMonitor` 只在收到
带 `perMonitor` 的载荷时才更新 —— 于是从设置面板切「统一配置 / 每屏独立」时，
显示器卡片不会立刻出现或消失，得等下一次 `listChannels()` 才补上。
现在广播统一走 `channelBroadcast()`，把配置派生的开关一起带上。

### 6. 改配置之后，旧配置的那张图会晚一步写到桌面上（竞态）

这个是在跑端到端验证时被一条**偶发失败**逼出来的：改了图，OS 侧却读到旧图。

先写了个探针把过程摊开（每轮记录应用侧 `lastWrite` 与两块屏的实际文件）：

```
#0 期望 t-02.png
   应用侧 lastWrite: {"ok":true,"method":"com:per-monitor","monitorId":"…AAAA1234…","reason":"command"}
   OS 主屏: t-02.png     命中: ✓
   …6 轮全部命中
```

写入本身没问题。真正的原因是时序：

```
t=0ms    测试把配置切成「统一模式」
t=0ms    _advance 已经在写壁纸 —— 一次 COM SetWallpaper 要几百毫秒
t=+200ms 那次写入才落地，写的还是**旧配置**的目标
         → 正好盖掉刚写上去的新图
```

修法：`_write` 把在途的写入 Promise 登记进 `pendingWrites`，`_rebuild` 在切换前先等它们收尾
（上限 1.5 秒 —— 写入函数万一卡住也不能把重建堵死）。顺带把「已丢弃的频道」打了 `retired`
标记，在途的那一轮连 `tick` 都不再发，不会再有任何一次写入跨过配置切换。

这条时序用「可以卡住的写入函数」写成了确定性单测（不靠碰运气）：

```
✓ 两路都卡在「写壁纸」这一步上   stalled=2
✓ 重建会先等在途的写入收尾（此刻还没建出新频道）   list=0
✓ 放行后重建完成，只剩统一频道
✓ 已丢弃的频道没有重新武装自己（重建后一次都没再写）   写入次数 2 → 2
```

撤掉等待逻辑这条测试就会红（`list=1`），所以它是有牙齿的。

修完之后 `verify:features` 与 `verify:fixes` 各连跑两遍都是满分 —— 之前那条偶发失败不再出现。

## 第六轮：三处交互调整

### 1. 缩略图右上角的删除图标

![胶片条](docs/界面-胶片条.png)

胶片条每张缩略图的右上角有一个小垃圾桶图标：**当前那张常显，其余悬停才出现**
（20 张都挂一个常驻红图标太吵）。

两个实现上的注意点：

- 图标必须是 `<span>` 而不是 `<button>` —— 外层 `.film-item` 本身就是 `<button>`，
  按钮不能嵌套按钮。
- 点击要 `stopPropagation()`：胶片条用的是事件委托，不拦的话会**先跳到那张图、再删**。
  这条被写成了断言（点非当前那张的图标，取消后画面必须停在原位）。

### 2. 图片信息面板跟着壁纸同步更新

面板开着的时候，轮播切到下一张，面板跟着切（名称、缩略图、全部字段）。
刷新时走 `keepContent` 模式：先不擦掉旧内容，等新数据回来直接替换 ——
否则每切一张都会闪一下"读取中…"。

### 3. 点面板以外的地方关掉面板

图片信息与设置都适用。用 `pointerdown` + 捕获阶段（比 `click` 早一步，切换面板不会错位），
只处理左键；两个开关按钮要放过，否则"点开关想关面板"会先被关掉、紧接着开关又打开，
看起来像点了没反应。两个面板可以同时开着，一次点空白会一起关掉。

### 顺带：把模态框也从系统侧驱动起来了

上一轮留下一条"未覆盖"：原生确认对话框没法在无人值守脚本里点。
这轮补上了 `tools/dialogDriver.js`，于是「确认框 → 真的删掉」这条路可以端到端验证：

| 断言 | 怎么做到的 |
|---|---|
| 点删除图标会弹原生确认框 | 从系统侧找到窗口并确认它属于本应用 |
| 取消 → 文件还在、画面没跳 | Esc 关掉对话框后回读磁盘与状态 |
| 确认 → 文件进了回收站、张数 -1 | 方向键 + 回车按下第一个按钮 |
| 对话框驱动不会误伤别的程序 | 按 pid 锁定；实测系统里另有别人的 `#32770` 窗口，已排除 |

实现上踩了两个坑，都写进注释了：

1. **`FindWindowW('#32770', null)` 返回的是全系统第一个该类窗口** ——
   实测抓到的是别的软件（Geek Uninstaller）的对话框，按键差点发到人家那里去。
   必须先按窗口标题找到自己的主窗口、拿到 pid，再只认 pid 相同的对话框。
2. **`GetWindow(hwnd, GW_HWNDFIRST)` 不是"取第一个子窗口"**，那是"取同级里的第一个"——
   桌面窗口没有同级，所以永远返回 0，看起来像"系统里没有任何窗口"。
   改用 `FindWindowExW(桌面, 上一个, null, null)` 遍历。

按键之前一律先确认对话框就是前台窗口，确认不了就返回 false 让测试跳过 ——
按键漏进应用窗口的后果（空格=暂停、方向键=切图）比测试失败严重。

### 顺带：堵掉「测试配置级联污染」

验证脚本会临时把频道切到测试素材再还原，但脚本中途崩掉时"还原"不会执行 ——
下一轮抓到的"原配置"其实是上一轮的残留，错误一路继承（实测发生了两次）。
现在统一走 `tools/testConfig.js`：第一次跑留一份基线快照且**之后不再覆盖**，
跑完从基线还原并删掉快照。这样即使某一轮崩了，下一轮仍能还原到你的真实配置；
断言里也加了「还原后的目录不能是测试素材」这条硬检查。

## 第七轮：随机 = **把列表本身洗乱**，胶片条能当历史读

### 起因：一句「先是第一页，下一页就跑 100 页去了」

先问了「你现在的随机是不是弄个随机数再跳转」，然后点破了真正的问题：

> 打开程序的时候先做乱序排序，然后就按乱序的顺序切换壁纸就行。这样的话有个好处，
> 就是在看缩略图胶片条的时候就是图片的历史顺序，而不是像现在这个先是第一页、
> 下一页就跑 100 页去了，然后我还没办法追踪上一张我看的图片是哪一张。

我一开始理解偏了 —— 以为是「随机抽取的重复率」问题，还搬了一整套洗牌袋（bag）进去。
真正的问题在**胶片条**：它一直按文件名顺序渲染，而播放走的是另一套随机索引，
两者对不上，于是「上一张在哪」根本无从追踪。

### 改法：随机作用在列表上，不是在索引上

```javascript
// 之前：列表保持文件名顺序，每次随机挑一个索引跳过去
const next = Math.floor(Math.random() * n);
await this.goTo(ch.id, next, dir, reason);

// 现在：扫描时把列表本身洗乱，播放就是顺着列表走
if (shuffle) await this._shuffleFiles(mapped);
...
await this.goTo(ch.id, (ch.index + dir + n) % n, dir, reason);   // 永远 ±1
```

一个改动同时解决四件事：

| | 之前 | 现在 |
|---|---|---|
| 播放方式 | 随机索引跳转 | 顺着列表 ±1 |
| 胶片条顺序 | 文件名顺序（与播放无关） | **就是播放顺序** |
| 「上一张」 | 无从追踪 | 永远在左边一格 |
| 「下一张」 | 可能从第 1 格跳到第 100 格 | 只挪一格 |

顺带把整套 bag 机制（`_refillBag` / `_takeFromBag` / `_pickSlot` / `_consumeFromBag` /
`_remapBag` / `_ensureBag` …）全删了，`scheduler.js` 少了 135 行 ——
**更简单的做法同时更贴合需求**，这是这一轮最大的收获。

### 洗牌结果跟着扫描缓存走

「改个间隔」不该把刚熟悉起来的顺序打乱。所以洗牌结果和目录一起进缓存
（缓存 key 带上 `shuffle` 和 `skipSizeTwin`）：同目录同模式 → 复用同一份洗好的列表。
只有换目录、切「按名称 / 随机」、或主动「重新扫描」才会重新洗一次。

```javascript
const key = `${folder}::${recursive ? 1 : 0}::${shuffle ? 'shuffled' : 'ordered'}::${skipSizeTwin ? 'noTwin' : 'anyTwin'}`;
```

### 孪生避让：连首尾相接一起算

图库里有 70 组内容完全相同的重复文件（同一张图存了日文名 + 罗马音两份），
挨着播看起来就是同一张连着来了两次。小目录（≤ 4096 张）洗牌时会**重洗到没有相邻同体积**
为止；大目录跳过（检查一遍要 stat 全部文件，30348 张要 20 秒以上）。

**列表是循环播的，所以「最后一张接回第一张」也算相邻。** 这条是端到端验证逼出来的：
线性相邻全过，但连续走够一圈之后 `dup-a → dup-b` 还是撞上了。

已知无解的情形：目录极小、同体积的图又占了大半时（3 张里 2 张字节一样），
排成环必然有同色相邻。这时试到上限就照用 —— 不值得为了这个把顺序搅乱。

### UI

- 播放顺序选项文案改成「**随机不重复**」
- 每屏卡片显示「**第 42 / 638 张**」—— 就是它在胶片条上的位置，
  和「上一张 / 下一张」同一套坐标，不用再换算

### 验证

`npm run verify:unit` **59/59**、`npm run verify:order` **24/24**
（真实应用里盯两件事：连续 N 次「下一张」的序号是不是**连续递增**、
胶片条 DOM 里的节点是不是**按序号升序排列**）。

确定性：撤掉列表洗牌、换回「随机跳索引」，单测立刻变红（序号不再连续）。

```bash
npm run verify:order     # 需要 start:debug 先起应用
```

---

## 第八轮：删除确认、托盘删除、全局热键

### 1. 删除前先请求一次许可

截图里那条设置行（「请求删除照片的权限 / 删除项目或文件夹时显示确认对话框」+ 开关）
对应的是一件事：**删除前先问一次**。

原先四个删除入口的行为并不一致 —— 右键菜单直接删，胶片条垃圾桶图标弹确认框。
现在统一成一条路：

```javascript
async function trashWithPermission(imagePath) {
  if (store.get().confirmDelete === false) return performTrash(imagePath);
  if (!(await askDeletePermission(imagePath))) return { ok: false, canceled: true };
  return performTrash(imagePath);
}
```

确认框里带一个「以后删除时不再询问」，勾了就自动把 `confirmDelete` 写成 `false`
并通知界面同步（避免出现「对话框里改了、设置面板还显示开着」）。

设置面板里对应那一行做成了**两行式开关行**：垃圾桶图标 + 标题 + 说明 + 滑块开关。
顺带把设置面板里所有勾选项都从方框改成了滑块 —— 一行开关一行方框看着像坏了。

### 2. 托盘每块屏多了「删除到回收站」

托盘右键 →「显示器 N」→ 子菜单里现在有「删除到回收站」，删的是**这一路当前正在显示的那张**。
走的是和上面完全相同的确认流程。

### 3. 全局热键，自己录

`globalShortcut` 注册，所以窗口藏在托盘里也生效。六个动作：下一张 / 上一张 /
暂停·继续 / 删除当前这张 / 显示·隐藏窗口 / 图片信息。

- **必须带修饰键**。单键全局热键会抢掉全系统的输入 —— 这种坑不能留给人去踩，直接拒绝
- 组合键被别的程序占用时给出原因，界面上标红
- 作用目标是**当前预览的那块屏**：渲染层会把自己的预览选择上报给主进程
  （热键是全局的，窗口可能正藏在托盘里，主进程必须自己记一份）

### 4. 顺手挖出两个真 bug（都不是这一轮引入的）

**① 被删的图会在重建时「复活」。**
频道手里的 `ch.files` 是扫描结果的**副本**（排序/洗牌后新建的数组），
在它上面 `splice` 不会动到 `scanCache`。于是只要之后发生一次重建，
那张已进回收站的图会被重新捞回来 —— 列表里出现一个磁盘上不存在的路径，
轮到它就会黑洞一下。修法：`applyFileMutation` 里把受影响目录的扫描缓存一并作废。

**② 删除后重建，正在看的那张会被顶走。**
重建时索引是从 `progress`（播放进度）里取的，而只有 `goTo` 会写它。
`applyFileMutation` 只改 `ch.index` 不同步 `progress`，于是删除之后一重建，
索引就被那份过期进度顶回原位 —— 画面莫名跳走。修法：一并写回 `progress`。

两个都补了确定性单测（`verify:unit` 第 16、17 节），
撤掉修复立刻变红。这是端到端脚本里一条「删除前基准对齐」的断言逼出来的：
它发现「应用认为自己在放第 8 张，桌面挂的却是第 9 张」。

### 5. 测试工具链修的坑

- **`testConfig` 的还原点漏键**：还原点从 `config.json` 原样读，
  而配置文件里通常只有「被改过的键」—— 新加的配置项在用户没动过之前根本不落盘。
  于是「测试把新项改脏了，还原时因为没有这个键而改不回来」（`confirmDelete` 就这么丢过一次）。
  现在 `begin()` 会把配置补全成「应用实际看到的那份」（缺的键回落默认值），
  `restore()` 还会逐键比对「还原后与还原点是否一致」。
- **原生对话框的复选框也能驱动了**：`Tab` 焦点 → `空格` 勾选 → `Esc` 取消，
  于是「勾不再询问后开关要跟着关」这条也能自动验证。
- **新增 `keyboardDriver.js`**：用 `keybd_event` 往系统里真注入一次按键。
  `globalShortcut.register()` 返回 true 只能说明注册成功，说明不了「按下真的会触发」——
  只有注入一次、再回头看状态变了没有，才算证明了整条链路。

### 6. 附带产出的「读截图」工具

这一轮的起点是一张截图，而当前模型没有视觉能力，于是把「看图」这件事沉淀成了工具：
纯 JS 解 PNG（`imgcodec.js`）→ 版式分析 / 逐字切分 / 字符画 / 区域取色 →
裁一块放大 6 倍再 OCR（`ocr-image.js`，小字必用）。全部不依赖应用在跑。

```bash
npm run verify:tray      # 66 项：删除确认 / 托盘删除 / 全局热键（含真按键注入）
npm run verify:unit      # 79 项
```


## 第九轮：开箱即用的多屏配置，以及「测试不再污染用户系统」

这一轮从三个用户反馈出发，最后挖出三个真 bug + 一处测试基建的系统性缺陷。

### 1. 开箱即用：检测到多屏就自动打开「每屏独立」

以前新用户装完是「所有屏铺同一张图」，得自己进设置开「每屏独立」。
现在**选完目录那一刻**自动打开，并弹一次说明。

触发条件刻意收得很紧，三条都满足才动：

| 条件 | 为什么要这条 |
|---|---|
| 检测到 ≥ 2 块屏 | 单屏开了也没意义 |
| `folder` 非空 | 没目录时每块屏都是空频道，开了等于没开，还让人一头雾水 |
| `autoMonitorSetup !== true` | **只做一次**。用户手动关掉之后再自动打开，那叫抢方向盘 |

两个细节：

- **只有真的检测到多屏才落标记**，所以「先在单屏机器上用了，后来接了第二块屏」还能补上。
- **提示通道分两路**：启动那次走托盘气泡，改配置那次走界面 toast。原因是
  `createWindow()` 之后渲染层可能还没加载完，这时候 `send()` 过去的事件会被丢掉，
  用户就什么提示都看不到。启动路径改用托盘气泡，保证一定能看见。

配套：`resolveProfile` 的「没单独配的屏回落顶层配置」这条规则撑着开箱即用 ——
自动打开之后每块屏都回落到刚选的那个目录，立刻有东西可播。

### 2. 胶片条切走预览再切回来，不跟着当前帧

用户报：「切换显示器后再切回来，缩略图胶带条没有自动移动到当前播放的壁纸，
等时间到了才会滚动过去」。三处叠加：

| 位置 | 问题 |
|---|---|
| `doLoadPreviewChannel` 结尾 | 调的是 `updateFilmstrip(false)` —— 第二个参数就是「不居中」 |
| tick 路径 | `updateFilmstrip(previousIndex !== payload.index)`，只有索引变了才居中 |
| `filmReset()` | 没清 `film.holdUntil`（用户手动翻过后的 8 秒宽限期）——换了一份列表还挂着上一次的宽限期，新列表连一次跟随都捞不到 |

修法：`updateFilmstrip(center, smooth)` 多一个参数（轨道刚重建时用 `behavior:'auto'`
直接落位，否则从 scrollLeft=0 平滑滚到中间会横穿几十张缩略图）；`filmReset()` 清零
`holdUntil`；主路径改成 `updateFilmstrip(true, false)`。顺带修好了「启动时也不居中」。

**另外发现 `centerFilm` 一直算偏 42px**：它用 `el.offsetLeft`，而 `.film-track` 没设
`position`，offsetParent 落到更外层，把轨道左侧两个翻页按钮的宽度算进了目标里。
给 `.film-track` 加一行 `position: relative` 就正过来了（实测偏移 0px）。

### 3. 开机自启「没生效」—— 其实是被测试脚本关掉的

查系统注册表：启动项根本不存在。但手动调一次 `setLoginItemSettings(true)` 写得进去、
回读也对；`--hidden` 启动也是好的（`IsWindowVisible` 为 false）。
最后全项目 grep 抓到真凶：`tools/verify-new-features.js` 第 9 节**无条件**把自启
开一次再关一次，并断言「自启保持关闭」—— 每跑一次 `verify:features`
就把用户的启动项清掉一次。

**这是同类事故的第三次，每次都比上次更深：**

| 次数 | 被污染的东西 | 兜底为什么没拦住 |
|---|---|---|
| 1 | 配置文件（`setConfig` 真的写盘） | 当时还没有 testConfig |
| 2 | 配置文件里的新键 | 还原点从磁盘读，缺键就还原不回来 |
| 3 | **注册表启动项** | testConfig 只管 config.json，系统状态完全没有快照 |

修法：

- `testConfig.snapshotLogin(ev)` / `restoreLogin(ev)`：系统状态单独快照单独还原；
- `restore(ev)` 顺带还原自启，于是任何脚本只要正常跑到结尾都能把上一轮没做完的补上；
- 断言改成**相对**的（记下原值 → 测 → 还原 → 再用**注册表**核一遍），
  不再写「默认应该是关的」这种绝对假设。

### 4. `confirmDelete` 被「镀金」成还原基准，再也回不来

排查 3 的过程中发现用户的「删除前确认」变成了 `false`，而且连兜底快照也是 `false`：

```
run N   : 测试勾了「不再询问」→ confirmDelete 写成 false → 那轮崩了，没走到还原
run N+1 : begin() 看目录是用户的真实目录就判定「干净」→ 顺手写进 config.user-backup.json
          之后无论跑多少次，还原出来的 confirmDelete 都是 false
```

解法是一个**运行标记** `test-in-progress.json`：`begin()` 写下、还原成功才删。
标记还在 = 上一轮没跑完 = 磁盘配置可疑 → 改用兜底快照做还原点，且不再刷新兜底快照
（fail-closed：宁可多还原一次，也不要让脏值变成基准）。

配套：各脚本统一用 `testConfig.describeBaseline(base)` 打印基准告警；
`restore()` 返回的 `diff`（逐键比对实际值与还原点）**在每个脚本里都断言为空** ——
之前只有 `verify:tray` 有这条，所以脏值能静默继承好几轮才被发觉。

### 5. 被掐断的那一轮会把桌面留在测试图上

最后一轮被中断，实况 `config.folder` 停在 `tools\tmp\verify\src`，用户的桌面挂着测试素材。
已按还原点恢复，并从 OS 侧确认两块屏都换回了真实壁纸。
教训记进流程：**中断后必须查 `config.folder`，不能只看有没有报错**。

### 6. README 重写

原文第 2 行就跳进实现细节（随机洗牌、胶片条当历史读），没有一段告诉读者
「这是给谁用的、解决什么问题」。重写后：

- 新增**「谁需要它」场景表**（双屏党 / 几万张图 / AI 出图筛图 / 不想开窗口）；
- 新增**「和 Windows 自带幻灯片的区别」对比表** —— 这是读者决定装不装的关键，
  原来散落在 FAQ 里；
- 功能表分「核心」和「顺手做的」两档，不再 12 行等权重平铺；
- 新增**「首次运行」**章节；
- 验证脚本 / 读截图工具那些开发内容压到末尾，并标注「只想用的话到这里就够了」。

### 验证

- `npm run verify:unit` **85 项**（新增第 18 节：每屏独立时「没单独配的屏回落顶层配置」，
  这是开箱即用的支点；端到端测不到 `monitors` 为空的全新安装状态，因为渲染层没有
  清掉单屏覆盖的接口，所以放单测）
- `npm run verify:features` **129 项**（新增第 10.5 节：没选目录时不动配置、
  选完自动打开、标记只落一次、每块屏都拿到可播的目录、手动关掉后不再自动打开）
- 其余套件复跑通过；`verify:tray` 里的「注册表启动项与测试前一致」是
  「测试不再吃用户设置」的硬证据。

**写这类断言的教训**：`12 张缩略图（88+6）在 1304px 轨道里刚好放下，
scrollWidth === clientWidth` —— 根本不会滚，测「有没有居中」必然通过，测了个寂寞。
要测滚动/居中，先量内容总宽 vs 容器宽，不够就造素材 + 把 index 跳到靠后的位置。

## 第十轮：打包发布，以及踩穿的三个坑

第一次真正跑通 `npm run dist`，产物两个都出来了。过程里踩了三个坑，都是「首次打包必然遇到」的类型。

### 坑 1：ICO 里必须有一帧 256×256

```
⨯ image .../assets/icon.ico must be at least 256x256
```

原来的图标是**一帧 248×256 的 PNG**（从别处裁下来的一张图，不是正方形，也没有 256 那一档）。
写了 `tools/make-icon.js` 解决，顺带做了两件正确的事：

- **cover 裁切**成正方形（短边铺满、长边居中裁），不是拉伸 —— 拉伸会变形；
- 缩小用**盒式滤波**（每个目标像素 = 覆盖到的源像素平均），而不是 `imgcodec.resize` 的
  双线性采样。照片缩到 16×16 时采样会明显起噪点，而图标在任务栏/托盘就是这个尺寸。

```bash
npm run icon      # tools/icon-source.png → assets/icon.ico（6 档）+ assets/icon.png
```

一个诚实的结论：**源图是照片的话，小尺寸必然糊成一块灰**。图标位置小，要的是形状简单的
图形。工具只负责裁方 + 补 256 那一档，不负责把照片变成图标。

### 坑 2：electron-builder 24.x 在 Windows 上解不开 winCodeSign

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权。 : ...\winCodeSign\<tmp>\darwin\10.12\lib\libcrypto.dylib
```

排查过程值得记一笔，因为「看起来像 JS 的问题」其实不是：

1. 先怀疑签名配置 —— 但 `build.win` 里没配 `sign`，无证书时 `winPackager.sign()` 会直接
   `return false`，根本走不到下载。
2. 给 `getSignVendorPath()` 插了栈打印，**栈一次都没打出来**，说明不是 JS 层要的。
3. 查二进制里的符号：`app-builder.exe` 里有 `DownloadWinCodeSign`。而 `winCodeSign-2.6.0.7z`
   里装着 **`rcedit-x64.exe`** —— 改写 exe 的图标和版本信息就用它。所以只要打包（哪怕不签名），
   这个包就必须解开。
4. 试着手工把包解开、放进各种猜的缓存目录（`winCodeSign-2.6.0/`、`winCodeSign/2.6.0/`、
   加 `.version` 标记）——**全都不命中**：没有校验和时 app-builder 每次都重新下载，压根不查缓存。

**结论：17 行的补丁没用，直接升级。** 换成 electron-builder **26.16.1**，同一台机器直接过
（26.x 换了下载与解压实现，会把符号链接降级处理）。这是最干净的修法 —— 留着 24.x 的话，
用户换台机器打包还会撞上。

### 坑 3：输出目录里有旧产物时，它先删再解压

```
⨯ [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":1069,"threshold":50,...}
```

`electron-builder` 解压 electron 之前会 `rm -rf` 目标目录（旧的 `dist/win-unpacked` 有上千个
文件），撞上环境的批量删除保护。换个干净输出目录即可：

```bash
npm run dist -- --config.directories.output=dist-new
```

### 顺带修掉的一个真问题：自动配置挂错了地方

上一轮做的「检测到多屏自动开每屏独立」，我一开始只挂在 `applyConfigChange`（`config:set` 走它）。
写测试时才发现**首次运行「选文件夹」走的是另一条路**：

```
folder:pick（原生目录对话框）→ setChannelProfile() → scheduler.rebuild('profile')
```

`setChannelProfile` 压根不经过 `applyConfigChange` —— 也就是说**最该触发的那条路径反而触发不到**。
测试之所以一开始是绿的，是因为我用 `setConfig({folder})` 造的现场，恰好走了有挂的那条。
现在两条路都挂上了，并且测试改成走**真实路径**（`channelCommand(id, 'set-profile', {folder})`，
少一个原生对话框、其余完全一样）。

教训：**「挂个钩子」一定要先确认用户的真实操作会走到那个函数**。测试自己造的现场越方便，
越容易绕开真实路径。

### 打包版验证

产物：
`dist/壁纸切换器-Setup-0.1.0.exe`（121 MB）、`dist/壁纸切换器-0.1.0-portable.exe`（121 MB）。

不只看「文件生成了」——真的把它跑起来验了一遍（打包版的 exe 直接启动 + CDP 探针）：

| 验的什么 | 结果 |
|---|---|
| 进程能起来、窗口能出 | 页面标题 `壁纸切换器 · Electron` |
| exe 里的资源信息（rcedit 有没有生效） | `ProductName=壁纸切换器`、`FileVersion=0.1.0` |
| 托盘 | 已安装 |
| 多屏识别 | 检测到 2 块屏，建了 2 条独立频道 |
| 配置继承 | 打包版和开发版共用 `%APPDATA%\electron-wallpaper`，启动即用老配置 |

## 第十一轮：全局热键也能换屏，以及换图标时挖出的两个旧 bug

### 1. 新增热键「切到下一台显示器」

原来的六个热键都作用在「当前预览的那块屏」上 —— 但**切换预览目标只能在窗口里点**
（顶栏的「预览：xxx」，或每屏卡片上的小眼睛）。窗口一旦藏进托盘，就只剩一块屏能操作，
另一块要么把窗口叫出来点一下，要么干看着。

现在多了一个 `切到下一台显示器`：按一下，把「当前操作的那一块屏」循环挪到下一块，
`下一张 / 上一张 / 暂停 / 删除 / 图片信息` 的目标都跟着它走，窗口在不在前台都生效。

实现上只有两个要点，但第二个是必须的：

```javascript
// 主进程：循环推进 currentPreviewId
const ids = [...scheduler.channels.keys()];
const next = ids[(ids.indexOf(hotkeyTargetChannelId()) + 1) % ids.length];

// 然后**必须**把它回传给渲染层 —— 不然两边各记一份，迟早漂移
send('preview:select', { id: next, reason: 'hotkey' });
```

热键的「目标」记在主进程（窗口藏在托盘里时它看不到界面状态），而界面上的预览记在渲染层。
只改前者不改后者，用户看到的就是：**画面明明停在 B 屏，热键却在操作 A 屏** ——
而且他多半要等到「怎么删错了图」才发现。所以新增了一条反向通道 `preview:select`：
主进程定目标，渲染层跟着切。

只有一路频道（统一模式）时切不动，这时会明说原因而不是装死
（窗口可见走界面提示，藏在托盘里走托盘气泡）。

### 2. 换图标时挖出的两个旧 bug：`make-icon.js`

换应用图标时顺手核了一下产物，发现两个**一直在生效、只是没人看出来**的问题。

**① cover 裁切用错了缩放基准 —— 主帧根本不是正方形。**

`squareCover` 用的是 `min(size/w, size/h)`，等于按**长边**缩放 —— 那是 contain 的行为：
短边到不了 256，后面的 `crop` 被边界夹住，输出成 249×256 的矩形。
而 ICO 目录项的宽高是「边长」（256 写成 0），于是目录项写着 256×256、载荷其实是 249×256，
图标被**横向拉伸 2.8%**。electron-builder 完全不管（它只看目录项），属于静默错误。

正确基准是 `size / min(w, h)`：短边铺满，长边裁掉。

**② 小尺寸帧的亮度只有主帧的一半。**

`boxDownscale` 求平均时把颜色除以了 `r+g+b`：

```javascript
// ✗ 等于把颜色强行归一化到「三通道和 = 255」
out[wi] = wSum > 0 ? Math.round((r / wSum) * 255) : 0;

// ✓ 分母只能是 alpha 之和
out[wi] = aSum > 0 ? Math.round(r / aSum) : 0;
```

实测后果：256 帧平均色 `rgb(167,161,174)`，缩到 16px 变成 `rgb(83,81,91)` ——
亮度整整掉一半。而 16/32px 恰恰是任务栏和托盘的实际显示尺寸。
改完六帧分别是 `rgb(168,162,175) / rgb(167,162,175) / rgb(167,162,175) / rgb(167,161,174) / rgb(167,162,174) / rgb(167,162,175)`，全部对齐。

顺带把缩图从 `resize` 的双线性采样换成了盒式平均（采样在缩图时等于抽点，
头发这类细节会起噪点），并在生成时加了两道自检：主帧必须是 256×256，
以及**每一帧载荷 PNG 的真实尺寸必须等于目录项声明的尺寸** —— 第二道就是用来堵 ① 的。

### 验证

新增 `npm run verify:cycle`（`tools/verify-monitor-cycle.js`），**38 项全过**。

测试期间把 `applyToSystem` 关掉，所以主流程一张图都不写进系统壁纸；只有第 6 节为了拿到
「热键真的把操作导向了另一块屏」的 OS 侧证据才打开写入，跑完把两屏壁纸存回存档。

覆盖的链路：动作表 / 拒绝无修饰键 / 注册 → 循环切目标且渲染层同步 → 其余热键的目标跟着走
→ 单路时不乱切 → **真往系统里注入一次 `Ctrl+Alt+F10`**（注入前先把窗口藏起来，
顺便证明托盘状态下也生效）→ 切到 B 屏后按「下一张」，OS 侧回读只有 B 屏变了、A 屏一动不动。

还有一步是**负向验证**：把 `send('preview:select')` 那一行注释掉再跑，应该看到 10 项变红
（界面不同步 → 热键仍作用在旧屏 → 误伤另一块屏）。撤掉修复照样全绿的测试，
测的不是那段逻辑，只是在记录现状。

## 第十二轮：热键「不生效」的根子 —— 失败时它一句话都不说

用户反馈「删除当前这张到回收站」这个全局热键不生效。

先说结论：**功能本身没坏。** 三组实测（单屏 / 每屏独立、窗口可见 / 藏进托盘、
`Ctrl+0` / 换一个组合键）都能真把文件移进回收站，回收站条目数跟着 +1；
当前实例里 `Ctrl+0` 也确实注册上了（`hotkeys:get` 的 `registered` 里有它，`failed` 为空），
热键目标和界面预览目标也是同一块屏。

但顺着链路查下去，发现**四条「什么也不说」的失败路径** —— 任何一条走到，
用户能看到的都只有「按了没反应」：

| 位置 | 以前的行为 | 现在 |
|---|---|---|
| `runHotkeyAction` 的 `delete` 支 | `if (id) trash…` —— 目标为空时静默跳过 | 明说「没有可删除的目标」，走界面 toast 或托盘气泡 |
| 同上 | 目标频道 `files` 为空时静默返回 | 明说「XX 现在没有图片，没什么可删的」 |
| 删除结果 | 只发 `send('notice')` —— 那是渲染层的 toast，**窗口藏在托盘时根本看不见** | 托盘态改用 `tray.notify` 气泡，并带上是**哪块屏** |
| 启动注册失败 | 只有 `console.warn` —— 打包版没有控制台，用户永远看不到 | 启动时补一次托盘气泡，点名哪个热键、为什么失败 |

反馈出口统一收进 `notifyHotkey()`：窗口可见走 `notice`，藏在托盘走 `tray.notify`，
两种情况下都往主进程日志写一行 `[hotkey] …`（日志也是可验证的抓手，
`verify-delete-hotkeys` 新加的那节就是靠它）。这条和第九轮 `cycleMonitor` 的处理方式保持一致 ——
当时只给它一个人开了特例，别的动作漏了。

顺带修了 `verify-delete-hotkeys.js` 里一条**过期断言**：结尾原本要求「还原后热键都是空串」，
等于假设用户一个热键都没绑 —— 用户绑了就会被判红（实测就这么红的）。
改成「和开跑前逐键一致」+「测试用的 `Ctrl+Alt+F9` 没漏进配置」。

新增第 8 节验证（`npm run verify:tray`）：把目标目录清空 → 删除 → 必须弹出明确原因；
换回素材 → 删除 → 提示里要说清删了哪张、张数 -1。**75 项全过**。

## 第十三轮：热键「不生效」的真根因 —— 录出来的绑定本身就唤不醒

上一轮修完反馈通路，用户又反馈了一次「还是没生效」。**说明第十二轮的结论只对了一半**：
反馈缺失确实该补，但没说清「为什么按下去真的没反应」。这一轮挖到了两个真正的根因。

### 根因 1：录制只看 `e.key`，小键盘录出来的绑定永远唤不醒

主键盘 `0` 和小键盘 `0` 的 `KeyboardEvent.key` **都是 `"0"`**，
而 Electron 的 accelerator 语法**根本表达不了小键盘数字**：
`Numpad0` 直接抛 `conversion failure`；`num0` 能注册成功，却一次都不触发。

只按 `e.key` 换算，用小键盘录出来的就是一个**看着对、按下去没反应**的绑定 ——
配置里躺着 `Ctrl+0`，界面上显示「已绑定 Ctrl + 0」，用户按小键盘 0 却毫无动静。

决定性实测（不是照文档抄的）：

| 实验 | 结果 |
|---|---|
| 逐个 `try/catch` 注册候选键名 | `Numpad0` / `NumpadDecimal` / `Decimal` → **抛异常**；`num0` / `Num0` → 注册成功 |
| 注册 `Alt+Shift+0` 与 `Alt+Shift+num0`，各注入一次真实按键 | 主键盘 0 命中 `0`；**小键盘 0 一次都没命中 `num0`** |
| 对照：注入后 `GetAsyncKeyState(0x60)` | `0xffff8001`（高位为 1）→ **系统确认小键盘确实被按下**，排除"注入路径有问题" |

### 根因 2：`KEY_NAMES` 把标点映成了 Electron 不认的 DOM 名字

原表把 `.` 映成 `Period`、`,` 映成 `Comma`、`-` 映成 `Minus`……
而实测的结论刚好相反：**Electron 认字面字符 `.`、不认 `Period`**。

| 合法（实测通过） | 非法（抛 conversion failure） |
|---|---|
| `0`–`9`、`A`–`Z`、`F1`–`F24` | `Numpad0`、`NumpadDecimal`、`Decimal` |
| 字面标点 `` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` `~` `!` `@` `#` `$` `%` `^` `&` `*` `(` `)` `_` `{` `}` `\|` `:` `"` `<` `>` `?` | DOM 名 `Period` `Comma` `Slash` `Semicolon` `Quote` `BracketLeft` `BracketRight` `Backslash` `Backquote` `Minus` |
| `Plus` `Space` `Return` `Enter` `Up` `Escape` `Delete` `Tab` | |

于是录 `Ctrl+.` 会在配置里留下 `Ctrl+Period` —— 一个**永远注册不上**的绑定。
`+` 单独注意：它是 accelerator 的分隔符，加号只能写 `Plus`。

### 修法

- `acceleratorFromEvent()` 改成**物理键优先**（`e.code` → `CODE_KEYS`）：用 code 才能区分
  主键盘与小键盘，也不受输入法布局影响；
- `Numpad*` **直接拒绝**并说清原因（「小键盘的键绑不上全局热键，请改用主键盘的数字」）——
  与其静默存一个唤不醒的绑定，不如当场告诉用户；
- 标点改用**字面字符**；拿不准的一律拒绝，**绝不把 Electron 不认识的字符串写进配置**；
- 拒绝时**保持录制态**，用户只是按错了键，应该能直接换一个再按；
- 主进程 `applyHotkeys()` 的 catch 里补 `explainAcceleratorError()`，把
  `conversion failure from Ctrl+Period` 翻成「键名「Period」不是 Electron 认识的名字，改成「.」就行」——
  **兜住历史遗留配置**，不用等用户再来问一次。

### 验证（CDP 驱动真实录制流程，5/5）

| 用例 | 期望 | 实测 |
|---|---|---|
| Ctrl + 小键盘 0 | 拒绝 + 保持录制态 | ✓ 提示「小键盘的键绑不上全局热键…」 |
| Ctrl + 主键盘 0 | `Ctrl+0` 且注册成功 | ✓ |
| Ctrl + `.` | `Ctrl+.` 且注册成功 | ✓ **旧代码在这里会存成非法的 `Ctrl+Period`** |
| Ctrl + M | `Ctrl+M` | ✓ |
| 单独按 5 | 拒绝 | ✓ 提示「必须带修饰键」 |

顺带一提：用户自己先我一步找到了绕法 ——「之前是小键盘的 0，我换成字母上的就可以了」。
这恰好印证了根因 1；但**绕得过去不等于没 bug**，静默存下一个唤不醒的绑定仍然是坑，
所以还是按上面的方式修掉了。

## 第十四轮：触摸屏手势、工具栏隐藏时长、换图标

用户提了三件事：换项目图标、让触摸屏也能左右滑动切图、把工具栏自动隐藏的时长交出来给用户调。

### 一、触摸屏左右滑动（原来只有鼠标和触控板能用）

代码里本来就有 pointer 手势，鼠标拖和触控板双指横滑都能用 —— 但触摸屏上**完全没反应**。

根因不在 JS，在 CSS：全项目**一处 `touch-action` 都没有**。于是触摸屏上左右拖会被浏览器判定为
滚动手势接管，接管的那一刻发 `pointercancel`；而手势代码的 cancel 分支是**丢弃这次滑动**
（原本的意图是「被别的交互打断就别切图」，对鼠标合理）。两者凑到一起，结果就是「手指划不动」。
桌面端鼠标不触发这个问题，因为鼠标拖动不会被浏览器抢走。

修法只有一行，但**写在哪一层是关键**：

```css
.layer { touch-action: none; }   /* .layer 是 inset:0 铺满舞台的壁纸表面 */
```

不能写在 `#stage` 上。`touch-action` 是**元素与所有祖先的交集**，祖先写 `none` 会把子孙一起锁死 ——
而 `#stage` 是设置面板、图片信息面板、胶片条的共同祖先，写它上面就等于换来一个更大的坑：
「面板在触摸屏上滚不动」。`.layer` 只管显示图、底下没有任何可滚动内容，面板也不是它的子孙。

另外把唤醒工具栏从 `mousedown` 换成 `pointerdown`：触摸屏不产生鼠标事件，只用鼠标事件的话，
工具栏一旦自动隐藏，**手指就再也叫不回来了**（点一下都不行）。这条比滑动本身更容易被忽略。

顺手写了个 `-webkit-touch-callout: none` 想压掉长按菜单，结果**验证时发现它被 Chromium 直接丢弃**
（那种属性是 Safari/iOS 专有的，Chromium 的 CSS 解析器不认）—— 读样式表规则时 `st.webkitTouchCallout`
是空的。既然无效就删掉：Electron 里长按图片本来就走 `contextmenu`，交给应用自己的右键菜单即可。
**写了等于没写的 CSS，比不写更坏 —— 它会让人以为这里已经处理过了。**

### 二、工具栏自动隐藏时长可配

`pokeBars()` 里原来写死 2400ms。改成读配置 `autoHideDelay`（毫秒，**0 = 一直显示**），
设置面板加了滑块（0 – 20000，步进 200，标签按 2.4 秒 / 800 ms / 一直显示 三种形态显示）。

### 三、换图标

源图是一张 AI 生成的方形图，走项目自己的 `npm run icon`（cover 裁方 → 盒式平均缩图 → ICO）。
ICO 结构另外**独立解了一遍**做交叉验证，不复用生成脚本的自检代码：

```
256×256 / 128×128 / 64×64 / 48×48 / 32×32 / 16×16 共 6 帧
每帧目录项声明尺寸 与 内嵌 PNG 的 IHDR 实际尺寸 逐项一致 ✓
含 256×256 帧 ✓（electron-builder 的硬要求）
```

### 验证

触摸这块**必须派发可信触摸事件**才测得出来：合成 `PointerEvent` 走不到浏览器的 touch-action 仲裁，
用它测等于没测。所以用 CDP 的 `Input.dispatchTouchEvent`（可信事件，走真实输入管线）。

| 组 | 结果 |
|---|---|
| 对照实验（证明测试有效 & 这行 CSS 是必需的） | **3/3**：有 `touch-action:none` 切图 ✓ / 打回 `auto`（等效修复前）**不**切图 ✓ / 去掉覆盖又恢复切图 ✓ |
| 触摸手势 + 自动隐藏全量 | **11/11**：左滑切下一张、右滑切上一张、纵向拖动不误触、触摸唤醒工具栏 |
| 唤醒工具栏（确定性，用 20 秒时长排除倒计时干扰） | **3/3**：一次触摸即唤醒 / 唤醒后保持 / 鼠标移动仍能唤醒（回归） |
| 新设置的 UI 接线（走真实滑块事件，不是直接调 IPC） | **5/5**：字段排版正常、拖动时标签实时更新、松开落盘、0 显示「一直显示」、面板纵向可滚 |

**对照实验这一环是本轮最该记下来的做法**：先证明「把修复撤掉，测试会红」，再相信「测试绿」。
否则一次全绿的测试完全可能只是因为测试根本抓不到差别 —— 尤其是「派发事件」这类测试。

### 顺带记一个自己踩的坑：断言不要挑时间窗

第一版把「滑动后工具栏是否还在」塞进「睡 1200ms 之后」，而默认隐藏时长是 2400ms。
两次跑出相反结果：第一次通过、第二次失败 —— 不是功能不稳，是**断言撞上了倒计时**，
再叠上 CDP 往返延迟就随机飘。改成先把时长调到 20 秒、把这个变量隔离掉，结果立刻稳定。
**读数要看变量，别让两个时间尺度互相污染。**

## 第十五轮：切「播放顺序」主页面不动 —— 指纹漏了一项

用户反馈：在设置面板切换播放顺序后，回主页面没有马上换。

复现出来的判据是**主进程与渲染层的分歧**（主进程已经重排，渲染层还停在旧顺序）：

| 采样 | 主进程顺序 | 渲染层顺序 | loadedSignature |
|---|---|---|---|
| 切换前（随机） | 随机序 | 同左 | `…\|1\|638\|0` |
| 点了「按名称顺序」 | **已变成名称序**（下划线 / 数字开头的排到了最前） | **纹丝不动** | 与切换前完全相同 |

调度器没问题：`_orderFor` 里 `saved.shuffle !== shuffled` 就会重洗，`channels:changed` 也照发了。
问题在渲染层 —— 判断「要不要重新取文件列表」的那个指纹，没把播放顺序算进去：

```js
// 改前
return [ch.id, ch.profile.folder, ch.profile.recursive ? 1 : 0, ch.count, ch.rev || 0].join('|');
```

切模式时指纹不变 → `loadPreviewChannel()` 不执行 → 界面继续用旧的 `state.files`。
所以「怎么切都不动」，而底层数据其实早就换了。

### 顺着这条线又揪出第二处（同一成因，但更隐蔽）

`onTick` 是拿 `state.files[payload.index]` 渲染的，**并不用 tick 里带的 `entry.path`**。
而随机模式**走完一轮**会调用 `_startNextRound` 重洗列表 —— 这同样不进指纹，
而且**只发 `tick`、不发 `channels`**。于是那段指纹比较根本不会执行：
它住在 `applyChannelInfo` 里，只在 `channels:changed` 时才跑。

结果是走完一轮之后：窗口预览与桌面壁纸**各显示一张不同的图**，胶片条停在上一轮的顺序。
这个用户还没报，是查第一个问题时顺出来的。

### 改法

1. 指纹补上两个会改变顺序的因素：`ch.profile.shuffle`（播放顺序模式）与 `ch.rounds`（走完一轮会重洗）。
2. 走完一轮后补发一次 `channels` 事件（`reason: 'new-round'`）——
   顺序变了就必须走 channels 通道，否则渲染层不会去比指纹。

### 验证

| 组 | 结果 |
|---|---|
| 切换播放顺序（真实点击 UI，走完整链路） | **6/6**：主进程重排 ✓ / **渲染层跟着重排** ✓ / 两边逐项一致 ✓ / 指纹随模式变化（`\|r\|`→`\|n\|`）✓ / 切回仍一致 ✓ |
| 走完一轮（3 张图 + 1 秒间隔，把一轮压到几秒） | **2/2**：指纹随 rounds 变化 ✓ / **`loadedSignature` 跟上新指纹（证明确实重载了）** ✓ |
| 原有单元测试 | **85/85** 无回归 |

这里有个**测试强度**问题值得记一笔：3 张图重洗有可能恰好又洗回原顺序，
那么「两边顺序一致」就是白过。所以补了一条与顺序无关的检查 ——
只看「rounds 自增时指纹是否跟着变、`loadedSignature` 是否跟上」，
直接验机制本身，不依赖洗牌结果碰巧不同。

### 两个教训

1. **「判断某件事变没变」的指纹，必须把所有会改变那件事的因素列全。**
   漏一项不会报错，只会表现为「怎么点都没反应」—— 这类静默失效最难查：
   看起来像功能没实现，其实是实现对了、通知没到位。
2. **同一个成因可能同时藏在两条事件路径上。**
   第一处修复（指纹加 `shuffle`）能生效，是因为它走 `channels:changed`；
   第二处（走完一轮）只走 `tick`，光改指纹完全没用。
   我是先在验证里看到「指纹变了、但 `loadedSignature` 没跟上」，才发现那段比较逻辑压根没被执行。
   **改了判断条件之后，要确认那段判断到底在不在目标事件的路径上。**

## 第十六轮：桌面右键菜单，以及热键第 8 个动作

这轮加的两样都属于「不想先打开程序」的场景：在桌面上直接对**光标所在的那块屏**动手。

### 桌面右键菜单（两项，各一个开关）

写在 `HKCU\Software\Classes\DesktopBackground\Shell` 下：**切换到下一张壁纸**、**删除当前显示器的壁纸**。

- `src/shellMenu.js` 用 koffi 直调 `advapi32` 读写注册表（`RegSetKeyValueW` / `RegGetValueW` / `RegDeleteTreeW`），
  不依赖 `reg.exe`，也不需要管理员权限 —— 写的是 HKCU，跟用户自己的设置一个级别。
- 两项都按**光标落在哪块屏**生效，共用 `channelAtCursor()` 定位目标频道；
  `runDesktopMenuAction()` 是唯一入口，`second-instance` 转发与「App 没在跑时点菜单」的启动补办都走它。
- 设置面板里两个独立开关，勾选状态**直接回读注册表**（不是读配置），
  否则「用户手工删了注册表项、界面还显示开着」。

三个踩出来的坑：

| 现象 | 根因 | 处理 |
|---|---|---|
| 点菜单必现 `RPC_E_CALL_REJECTED` | 点菜单那一刻 explorer 正忙，COM 调用被拒 | 退避重试（150ms 起，上限 2s） |
| 拿光标坐标永远定位不到显示器 | `monitorIdForRect` 只认**整块屏**的矩形，拿一个点去问必然 null | 新增 `monitorIdForPoint()`（按包含关系判定） |
| 点一次菜单留一个吊住 30 秒的僵尸进程 | 转发进程在 ready 之前走 `app.quit()` 会挂住 | 改 `app.exit(0)`；补办完事的实例窗口静默、办完自退 |

### 全局热键第 8 个动作：打开所在文件夹

打开当前操作那块屏**正在显示**的图片所在目录并选中它，不弹主窗口。托盘态下用气泡回执，讲清楚定位的是哪块屏的哪张图；图片不在或目录没了都有明确提示。

---

## 第十七轮：重启后接着上次那张播

用户反馈：**开机自启之后总是从第一张开始**，希望「记住上一张的位置，从那张继续」。

### 先确认现象

配置里确实只有播放参数，没有任何进度字段；`MonitorScheduler` 的进度（`this.progress`）是一个**内存 Map**，
随进程一起消失。所以每次启动 `_rebuild` 时 `saved` 都是 undefined → `index = 0` → 接管时写第一张。
实测（两块屏、共 15k 张、随机模式）：启动后两路都停在 `index = 0`。

### 为什么不只是「把 index 存下来」

这是这轮最容易被做错的地方：**随机模式下列表每次启动都会重新洗牌**（见 `_orderFor`），
序号只对「当时那份列表」有意义。存「第 27 张」，下次启动会落到另一张图上。

所以记录的是**路径**，启动后在重排过的列表里把它找回来；找不到（图被删/改名）才退回序号并对齐到列表范围内。
实测数据正好证明了这一点 —— 重启前后：

| 频道 | 重启前 | 重启后 | 说明 |
|---|---|---|---|
| 主屏 3840×2160 | 第 3 张 `真理-Mari_兔兔_…p0.png` | **同一张**，位置变成第 531 张 | 列表重洗了，序号完全对不上 |
| 副屏 1600×2560 | 第 2 张 `Anima-…00010_.png` | **同一张**，位置变成第 1608 张 | 同上 |

### 改法

- 新增 `src/playbackState.js`：位置存档，独立文件 `userData/playback.json`。
  **不塞进 `config.json`** —— 它每次换图都要写（间隔可能只有几秒），
  混进配置文件只会让 diff 全是噪声，还会和用户手改配置撞车。
- `scheduler` 的起点优先级变成三段：**本次会话的内存进度 → 磁盘存档 → 第一张**。
  统一入口 `_remember(ch)`：所有会改变「当前是哪张」的地方（`goTo` / `setPlaying` / `pauseAll` /
  `applyFileMutation`）都走它，免得漏一处就出个「偶尔回到第一张」。
- 换过目录的旧记录不认（`folder` 不匹配直接作废）—— 上一次的「第 27 张」指的是另一个目录里的另一张图。
- 写盘合并 1.5 秒内的多次改动，正常退出时 `flush()` 补一次；进程被强杀最多丢最后一次切换。
- 超过 120 天的记录在读盘时丢弃（显示器拔了、目录换了，老记录留着没意义）。
- 新增设置项 `resumeLast`（默认开），位置在「设置 → 系统集成」；新增 `npm run verify:resume`。

### 验证

| 组 | 结果 |
|---|---|
| 新增单测 `npm run verify:resume` | **28/28**（两个 scheduler 实例 + 各自重新读盘的 Store 模拟「关机再开机」） |
| 原有单测 `npm run verify:unit` | **85/85** 无回归 |
| 真实应用重启（CDP 读状态） | 两路都回到同一张图，**name 完全一致**，序号因重洗而变化 |
| 真实应用重启（系统层对账） | 关机前后 `IDesktopWallpaper::GetWallpaper` 逐屏比对，**两张都没变** |
| 界面开关 | 元素存在、默认勾选、文案正确 |

其中「系统层对账」这条是关键：`applyOnStart` 为 true 时启动必定会写一次壁纸，
如果没恢复就会写成第一张（另一张图）；比对结果两张都没变，说明写的确实是上次那张。

### 顺带确认的一件事

开机自启走的是 `app.setLoginItemSettings({ path: process.execPath, args: loginArgs() })`，
而本机注册表里那条是这个源码目录：

```
electron-wallpaper = "...\electron-wallpaper\node_modules\electron\dist\electron.exe" "...\electron-wallpaper" --hidden
```

也就是说**自启跑的就是这份源码**（不是打包版 exe）—— 所以这个修复对开机自启直接生效，
不需要重新打包。打包版要等下次出包才带上。

---

## 第二十四轮：不是「写不进去」，是**同步编码把主进程冻住了 6.8 秒**

### 起因：用户追问「以前是可以的」

第二十三轮把根因写成「`clipboard.write()` 永不返回」，并据此加了超时 + 兜底。
用户随后问了一句很关键的话：**「为什么不能复制，以前是可以的？」**

这句话逼出了两个结论，第一个是**我上一轮判断错了**。

### 纠正：`write()` 并不「永不返回」

对递增尺寸的图实测（同一台机器、同一个 Electron 44.3.0）：

| 尺寸 | 像素 | `clipboard.write` 返回情况 |
|---|---|---|
| 1000×2000 | 2 MP | 正常返回，86 ms |
| 2560×2560 | 6.6 MP | 正常返回，184 ms |
| 10000×6667 | 66.7 MP（254 MiB 载荷） | **正常返回，1330 ms** |

从 2 MP 到 66.7 MP 全部正常。所谓「永不返回」在这台机器上**复现不出来**，
第二十三轮据此做的修复方向是偏的（超时和兜底仍然有价值 —— 它们是安全网，
但**不是**用户遇到的这件事的原因）。

### 真因：`toPNG()` 是同步的，而且没人告诉用户它在跑

分阶段计时（`nativeImage.createFromPath` → `toPNG` → `clipboard.write`）：

| 尺寸 | 读盘解码 | **`toPNG()`** | 写剪贴板 | 端到端 |
|---|---|---|---|---|
| 1000×2000 | 20 ms | 460 ms | 86 ms | **0.5 s** |
| 2560×2560 | 75 ms | 925 ms | 184 ms | **1.2 s** |
| 9000×6300 | 390 ms | 3294 ms | 1072 ms | **6.6 s** |
| 10000×6667 | 363 ms | **4887 ms** | 1330 ms | **6.8 s** |

`toPNG()` 在主进程里**同步**执行。用独立进程采样主线程的 CPU 时间，量到的
「梗死」是 **4888 ms**，与耗时完全吻合 —— 那 4.9 秒里界面**一个像素都不会更新**。

于是用户看到的是：右键 → 菜单关闭 → 界面死 5~7 秒 → 没有任何提示。
在这个窗口里切出去 Ctrl+V，粘到的是**上一次**的剪贴板内容 → 「粘贴不出来」。

**数据其实是写进去的**：写完立刻 `TerminateProcess` 杀掉属主进程，
再换一个 Python 进程去读，拿到 `CF_DIBV5 254.3 MiB、头里尺寸 10000×6667`，
系统还自动合成了 `CF_DIB` + `CF_BITMAP`。所以「复制失败」是假象。

### 为什么「以前可以」：因为图变大了

扫过用户四个相册目录共 **12 695 张**：

| 分位 | 像素 | 该尺寸的端到端耗时 |
|---|---|---|
| p50 | 4.7 MP | ≈ 0.9 s（感觉是「瞬间」） |
| p90 | 11.7 MP | ≈ 2 s |
| p99 | 34.8 MP | ≈ 4 s |
| max | 66.7 MP | 6.8 s（超 33 MP 的有 158 张，超 40 MP 的有 77 张） |

2 MP 的图 0.5 秒就完事，用户「右键 → 切窗口 → Ctrl+V」的节奏本来接得住；
换成 9000×6300 那批就接不住了。**没有任何代码被改坏，是数据越过了感受阈值。**

### 修法：一档快路 + 一句「正在复制」

**① 大图快路（> 12 MP）：跳过 PNG 编码，直接拼 `CF_DIBV5`**

Windows 程序读剪贴板要的是 `CF_DIB` / `CF_DIBV5` / `CF_BITMAP`。
Chromium 写 `image/png` 时会**多注册一个 `PNG` 格式**，但那份 PNG 编码是白烧的
—— 而 `clipboardWin.writeImage` 本来就能只拼 `CF_DIBV5`（+ 预乘 BGRA）直接交出句柄。

同一张 66.7 MP 的图：**原生直写 813 ms vs 走 Electron 6782 ms，快 8.3 倍**
（端到端 6.8 s → 0.9 s）。代价只有一个：剪贴板里少注册格式 `PNG`。
所以**小图不走快路** —— 小图上 `toPNG` 只要几百毫秒，保留 `PNG` 格式更划算。
阈值取 12 MP 的依据就是上面那张分位表：p90 = 11.7 MP，九成图片行为完全不变
（阈值与理由都写在 `fileActions.js` 的 `FAST_PATH_PIXELS` 注释里）。

**② 先报进度，再干活**

`copyImageWithNotice()`：先用 `imageSize.readImageSize()` **只读文件头**
（不解码，几百字节）算出「这张图多大、走哪条路」，把提示交出去，
**让出一帧（80 ms）**让渲染层真的画到屏幕上，然后才去做那段会把主进程冻住的同步活。

这一条比快路更根本：它把「点了没反应」变成「在等」，而且**对任何尺寸都成立**
—— 就算将来有更慢的图，用户至少知道程序在干活。

### 验证（`npm run verify:clipboard`，38/38）

新增 §7 一节专门钉住快路：

| 断言 | 结果 |
|---|---|
| `planCopy` 认得出大图/小图（只读文件头） | 3600×3600 → 快路；1280×720 → 老路 |
| 强制快路的位图 == Chromium 写的同一份（逐字节） | 16 / 16 字节相同 |
| 大图不传参数也自动走快路 | `fast:true`，`method:native` |
| **快路一次 `clipboard.write` 都没调** | 0 次（成本全在 `toPNG`，绕开它就是全部收益） |
| 两条路回读的位图都装得下整图 | dibv5 = 51 840 124 ≥ 51 840 000 |
| 同一张大图，快路更快 | **快路 155 ms vs 老路 349 ms** |
| 快路没写注册格式 `PNG`（代价，钉住免得将来当 bug 修） | formats=[17,2,8] |
| 小图（Electron 路）带注册格式 `PNG` | formats=[49582,17,2,8] |
| 提示发生在冻结**之前**（不是干完活才报） | 提示 1 ms / 总 257 ms |

> §7 用的是**合成纯色图**（12.96 MP），纯色极易压缩，所以「155 vs 349」这个
> 2.25 倍是**低估** —— 真实照片上量到的是 8.3 倍。夹具选纯色是为了跑得快，
> 结论以真实图那组数为准。

顺带钉住的既有行为：unit **153** / wiring **37** / resume **28** 全绿。

### 顺手挖出的两个「跑不起来」的坑（都不是业务代码的问题）

排查过程中验证脚本连着两次「卡住不动、没有任何输出」，都与代码无关：

| 坑 | 表现 | 根因 | 处理 |
|---|---|---|---|
| `ELECTRON_RUN_AS_NODE` 被环境注入 | `Cannot read properties of undefined (reading 'write')` —— 报的错和真实代码毫无关系 | Electron 见到这个变量就退化成**纯 Node**，`require('electron')` 只返回 exe 的路径字符串，于是 `app` / `clipboard` 全是 `undefined` | 启动前从环境里剔掉（**只看「在不在」，不看值：空串和 `0` 一样致命**） |
| 与运行中的应用**共用 `user-data-dir`** | 卡死、无输出，脚本顶层代码一行都没执行 | 用户的应用常年开着，第二个实例在 **Chromium 启动阶段**就被 `ProcessSingleton` 挡住 | 验证脚本必须给一次性的隔离 profile |

第二个坑还解释了一个巧合：第二十三轮的 21/21 之所以能跑过，
是因为**那会儿用户的应用正好没在跑**（被我误杀的那次）。这类「上次能跑、这次卡住」
最容易误判成「改坏了」。

于是新增 `tools/run-electron.py`（前台跑 Electron 脚本）：
剔环境变量 + 一次性隔离 profile + 输出重定向到文件后回读（Windows 上 Electron 是
GUI 子系统程序，正常模式 stdout 不一定接得上）。
`launch-dev.py` 负责**后台启动应用**，它负责**前台跑脚本并等退出码**，分工不重叠。
`npm run verify:clipboard` 已改走它。

---

## 第二十三轮：复制图像「点了没反应」，以及「打开方式」入口

### 现象

右键菜单的「复制图像到剪贴板」失效 —— 而且是**最难受的那种失效**：点了没有任何提示、
粘贴也拿不到东西。不是报错，是彻底没反应。

「没反应」本身就是线索：菜单项 `click` 里是 `await fileActions.copyImage(...)` 之后
再弹提示。中间任何一环不返回，用户就什么都看不到；报错反而好查。

### 根因（实测，不是推测）

Electron 44.3.0 的主进程 clipboard 是 W3C 异步风格（`write([ClipboardItem])`），
它返回的 Promise 在**剪贴板被别的程序占着、或 Chromium 内部状态没走完**时
**既不 resolve 也不 reject** —— click 里的 await 就永远停在那儿。

复现方式：把 `clipboard.write` 换成 `() => new Promise(() => {})`，
症状与用户描述完全一致（见「验证」§3）。修复前后的差别：

| | 改前 | 改后 |
|---|---|---|
| write 挂死 | 永远等下去，无提示、无复制 | 1500ms 后判超时，转原生直写，提示「已复制」 |
| write 报错 | 提示一行错误 | 提示错误 + 自动落到原生直写 |
| 写成功但其实是空壳 | 无从知道 | 写完立刻回读系统剪贴板核体积 |

顺手挖出的同族问题：

| 问题 | 根因 | 处理 |
|---|---|---|
| 「写成功」不代表剪贴板里真有图 | Chromium 用**延迟渲染**：`write()` resolve 只代表它认领了剪贴板，真实字节要等粘贴方来要时才生成 | 写完立刻用 Win32 回读，量 `CF_DIB` / `CF_DIBV5` 的载荷体积，对得上 `宽×高×4` 才算成功（这一步顺带把延迟数据实体化） |
| 文件不在时一排灰项 | 置灰不写理由，用户看到的就是「点了没反应」 | 菜单顶上补一行置灰说明「文件已不在（可能被移走或删掉了）」 |
| BMP / GIF / WebP 复制不了 | Electron 的 `nativeImage` 解码器只认 PNG / JPEG（实测 BMP、GIF 都返回空图） | 错误信息直说原因并给替代做法（「复制文件到剪贴板」）。**没有**硬造一条解码路径 —— 代价与收益不成比例 |

### 设计决定

| 决定 | 理由 |
|---|---|
| **给 `clipboard.write()` 加 1500ms 硬超时** | 它可能永远不返回；没有死线就没有兜底可谈。超时后照样把图复制出去，用户至少看到结果 |
| **兜底用 Win32 直写 `CF_DIBV5` + 注册格式 `PNG`** | 与既有的 `CF_HDROP` 同一条思路：绕开 Chromium，`SetClipboardData` 交的是**真实句柄**，不依赖延迟渲染，也不依赖属主进程当时忙不忙 |
| **像素原样照抄 `nativeImage.toBitmap()`（预乘 BGRA）** | 实测：Chromium 自己写进 `CF_DIBV5` 的就是这份字节，**逐字节相同**。粘贴方怎么认 Chromium 的输出，就怎么认我们的 —— 不引入第二套 alpha 语义 |
| **正常路径仍然是 Electron 的 `write()`** | 原生兜底要在 JS 里持有一份整图字节（9000×4500 约 162 MB），只该在必要时用；结果里用 `method: 'electron' \| 'native'` 标出走的是哪条，提示语也会说明 |
| **「打开方式」用 `rundll32 shell32.dll,OpenAs_RunDLL` 另起进程** | `SHOpenWithDialog` 是**模态**的，直接调会把主进程的消息循环卡到对话框关闭为止 —— 本应用的全部轮播定时器都在主进程里，卡住就是桌面定格。慢一秒换「对话框开着的时候壁纸照样轮播」 |
| **程序列表与系统对话框并存** | 列表是日常主路径（选过一次就记住、一点就开）；系统对话框用来对付没添加过的格式或临时换程序。两者在同一个子菜单里 |
| **`copyImage()` 全程不抛异常** | 它由菜单 click 直接 await。抛出去 = 又是「点了没反应」。所有分支都返回结构化结果 |

### 改动

- `src/clipboardWin.js`（129 → 326 行）：新增 `readImageStatus()`（枚举格式 + 量 DIB 载荷体积）、
  `writeImage()`（自建 `BITMAPV5HEADER` + BGRA → `CF_DIBV5`，另注册 `PNG`）、`buildDibV5()`；
  `OpenClipboard` 统一带重试（被占用时用 `Atomics.wait` 同步等待 —— 这层是同步 API，
  重试不该把调用方染成 async）
- `src/fileActions.js`（334 → 463 行）：`copyImage()` 改成三步（硬超时 → 回读校验 → 原生兜底）
  且不抛异常；新增 `openWithDialog()`
- `src/main.js`：复制项改为「成功才提示、失败给原因」，并标注是否走了兜底；
  文件不在时菜单顶部补说明；`openWithSubmenu()` 增加「打开方式…（系统对话框）」；
  新增 IPC `file:open-with-dialog`
- `src/preload.js`：暴露 `openWithDialog`
- `tools/clipboardReader.js`：`inspect()` 增加 `sizes`（位图载荷体积，「格式在」和「图在里面」是两件事）
- `tools/verify-clipboard.js`：**新增**（257 行，21 条断言），`npm run verify:clipboard`
- `tools/verify-new-features.js`：复制断言加深（核对 `method` 与载荷体积）、
  新增「「打开方式」入口存在且接了动作」「文件不在时有说明」两条

### 验证

| 层次 | 结果 |
|---|---|
| **新增** `npm run verify:clipboard`（要 Electron，不碰桌面） | **21/21** —— §1 回读接口 / §2 正常路径（体积对得上）/ §3 write 挂死→超时→兜底（实测 1537ms）/ §4 write reject→兜底 / §5 **像素级**：兜底写出的 `CF_DIBV5` 与 `toBitmap()`、与 Chromium 自己写的逐字节相同，且等于手算的预乘 BGRA（4 个 alpha 边界）/ §6 四个守卫分支 |
| `verify:unit` | **153/153**（未动调度逻辑） |
| `verify:wiring` | **37/37** |
| `verify:resume` | **28/28** |
| 真机菜单核对（隔离 `--user-data-dir` 实例 + CDP 取模板） | 「用其他程序打开 ▸ 选择程序… / **打开方式…（系统对话框）**」两项都在且都接了 click；文件不存在时菜单顶部出现「文件已不在（可能被移走或删掉了）」 |
| ⚠️ `verify:features` | **未跑** —— 它会临时把配置改成测试素材（`testConfig` 直接读写真实 `%APPDATA%` 配置），而用户此刻正在用这个应用，跑起来桌面会开始播测试图。等这轮告一段落再单独跑 |

> 补一句为什么「像素级」那条值得写：`CF_DIBV5` 的 32bpp 像素**预乘 alpha 还是直存 alpha**
> 在 Windows 上两种实现都有，猜错的表现是「透明图粘出来边缘发黑」这种很难归因的问题。
> 那就别猜 —— 拿 Chromium 自己的输出当基准，逐字节比。

### 一条操作教训（和我改的代码无关，但很值钱）

收尾清理调试实例时用了 `proc-list.py --kill --under=<项目目录>`。它按**镜像路径**过滤，
而调试实例和用户正在跑的实例**共用同一个 `electron.exe` 路径** —— 结果把用户正在用的
壁纸切换器一起关掉了（8 个进程）。

**按路径过滤只能区分「哪个项目」，区分不了「同一项目的哪个实例」。**
要关自己起的实例，必须**按 PID 关它那棵树**（先子后父，子进程要递归收齐）。
已用同样方式把用户实例重新拉起（`resumeLast` 会接着上次那张继续播）。

---

## 第二十二轮续：设置面板分类标签页 + 托盘「重新启动」

### 为什么要改

设置面板塞了 **21 个字段块 / 二十来个分组**，一整条长列从头滚到尾 —— 找一个开关（比如
「开机自动启动」）要滚好几屏，且没有锚点可以跳。用户反馈「抽屉东西太多了，太杂乱」。

### 方案选择（用户拍板）

| 选项 | 结论 |
|---|---|
| 结构：分类标签页 / 手风琴折叠 / 搜索过滤 / 分组标题+锚点 | **分类标签页** —— 一次只显示一组，不用反复展开收起，也不需要用户先想好关键词 |
| 状态：记住上次那一页 / 每次都从第一页开始 | **记住上次那一页** —— 用户调设置往往连着好几项都在同一类里 |

### 设计决定

| 决定 | 理由 |
|---|---|
| **四类：轮播 / 外观 / 操作 / 系统** | 按「改它是为了什么」分，不是按字段类型分；<br>用户 90% 的动线落在「轮播」（选相簿、调间隔） |
| **整页 `hidden`，不是滚动定位** | 隐藏的控件不该被 Tab 键走到；只用 CSS 藏起来的话键盘还能聚焦进去 |
| **标签栏 + 底栏不跟着内容滚** | 原来 `.settings` 整块滚动，滚到底就看不见分类了；<br>改成内容区 `.settings-body` 自己滚（`min-height:0` 不能少，<br>否则 flex 子项不肯缩到容器高度以内，滚动条出不来） |
| **每屏模式下统一项照旧隐藏** | 过渡动画 / 填充这些在显示器卡片「更多设置」里逐屏设，<br>标签页不额外画一份 —— 模式规则（`unified-only` / `per-monitor-only`）优先级不变 |
| **切页不重建频道** | `config:set` 走到 `applyConfigChange` 会 `scheduler.rebuild()`；<br>为纯界面状态重扫一遍相簿、重排定时器是白干活。<br>新增 `UI_ONLY_KEYS = ['settingsTab']`，**patch 全部由这些键组成时只写盘不重建** |
| **值不认识就退回第一页** | 手改 config.json / 老版本残留值不该把面板点成空白；`clampSettingsTab` 兜底 |
| **`settingsTab` 不进 `PROFILE_KEYS`** | 它是全局界面状态，不该被每屏覆盖表继承 |

### 改动

- `src/store.js`：`SETTINGS_TABS = ['play','look','action','system']`、`DEFAULTS.settingsTab`、
  `clampSettingsTab()` + `normalizeConfig` 收紧
- `src/main.js`：`UI_ONLY_KEYS` 短路；托盘与窗口「文件」菜单加「重新启动」（`restartApp()`：
  `app.relaunch({args})` + `app.quit()`，保留 `--hidden` 等参数并走完整退出流程）
- `src/tray.js`：菜单加「重新启动」，拿不到 `restart` 时降级为「退出」
- `src/renderer/index.html`：21 个字段块重排进四个 `.settings-pane`；新增标签栏与 `.settings-body`
- `src/renderer/style.css`：标签栏样式、`.settings-body` 滚动区、`.settings-pane[hidden]`
- `src/renderer/app.js`：`selectSettingsTab()` / `persistSettingsTab()`、标签点击绑定、
  `applyConfigToUI` 恢复上次那一页、「快捷文件夹」跳转先翻到「操作」页再滚

### 验证

| 层次 | 结果 |
|---|---|
| 单元测试 | **153/153**（新增 §28 共 10 条：默认值、id 顺序、四个 id 都能存、<br>拼错 / 空串 / null / 数字一律退回第一页、落盘再读仍是上次那一页、改完再读一致） |
| 静态接线检查 | **37/37**（`tools/tmp/check-settings-tabs.js`，一次性）：标签↔内容页一一对应、<br>21 个块无遗漏、每页非空、代表项归属、**app.js 里 97 个 `$('id')` 全部还在 HTML 中**、<br>无重复 id、CSS 规则齐全、主进程 UI_ONLY 短路在位 |
| ⚠️ 真机 CDP | **未做** —— 本次会话 Electron 起不来（连最小 app 都秒退，与项目代码无关），<br>标签页的实际观感与滚动手感待用户实测 |

> 静态检查当场抓到一个真 bug：`.settings-body` 只有 class 没有 id，`els.settingsBody` 取到 `null`
> （切页滚回顶部的那一行会静默失效）—— 已补 `id="settings-body"`。

---

## 第二十二轮：定时自动扫描相簿（间隔可调）

### 为什么要它

扫描缓存只在「手动重新扫描 / 目录内容被程序改动」时失效，所以**外部往目录里丢新图**
（Syncthing 同步、ComfyUI 出图、手动拷进去）程序自己是不知道的 —— 不重扫就永远播不到。
定时扫描就是补这一段：按固定间隔再扫一次相簿目录。

### 设计决定

| 决定 | 理由 |
|---|---|
| **只丢扫描缓存，不洗牌** | 手动「重新扫描」= 用户要重来一遍，会连播放顺序一起洗；<br>自动扫描是后台静默发生的，把正在看的顺序搅乱只会让人莫名其妙。<br>只清缓存的效果：新图接在列表末尾（`_orderFor` 既定行为）、已删的图自然消失 |
| **按路径找回当前帧** | progress 存的是序号，列表前面少一张图时序号整体前移 ——<br>实测：播到第 2 张时第 1 张被删，画面凭空跳到第 3 张。<br>所以扫描后按**路径**把当前帧找回去（单测 §27 专门盯这条） |
| **定时器挂在 `rebuild` 末尾** | 改配置、切模式、插拔显示器、手动重扫最后都落到 rebuild，<br>于是不管哪条路径改的间隔都立刻重新计时，不用每个调用点记得刷一次 |
| **定时器 unref** | 进程存活不该由它决定（主进程靠窗口 / 托盘），单测里没 stop 也能干净收尾；<br>到点照旧开火 |
| **最小 1 分钟、上限 24 小时** | 相簿动辄上万张，扫一次要走一遍目录树；图库本就在 Syncthing 目录里，<br>太频繁就变成后台常驻的磁盘压力 |
| **0 = 关闭（默认）** | 新装用户不该被一个默默跑的定时任务惊到，需要时自己开 |

### 改动

- `src/store.js`：`autoScanMinutes`（分钟，默认 0）+ `clampAutoScanMinutes`（0 / 1–1440），
  `normalizeConfig` 里收紧
- `src/scheduler.js`：`_armAutoScan()`（按配置武装定时器）、`autoScan()`（清缓存 + 重建 + 按路径复位当前帧）、
  `stop()` 清理；`lastAutoScanAt` 记录上次扫描时刻
- `src/renderer`：设置面板「自动扫描相簿」下拉（关闭 / 5 / 15 / 30 分钟 / 1 / 3 / 12 小时），
  说明行显示当前档位与「上次扫描 hh:mm:ss」
- `src/main.js`：`channels:list` 与 `channelBroadcast` 带上 `lastAutoScanAt`

### 验证

| 层次 | 结果 |
|---|---|
| 单元测试 | **143/143**（新增 §27 共 15 条：默认不装定时器、配置收紧三档、开定时、<br>扫到新图、删掉的图消失、当前帧不动、顺序不洗牌、新图接末尾、<br>记录时刻、广播渲染层、定时器真的开火、stop 后清空） |
| 静态接线检查 | 24/24（`tools/tmp/check-autoscan-wiring.js`，一次性） |
| ⚠️ 真机 CDP | **未做** —— 本次会话 Electron 起不来（连最小 app 都秒退，与项目代码无关），<br>下拉与说明行的实际观感待用户实测 |

## 第二十一轮：失效图片不再卡住轮播（写前预检 + 就地摘除 + 立即补张）

### 现象

图片被外部删掉（资源管理器、Syncthing 同步删除）后，轮播切到它时会**卡一拍**：
桌面停在上一张不动，渲染层弹一条「写入失败：文件不存在」，卡片状态区挂着红字，
而且这条已失效的路径**还留在播放列表里**，一轮之内还会再踩到几次。

还有一类更隐蔽的同源问题：文件还在但读不出来（Syncthing 半同步、损坏、
webp/avif 解码失败）时，`ensureNativeFormat` 兜底返回**原路径**（Windows 根本
不认识的格式）→ `SystemParametersInfoW` 返回成功 → **假成功**：桌面黑一下或纹丝不动，
却没有任何错误提示。用户看到的就是「这张壁纸加载不出来」。

### 修法（用户拍板的四个取舍）

| 取舍 | 选择 |
|---|---|
| 失效帧怎么处理 | 静默跳过、立即补一张（不给用户看到死帧） |
| 什么时候发现 | 切换时探测（`fs.existsSync`，微秒级，零额外开销） |
| 怎么提示 | 聚合提示，不逐张刷屏 |
| 存在但读不出来 | 本轮跳过、不摘除，重扫/重启后再试 |

实现（`src/scheduler.js`）：

1. **`_seekLiveEntry`**：写前找出一张真正可用的图 —— 已不存在的条目**就地摘除**
   （复用 `applyFileMutation` 那条经过验证的删除链路：索引对齐 / `rev++` /
   作废该目录扫描缓存 / 通知渲染层），已判定读不出的条目跳过；
2. **`_write` 重试循环**：一次切换最多试 4 张，直到有一张能写成功 ——
   桌面永远不会停在一张死图上；
3. **失败分类**：`文件不存在`（含预检后的竞态）→ 摘除；其余（解码/转码失败）→
   记进 `ch.badFiles`，本次会话不再尝试它，但**留在列表里**；
4. **大面积失效保护**：一次切换摘掉 ≥12 张 → 说明列表整体过期，异步对该频道
   `rescan` 拿真实列表（带 60s 冷却），而不是逐张试错；
5. **聚合提示**：`tick` 载荷带 `skipped: {dropped, bad, total}`，渲染层合成一条
   「已跳过 N 张失效图片（N 张已被删除，N 张读不出来）」。

`src/win32.js`：`ensureNativeFormat` 对解码不出来的图不再返回原路径冒充成功 ——
GIF/TIFF 这类系统可能认识的仍交给系统碰运气，webp/avif 这类明确抛错，
让调度器把它当作「读不出来」处理（见上）。

### 一个踩到的坑

`toast` 只有一个 DOM 槽位，**后一条会顶掉前一条**：一开始聚合提示和写入失败提示
分两条发，结果跳过信息瞬间被覆盖、永远看不见。改成两者合并进同一条消息。

### 验证

| 层次 | 结果 |
|---|---|
| 单元测试 | `verify:unit` **128/128**（新增 §24/25/26 共 17 条：删除跳过、坏图跳过、大面积失效触发重扫） |
| 真机（隔离实例 + CDP） | **11/11**：删除图 → 不写它、补写下一张、列表减一、`rev++`、聚合提示、零红色错误；坏图 → `ok:false + 无法解码`（不再假成功）、不摘除、标记为「读不出来」 |
| 桌面安全 | 测试 A 走预览模式（`applyToSystem:false`）；测试 B 素材全是坏图，写入必然在触碰桌面之前失败 |

## 第二十轮续（QA 反馈续）：预览菜单左对齐；轮播间隔预设；选目录记忆上次路径

### 3. 选目录对话框不记忆上次选择

**现象**：相簿页「添加目录」每次打开都落在系统默认位置；顶栏「添加目录」虽定位到
当前相簿的第一个目录，但那不是用户上次选的地方。

**修复**：加「上次选择的目录」记忆 —— 选完目录后把路径写进 userData 下的
`last-pick.json`（独立小文件，不进带 schema 的 config.json —— 纯 UI 便利状态）；
两个选目录框（`folder:pick` / `album:pick-dirs`）打开时用它做 `defaultPath`，
选中后回写。目录已不存在（盘被拔了）时静默失效回退默认位置。

### 1. 预览切换菜单改左对齐

第二十轮把菜单挂到了「预览」徽章上（右缘对齐右缘），用户实测觉得还是别扭：
**菜单应与徽章左对齐**（菜单比徽章窄，右对齐时左缘悬空没参照物）。
`.preview-menu` 的 `right: 0` 改 `left: 0`。验证：menuLeft 789 vs badgeLeft 788。

### 2. 轮播间隔快捷预设

滑条拖到 1800 秒要拖半天。间隔滑条下加一排胶囊预设：**30 秒 / 1 分钟 / 5 分钟 / 30 分钟**
（设置面板统一模式 + 每屏卡片各一组）。点 chip 落值后走滑条同款 `change` 保存路径，
与当前间隔一致的 chip 高亮；顺带把间隔文案统一成 `formatInterval`
（≥60 秒显示分钟，不再出现「3600 秒」这种反人类读数）。

## 第二十轮：新用户实测反馈三连 —— 相簿空窗 / 顶栏词汇打架 / 菜单没对齐

### 1. 「设置时好时坏，弹窗里全是未选择相簿」

**根因是渲染时序，不是数据**：频道推送（渲染卡片、顶栏相簿状态）早于相簿列表就位
（init 里 `refreshChannelInfo` → `refreshAlbums`），而 `refreshAlbums` 加载完不回头重渲染
已画好的占位 —— 每次启动 / reload 后的头几秒，所有相簿下拉、顶栏状态都停留在
「未选择相簿」，等下一次频道推送（最长一个轮播间隔）才自愈。观察者日志全程零异常，
纯属「画早了、没人补画」。

修复：`refreshAlbums()` 末尾补 `renderCards()` + `updateBadges()` —— 相簿集合一变，
凡引用它的界面全部重画。验证：reload 后 2.5s，顶栏与两块屏卡片均已显示「ai图 · 2/2 目录」。

### 2. 顶栏「选择文件夹 vs 未选择相簿」词汇打架

同一行里按钮说文件夹、状态说相簿，而按钮的实际行为是「把目录加进当前相簿」。
用户拍板：**按钮改名对齐相簿语义** —— 顶栏「选择文件夹」→「添加目录」、
空态「还没有壁纸文件夹 / 选择壁纸文件夹」→「还没有图片目录 / 选择图片目录」、
托盘「选择壁纸文件夹…」→「添加图片目录…」、选中后的提示改为「已把「xxx」加入相簿」。

### 3. 预览切换菜单没对齐

菜单挂在整组按钮的容器上（`right:0` 对齐到组右缘），从「壁纸通道 / 相簿 / 设置」那边
冒出来，和「预览」徽章对不上。改为挂在徽章自身（`#preview-badge` 加 `position:relative`），
右缘严格对齐徽章；菜单行名称列加 `flex:1` + 溢出省略，两行的「N 张 · Ns」数值列
右对齐成一条竖线。验证：menuRight = badgeRight = 985，截图确认。

## 第十九轮：新用户实测揪出首跑竞态 —— 预览空态永久搁浅


用户以全新档案实测（QA 实例），首跑选完目录后界面卡在「还没有壁纸文件夹」，再选目录也无反应。

### 现场取证（CDP 探针）

- 主进程完全正常：两块屏都绑定了刚建的相簿，`playback.json` 一直在推进（已经在播第 6 张）；
  直接在渲染层调 `channelFiles` —— **3865 张图、21ms 返回、无错误**。
- 但渲染层 `state.loadedSignature === 'none'`：**加载从未被套用过**，`loadingChain` 也没卡。
- `Page.reload` 后一切正常 → 排除逻辑错误，定性为**一次性时序竞态**。

### 根因

`doLoadPreviewChannel` 的防过期机制：取文件期间签名（`id|albumId|albumSig|recursive|shuffle|rounds|count|rev`）变了就丢弃结果，
依赖「改变签名的那次 channels 推送会触发 applyChannelInfo 末尾的补载」来兜底。首跑选目录恰好集齐了所有要素：

1. `folder:pick` 建相簿 → 自动开每屏 → **重建①**（count 0）→ 目录入簿 → **重建②**（count 3865）；
2. 首次 fetch 是**冷扫描**（3865 张，秒级），足够两次推送都落在窗口内；
3. 最后一次丢弃之后推送恰好停了 —— 没有任何触发再来一次，空态永久搁浅。

### 修复

丢弃时不再静默返回，挂一个 300ms 去抖的**补载定时器**（`schedulePreviewRetry`）：
触发时若签名仍与已加载不符就重新加载。取列表是缓存命中（毫秒级），最多多一次取列表的开销，
换来「最后一次触发丢失」这一整类竞态的自愈。

### 验证

- 搅动实验：快速来回切统一/每屏 4 次（每次重建+推送），终态 files 3875、空态隐藏、模式归位；
- 定点验证：人为伪造 `loadedSignature` 失配 → 定时器开火 → 签名恢复、列表完好；
- `Page.reload` 热加载修复后，运行中的 QA 实例当场恢复正常。



用户需求：**目前查看图片是以文件夹为单位的，想以相簿为单位——项目可以自由增加或删去多个不同的图片目录，进行自由组合。**

### 数据模型

频道不再绑目录，改绑相簿。相簿是全局实体，频道通过 `albumId` 引用：

```jsonc
"albums": [
  { "id": "alb_XXXX", "name": "横屏精选",
    "folders": [ { "path": "D:\\壁纸\\横屏", "enabled": true },
                 { "path": "D:\\壁纸\\风景", "enabled": false } ] }
],
"albumId": "alb_XXXX",           // 顶层默认相簿
"monitors": { "\\\\?\\DISPLAY#...": { "albumId": "alb_YYYY" } }   // 单屏覆盖
```

四个设计决策（与用户逐项确认过）：

| 决策 | 选择 | 理由 |
|---|---|---|
| 播放顺序 | 目录顺序即播放顺序 | 顺序模式下相簿有「章节感」：目录按列表顺序依次播，组内按名称排；随机模式拼好再整池洗，不受影响 |
| 目录粒度控制 | 开关 + 排序 | 每个目录可临时停用（保留但不扫描）、可上下移；「临时不想看某个目录」不需要删了再加回来 |
| 旧配置 | 自动包装成相簿 | `folder` 字段在读取/写入时自动换成「同名单目录相簿 + albumId 引用」，用户无感升级 |
| 增值项 | 封面缩略图 + 胶片条目录分隔 + 信息面板来源 | 三个都要 |

### 关键实现

- **store.js**：`albums` 规范化（路径大小写不敏感去重、坏条目剔除）、`findAlbum`、
  `migrateLegacyFolders`（旧 `folder` 字段 → 复用或新建单目录相簿，幂等，顶层与单屏覆盖都处理）。
- **scheduler.js**：`_scanAlbum` 按目录顺序并行扫描再拼接；**完整路径去重**（同时加 `D:\图` 和
  `D:\图\子目录` 时同一张图只收一次）；失效目录不炸相簿，标注进 `missingDirs` 给设置面板警告。
  每个条目带 `dir` 来源字段（胶片条分隔与信息面板「来源」用，调度逻辑本身不依赖）。
- **顺序复用**（`_orderFor`）本来就以 albumId 为键：**往相簿里加目录不会重洗**——现有路径原位保留，
  新目录的图接在末尾，正在看的那张不跳。换绑相簿、切播放顺序、重新扫描才重洗。
- **播放进度**：存档记录新增 `album` 字段；旧记录（只有 `folder`）按「路径在相簿内」认亲，
  升级后接着上次那张播。
- **main.js**：`folder:pick` 重写为多选目录（一次勾选多个目录，自动组建相簿）；
  新增 `album:list/create/update/delete/pick-dirs` 与 `folders:pick` 多选。删除相簿时自动解绑所有频道。
- **渲染层**：相簿管理独立成**整页**（顶栏「相簿」进入，Esc / 返回 / 点空隙退出；
  设置面板已塞了十几个字段，目录列表、排序、停用开关挤在里面放不开也难找）——
  新建 / 重命名 / 增删目录 / 停用 / 排序 / 删除都在这页里做；设置里只留每屏卡片的相簿下拉
  和统一模式的相簿选择（绑定动作，不是管理）。**统一模式原来的「添加目录…」按钮一并拆掉**
  （相簿页每张卡片本就有同款，留两个入口只会挤）；每屏卡片保留「添加目录」快捷入口
  （`folder:pick` 语义：这块屏还没相簿时选目录即自动建一个并绑上）；
  相簿下拉带封面缩略图（取自扫描缓存，零额外 IO）；
  顺序模式下胶片条在目录交界处画分隔线；信息面板新增「来源」一组。

### 兼容层（这轮踩到的坑）

e2e 验证脚本和 `tools/status.js` 还在用旧的 `folder` 语义，直接改数据模型会大面积误报。
处理分两层，而不是回头改数据模型：

1. `set()` / `setMonitorProfile()` 的兜底迁移：旧脚本发 `setConfig({ folder })` 或
   `set-profile { folder }` 时自动换算成相簿引用——**相簿列表非空时也换**（初版只在空表时迁移，
   恢复过基线的脚本会静默丢载荷，实测抓出来的）。
2. `resolveProfile` 派生只读 `folder`：绑定单目录相簿时回填目录路径，多目录相簿留空。
   `status.js` 显示与旧断言继续可用，配置存储不受影响（`writeProfile` 只按 `PROFILE_KEYS` 落盘）。

### 验证

| 组 | 结果 |
|---|---|
| 单测 `npm run verify:unit`（新增 19-23 节：多目录拼接/去重/停用/失效目录、加目录不打断播放、旧配置迁移、旧进度认亲、兼容层） | **111/111** |
| `npm run verify:resume`（模拟关机再开机） | **28/28** 无回归 |
| `npm run verify:order`（真实 app + CDP，隔离 userData） | **25/25** 无回归 |
| `node --check` 全部改动源文件 | 通过 |
| store.js 迁移独立冒烟（node -e 断言） | 通过 |

**CDP 实例跑法备注**：真实实例正在运行时占着单实例锁，调试实例会静默秒退（`app.exit(0)`）。
绕法：`electron.exe . --remote-debugging-port=9222 --user-data-dir=<隔离目录>` 起隔离实例，
脚本侧设同样的 `APPDATA` 对齐 testConfig 的配置路径，两端落在同一个隔离档案里——不碰用户真实配置，
也不需要关掉正在轮播的真身。跑完用 CDP `Browser.close` 收掉。

**遗留**：`verify:features` / `verify:ui` / `verify:fixes` / `verify:tray` / `verify:cycle` 里还有
直接读 `cfg.folder` 的断言（需要逐条改成相簿语义，属于下一轮 UI 迭代一起做的事）；
`verify:e2e` 需要预置两屏配置并真实接管桌面，与正在运行的实例抢桌面，本轮未重跑。

---

## 每屏独立轮播（第一轮）

系统自带的「幻灯片」只有一套全局配置，做不到「A 屏放这个目录、B 屏放那个目录」。
这版把轮播拆成**频道**：一路频道 = 一路独立轮播，各持有自己的图片列表、索引、随机序列和定时器。

![每屏独立配置界面](docs/界面-每屏独立.png)

（截图由 `npm run shot:readme` 生成，会自动清空图层再截，避免把壁纸内容带进图里。）

```
                     ┌─ 频道「显示器 1」  每 60 秒 ─► SetWallpaper(屏1, 图)
主进程调度器 ────────┤
（scheduler.js）      └─ 频道「显示器 2」  每 180 秒 ─► SetWallpaper(屏2, 图)
       │
       └─ channel:tick ──► 渲染进程：只把被预览的那一路画出来（带过渡动画）
```

### 为什么调度器必须搬到主进程

上一版渲染进程自己数秒、自己推进、自己写壁纸 —— **一个窗口只有一条时间线**，
物理上不可能同时跑「30 秒」和「5 分钟」两种节奏。
现在渲染进程退化成一台监视器，于是：

- 每块屏的节奏互不干扰；
- 窗口最小化 / 被挡住也不影响桌面切换；
- 预览哪一路由用户点选（卡片右上角眼睛图标），和实际写入解耦。

### 配置模型：默认值 + 单屏覆盖

```jsonc
{
  "folder": "D:\\壁纸\\横屏",     // ← 默认值，所有屏共用
  "interval": 60,
  "perMonitor": true,                // 打开每屏独立模式
  "monitors": {
    "\\\\?\\DISPLAY#BBBB5678#…#{…}": { // ← 只写与默认值不同的项
      "folder": "D:\\壁纸\\竖屏",
      "interval": 180
    }
  }
}
```

- 单屏只落盘**差异项**：以后改默认值能一次性带动所有没单独设过的屏；
- 单屏可以设 `"enabled": false` 让程序不管它（那块屏保持原样，不写壁纸）；
- 总开关 `applyToSystem` 仍然是一票否决，关掉后全部只预览不落桌面。

### 实现要点（COM 部分）

`koffi` 没有 COM 封装，所以**手工做 vtable 分发**：
接口指针 → 解引用拿 vtable → 按槽位偏移取函数指针 → `koffi.call` 调用。

`IDesktopWallpaper` 的 vtable 布局（`IUnknown` 占 0–2）：

| 槽 | 方法 | 槽 | 方法 |
|---|---|---|---|
| 0 | QueryInterface | 4 | GetWallpaper |
| 1 | AddRef | 5 | GetMonitorDevicePathAt |
| 2 | Release | 6 | GetMonitorDevicePathCount |
| 3 | **SetWallpaper** | 7 | GetMonitorRECT |

踩到的四个坑，都写进代码注释了：

1. **`CLSCTX_ALL` 不能省。** 这台机器上 `IDesktopWallpaper` 是 LocalServer 注册，
   只用 `CLSCTX_INPROC_SERVER` 会返回 `0x80040154 REGDB_E_CLASSNOTREG`。
2. **vtable 索引错一位就是从「读」变「写」。** 第 3 槽是 `SetWallpaper`，
   所以模块启动时先用槽 0 做 `QueryInterface(IID_IDesktopWallpaper)`，
   确认返回同一个指针才继续；不通过就整体禁用该功能。
3. **`koffi.func(definition)` 里的函数名会被当成 DLL 导出符号去查。**
   不能像 `koffi.proto` 那样随便起名 —— 写 `WpMonitorFromWindow` 会静默查不到符号。
4. **`CoTaskMem` 字符串取一次就要释放一次**，且不能再拿那个裸指针去调别的接口。

### 一个必须说清楚的边界

**桌面上的切换是瞬间完成的，没有过渡动画。**
Windows 的壁纸接口就是「换一张图」，没有可用的交叉淡入。
滑动 / 淡入 / 缩放三种过渡只作用于**本程序的预览窗口**。
（原 Python 版是靠不断写入混合后的中间帧来伪造动画，代价是主线程实时重采样，
4K 图上直接掉帧 —— 不值得沿用。）

### 与旧版 Python 切换器的冲突

原版每次切换都调 `SPI_SETDESKWALLPAPER` —— 那是**全局单槽位** API，
一旦触发就会把所有屏幕的每屏设置抹平成同一张图。
两个程序同时跑会互相覆盖。另外它也会把 Windows 自带的「幻灯片」模式顶掉。

## 项目结构

```
src/
  main.js              主进程：窗口、菜单、IPC、统一模式的目标解析、右键菜单
  scheduler.js         多频道轮播调度器（每屏一路，独立定时器）
  preload.js           contextIsolation 下的白名单桥
  win32.js             壁纸写入：优先 COM，SPI 仅兜底
  desktopWallpaper.js  IDesktopWallpaper COM 手工 vtable 分发
  scanner.js           目录遍历 + Collator 排序
  imageSize.js         图片头部解析（不解码像素就能拿到分辨率）
  exif.js              完整图片信息（exifr），分组 + 枚举值可读化
  thumbnails.js        缩略图生成 + wpthumb:// 自定义协议 + 磁盘缓存
  fileActions.js       复制 / 移动 / 删除到回收站 / 外部打开
  clipboardWin.js      koffi 直写 CF_HDROP（Electron 44 的 clipboard 写不了文件）
  tray.js              托盘图标 + 菜单 + 开机自启
  store.js             配置持久化（默认值 + 单屏覆盖，原子写）
  renderer/
    index.html         双图层舞台 + HUD + 胶片条 + 信息面板 + 设置面板
    style.css          只动 transform / opacity 的动画
    app.js             频道预览器：被 tick 驱动画过渡，不自己数秒；胶片条窗口化渲染
assets/icon.ico
tools/
  test-scheduler.js      调度器单测（注入假写入函数，不碰真实桌面）
  verify-per-monitor.js   每屏独立端到端验证（应用侧 CDP + 操作系统侧回读）
  verify-new-features.js  四个新功能端到端验证（106 项）
  verify-fixes.js         第五轮四项修复的验证（29 项，含确定性重复图夹具）
  verify-ui-fixes.js      第六轮交互修复的验证（36 项，含原生确认框的完整驱动）
  verify-shuffle-order.js 随机顺序端到端（24 项，盯「序号连续」与胶片条排列）
  simulate-random.js      两种随机策略的长跑对比（纯计算）
  dialogDriver.js         原生模态对话框驱动（koffi + user32，按 pid 锁定自己的窗口）
  testConfig.js           测试期配置基线快照（防「中途崩溃污染下一轮」）
  locate-annotation.js    定位截图里标注的红框位置
  repro-filmstrip-dup.js  胶片条窗口同步的压力复现（随机大跳 + 小步 + 贴边折返）
  find-duplicates.js      找内容完全相同的重复图（体积分组 → 候选做 SHA-256）
  clipboardReader.js      真实剪贴板格式回读（koffi + user32）
  recycleBin.js           回收站条目数回读（koffi + SHQueryRecycleBinW）
  registryReader.js       HKCU\...\Run 回读（koffi + advapi32）
  screenshot-new-features.js 抓新功能截图（自动绕开真实壁纸库）
  make-exif-fixture.js    合成带完整 EXIF（含 GPS）的 JPEG 测试样本
  status.js            状态速览（每屏挂什么 + 频道在干什么）
  capture-app/         抓屏小应用（必须是「目录 + package.json」才能拿到 electron 内置模块）
  restore-wallpaper.js 壁纸还原
  make-fixtures.js     生成纯色 BMP 与渐变 PNG 测试图
```

## 架构对照

原来一个类吃掉全部职责、跑在唯一主线程；现在按进程边界拆开：

| 职责 | Python / Tkinter | Electron |
|---|---|---|
| UI 渲染 | 主线程软渲染，无 GPU 无垂直同步 | 独立渲染进程 + Chromium 合成器 |
| 图片解码 | Pillow 同步解码，阻塞 UI | Blink 图像解码线程池，异步 |
| 图片缩放 | LANCZOS 全尺寸重采样（几十~几百 ms/张） | `object-fit: cover`，Skia 原生缩放 |
| 过渡动画 | `after()` 逐帧改 `place(relx=)` + `update_idletasks()` | `transform` / `opacity`，合成器线程 |
| 双缓冲 | 3 个 Label 常驻 3 张全屏位图 | 2 个合成层交替 |
| 全局壁纸 | `ctypes.windll.user32` | `koffi` FFI 调同一函数 |
| **每屏壁纸** | 无（只能 PIL 拼一张跨屏大图） | `IDesktopWallpaper` COM，真正的 per-monitor |
| **每屏独立节奏** | 无（单线程单时间线） | 主进程多频道调度器，N 条独立时间线 |
| 迁移/配置 | 手写数百行 `_normalize` / `_migrate` | `deepMerge` 一次搞定 |
| 并发 | GIL 锁死，线程无用 | 多进程 + 多线程真实并行 |

## 实测数据

在你的机器上（双屏：3840×2160 主 + 1600×2560 副）实测：

| 指标 | 结果 |
|---|---|
| **调度器逻辑单测** | **59 / 59 通过** |
| **第六轮交互修复验证** | **36 / 36 通过** |
| **每屏独立端到端验证** | **40 / 40 通过** |
| **新功能端到端验证** | **106 / 106 通过** |
| **第五轮修复验证** | **29 / 29 通过** |
| **第七轮随机顺序验证** | **24 / 24 通过** |
| 全库重复图扫描（30348 张 / 116 GB） | 冷跑 38 s、热跑 3.3 s（只对同体积候选做哈希） |
| 扫描 30348 张（含递归 + URL 转换） | 309 ms（176 ms 纯扫描） |
| 扫描 21807 张 | 106 ms |
| 过渡动画帧率（slide / fade / zoom） | 144.8 / 145.2 / 145.2 fps（等于刷新率，零丢帧） |
| 双屏独立节奏实测 | 3 秒频道走 3 步 / 8 秒频道走 1 步，比值 3.0 : 1 |
| 显示器枚举 + 逐屏回读当前壁纸 | < 20 ms |
| 主进程内存 | 173 MB |
| Electron 运行时 | 368 MB（`electron.exe` 单文件 235 MB） |

### 每屏独立的验证方式（两条独立证据链）

`tools/verify-per-monitor.js` 不信任应用自己的说法，而是同时看两处：

| 来源 | 拿什么 |
|---|---|
| 应用侧（CDP 直连渲染进程） | 应用认为有几路频道、各自目录、累计推进次数 |
| 操作系统侧（另开一份 `IDesktopWallpaper` 回读） | Windows 认为每块屏现在挂的是哪个文件 |

关键结果：

```
起始 ticks=[3,1]  索引=[0,1]
8s 后 ticks=[6,2]  增量=[3,1]      ← 3 秒频道走 3 步，8 秒频道走 1 步

OS 采样：#1 ~ #4   [0] a-2-red     [1] b-2-green
         #5 ~ #8   [0] a-3-red     [1] b-1-green      ← 两块屏各走各的，从未串台
         #9 ~ #11  [0] a-1-red     [1] b-1-green
```

像素级复核（抓两块屏的实际画面）：主屏背景**红**（dirA 的内容）、副屏**绿**（dirB 的内容），
同一时刻两块屏显示的确实是不同来源的图片。

另外还覆盖了：暂停一路另一路照常、改一路配置另一路不受影响、
配置里只落盘差异项、`enabled: false` 时切图也不动桌面、切换预览目标后画面与徽标同步。

### 移植过程中修掉的真实性能问题

1. **排序用了逐次 `localeCompare`** —— 十万张规模下每次比较都重建 Collator。
   改成模块级 `Intl.Collator` 常量后，`涩涩涩涩涩`（21807 张）从 868 ms 降到 106 ms。
2. **扫描上限是软限制** —— 原实现在外层循环判上限，装了几万张图的大目录会突破。
   改成内外层都判，并返回 `truncated` 标记在界面上提示。
3. **`koffi.func` 的静默符号查找失败** —— 导致「窗口所在显示器」永远返回 null 且不报错。
4. **`takeString` 之后的 use-after-free** —— 指针已释放又被拿去调 `GetMonitorRECT`，二次释放。

### 顺手发现的原版 bug（Python 端）

原 `wallpaper_change.py` 里配置项 `animation.duration` 和 `animation.steps`
**实际是失效的**：104–105 行从配置读入，144–146 行又被硬编码 `500` / `20` 覆盖。

### Electron 44 里三个「文档没说、实测才知道」的坑

这一轮踩到的三个坑都写进了对应模块的注释里，这里汇总一下，免得以后有人再花一晚：

**① 主进程的 `clipboard` 换成了 W3C 异步风格。**
`writeImage` / `writeBuffer` / `readImage` / `availableFormats` 全部消失，只剩
`clear / has / read / readText / write / writeText`，且都返回 Promise。
其中：

| 想做的事 | 能不能做 | 正确写法 |
|---|---|---|
| 复制图片像素 | ✅ | `clipboard.write([new ClipboardItem({ 'image/png': Blob })])`，Chromium 会自动转出 CF_DIBV5 / CF_BITMAP / CF_DIB |
| 复制文本 | ✅ | `clipboard.writeText()`（同时写 CF_UNICODETEXT / CF_TEXT） |
| 复制文件（资源管理器可粘贴） | ❌ | 见 ② |

**② 用 `CF_HDROP` 这个名字去 `clipboard.write()` 是假的。**
Electron 会 `RegisterClipboardFormat("CF_HDROP")` 注册一个**同名自定义格式**——
实测 id 是 `0xc323`，而资源管理器认的是系统标准 `CF_HDROP`（**id 15**）。
`EnumClipboardFormats` 能看到它、`IsClipboardFormatAvailable(15)` 却是 `false`，
只看前者会以为成功了。所以 `src/clipboardWin.js` 用 koffi 直接走
`EmptyClipboard → GlobalAlloc → 填 DROPFILES → SetClipboardData(15)`。

**③ `shell.trashItem` 会假失败。**
文件明明已经进了回收站，Promise 却以 `Operation was aborted`（E_ABORT）reject。
如果照实报失败，上层就不会更新轮播列表 —— 用户看到的是「删不掉」，
而列表里还留着一张已经不存在的图。`fileActions.trash` 现在以磁盘事实为准：
报错之后再 `fs.existsSync`，文件真的没了就算成功。

另外两处 API 现实：

- **`app.getLoginItemSettings().openAtLogin` 在 Windows 上恒为 `false`**，
  要看 `executableWillLaunchAtLogin`（见「托盘图标 + 开机自启」）。
- **`nativeImage.createThumbnailFromPath` 是 Windows 上最快的缩略图路径**
  （底层 IShellItemImageFactory），但要接受冷调用 60–180 ms，所以必须缓存。

### 新功能的验证方式

`tools/verify-new-features.js`（106 项）与 `tools/verify-ui-fixes.js`（36 项）
沿用「不信应用自己说的话」的思路，
关键断言都从**系统侧**回读：

| 断言 | 回读手段 |
|---|---|
| 点了胶片条真的换了壁纸 | 另开 `IDesktopWallpaper` 读桌面当前文件 |
| 缩略图真的解出了像素 | 渲染进程里读 `img.naturalWidth`，再看 `wpthumb://` 缓存落盘数量 |
| 复制图片 / 文件真的进了系统剪贴板 | `tools/clipboardReader.js`（koffi + user32）枚举**真实**剪贴板格式，`CF_HDROP` 还要 `DragQueryFileW` 取出路径 |
| 删除是真的进回收站（可还原）而非永久删除 | `tools/recycleBin.js`（koffi + `SHQueryRecycleBinW`）对比条目数 +1 |
| 开机自启真的写了启动项 | `tools/registryReader.js`（koffi + `RegEnumValueW`）直接读 `HKCU\...\Run` |
| 移动/删除后轮播列表与磁盘一致 | 磁盘 `existsSync` + 频道 `count` / `index` / `played` 三方对齐 |

有三件事没法靠应用自己证明，所以专门绕开：
`reg.exe` 会被沙箱拦（改用 advapi32）、PowerShell 的 COM 被安全策略禁（改用 shell32）、
删除只验证「文件不见了」不够（必须证明回收站里多了一件）。

## 已验证 / 未验证

**已自动化验证：**

- 调度器：频道划分、独立推进、暂停隔离、配置继承与覆盖、接管开关、统一模式回退
- 随机顺序：列表被洗乱（没丢没多）、改间隔不打乱顺序、切「按名称」可逆、
  播放逐格推进（序号连续、上一张退回一格）、删一张后相对顺序不变、
  洗牌结果无相邻同体积（含循环接缝）、换目录清空「看过」标记
- 配置落盘：`monitors` 下只保留与默认值不同的键
- 端到端：两屏不同目录 / 不同间隔同时轮播，OS 侧回读确认全程不串台
- 写入路由：每次 `SetWallpaper` 只带自己那块屏的 `monitorID`
- 预览：切换预览目标后图片列表、HUD、徽标全部同步
- COM：`QueryInterface` vtable 校验、显示器枚举、逐屏回读当前壁纸
- 像素级：主屏红 / 副屏绿，哈希不同
- 胶片条：窗口化渲染、`wpthumb://` 真实解码、点击跳转后 OS 侧壁纸同步、
  三种状态标记、翻屏按钮只滚动不切图
- 图片信息：EXIF 21 个字段全量回读（含 GPS、曝光、枚举值映射）
- 文件操作：移动 / 复制 / 删除到回收站后，磁盘、轮播列表、索引、`played` 四方对齐；
  删除当前帧时桌面立即改挂下一张；同名不覆盖；复制不改变轮播张数
- 右键菜单：13 个菜单项齐全、全部接线、文件不存在时相关项置灰
- 托盘 / 自启：注册表启动项写入与清除、状态双向回读
- 粘贴能力：系统剪贴板里真的出现 CF_DIB / CF_UNICODETEXT / 标准 CF_HDROP(15)
- 防重护栏：确定性夹具（3 张图里两张字节相同）下，开启护栏 30 步 0 次相邻同体积，
  关闭护栏 30 步 6~11 次 —— A/B 对照证明护栏真的在起作用
- 播放顺序：历史脏值 `"random"`/`"order"` 能正确解析；UI 点击后能来回切，
  落盘恒为布尔；连续来回切 5 轮不卡死
- 设置面板删除按钮：无图时置灰且点击不弹框、文件不存在时返回结构化失败；
  带确认的删除通道已接线
- 「打开所在文件夹」：菜单里只剩一项，返回 `method: 'select'`；目录不存在时结构化失败
- 重建竞态：在途写入未收尾前不建新频道；重建后被丢弃的频道一次都没再写桌面
  （用可卡住的写入函数做成确定性时序，撤掉修复这条测试就红）
- 胶片条删除图标：每张都有、用 span 实现（无嵌套 button）、当前那张常显其余隐藏；
  **点非当前那张的图标不会冒泡成跳转**（取消后画面停在原位）
- 原生确认框全流程：点图标 → 弹出属于本应用的对话框 → 取消则文件还在、
  确认则文件进回收站且张数 -1（键从系统侧发，且按键前校验前台窗口）
- 信息面板跟随：连续切两张，面板的名称 / 缩略图 / 字段都跟着变，不卡在「读取中…」
- 点空白关闭：面板内部点不关、外部点关、开关按钮的 toggle 不被抢、
  两个面板可同时开着并被一次点空白一起关掉

**仍未覆盖：**

- 显示器热插拔时的频道重建（挂了 `display-added/removed/metrics-changed` 监听，
  但没实际插拔验证过）
- 只在 100% / 150% 缩放下测过，没有覆盖 HDR 与更多缩放组合
- 长时间运行（数小时）的内存增长曲线
- 托盘图标在系统托盘折叠区里的显示效果、气泡通知的实际观感（需要人眼确认）
- 「选择打开方式…」与「用默认程序打开」只验证了路由接通，没有真的点开对话框
- 缩略图的悬停样式（图标的淡入淡出）没法用脚本模拟 `:hover`，
  只断言了「当前那张常显 / 其余默认隐藏」，真实悬停的观感需要人眼确认
- 确认框的**正文文字**读不到：Electron 44 在 Windows 上用 TaskDialog，
  没有可读的 Static 子控件；「弹的是不是这张图的确认框」只能靠
  「确认后删掉的正是点的那一张」间接证明

## 第二十五轮：验证脚本把测试图留在了用户剪贴板里

### 现象：用户粘出来一张「不像自己的图」

用户报「只能粘贴这个？」，附了一张 1280×720 的红渐变色带图。
像素级比对（PIL：最大通道差 0、`ImageChops.difference().getbbox()` 为 `None`）
确认它与 `tools/fixtures/gallery/g-001-h0.png` **逐字节相同** —— 是本项目自己的测试夹具。

### 根因：`verify:clipboard` 必须写真剪贴板，但收尾没还原

这个脚本要验的就是「复制图像到剪贴板」，只能把测试图写进**真剪贴板**；
而它的最后一处写入（§7⑥ `copyImageWithNotice(GALLERY_PNG)`）恰好就是那张夹具。
脚本退出后，剪贴板里留的就是它。

**它同时也是「复制还没落地」的指纹**：用户当时跑的还是第二十三轮的构建
（进程启动早于第 24 轮的提交），点复制后主进程要冻 6.8 秒（见上一轮），
这期间剪贴板里仍是上一次的内容 —— 所以粘出来的必然是夹具。
夹具本身不是 bug，但它**替我们把「写入尚未生效」这件事显示出来了**。

### 修复

- `tools/clipboardReader.js` 增加 `snapshot()` / `restore()` / `describeSnapshot()` / `setUnicodeText()`：
  枚举全部格式并整块存下 HGLOBAL 类格式（`GlobalLock` + `GlobalSize` → `Buffer`），
  还原时 `GlobalAlloc` → 拷贝 → `SetClipboardData`。`CF_BITMAP` / `CF_METAFILEPICT` /
  `CF_ENHMETAFILE` 是 GDI 句柄，读不出字节，记进 `skipped` —— 不影响图片还原：
  只要 `CF_DIBV5` 还原回去，系统会自己合成 `CF_DIB` 和 `CF_BITMAP`。
- `verify-clipboard`：开跑前拍快照，结束**和崩溃路径**都还原；新增 §8 共 6 项自证
  （快照含图 + 文字、覆盖后还原回原图、`CF_DIB` / `CF_BITMAP` 仍被合成、
  文字按 `CF_UNICODETEXT` 原始字节核对）。**38 → 44 项**。
- `verify-new-features`：同样快照 + 还原 —— 它在真实右键菜单里会复制图像 / 文件。
- 新增 `tools/restart-app.py`：默认**只列出**会关掉的进程树，加 `--yes` 才按 PID 树后序关闭，
  再用用户自己的桌面 VBS 拉起。判据是「镜像路径在项目目录之下」，不再按名字或路径批量杀
  —— 这是第 14 条坑的正式解法。

### 真实大图上的数字（补上一轮的缺口）

上一轮 §7 用的是**合成纯色图**，纯色极易压缩，量出的倍率被严重低估（约 2.3×）。
拿用户壁纸库里真实的图重测（复现脚本 `tools/verify-real-copy.js`，同样会快照 + 还原剪贴板）：

| 真实文件 | 像素 | 新代码（自动） | 强制快路 | 强制老路（旧行为） | 倍率 |
|---|---|---|---|---|---|
| deyui 10000×6667 PNG | 66.7 MP（254 MiB 载荷） | **1012–1044 ms** | 973–1166 ms | 6044–6209 ms | **≈6×** |
| deyui 9500×6531 JPEG | 62.0 MP（237 MiB 载荷） | **715 ms** | 741–773 ms | 6004–6543 ms | **≈8–9×** |

（多次运行有 ±10% 抖动，所以写成区间。复现：`python tools/run-electron.py tools/verify-real-copy.js <图片> [<图片> ...]`。）

`copyImageWithNotice` 的提示在这两张上分别发生在 **5 ms / 0 ms**，确实在冻结之前。

另外顺手核了一遍库存分布 —— 这次用 PIL，而不是手写的 JPEG 头解析器：
后者会把个位数 MP 的图报成 3000+ MP（上一轮那个「最大 3397 MP」就是它误报的），
用 PIL 复算的 p50 / p90 / p99 / max 与上一轮一致，结论不受影响：
12,723 张里 p50 = 4.7 MP、p90 = 11.7 MP、p99 = 34.8 MP、max = 66.7 MP，
**超过 12 MP 阈值的只有 998 张（7.8%）**。

## 第三十八轮：桌面上的雨与樱花（粒子系统）

### 现象：动态桌面缺一层「活」的点缀

用户拍板（交接文档 11.7 #9）：要雨落 / 樱花落 —— 独立 canvas 粒子图层，盖在图片层之上、
交互层之下；接现有 rAF tick + stage:pause 暂停体系；粒子数/种类可配（profile 键）；
默认保守 200~300 粒；Ken Burns 缩放不带动粒子。

### 设计决定

- **落点在舞台窗口（stage.html），不进预览窗口**：动态桌面特效（kenBurns / breath /
  timeOfDay）全部只活在舞台，粒子同类。预览窗没有 rAF，不为它单开一条动画链路。
- **层级用 z-index 钉死**：过渡期间 `.layer` 会被内联提到 `z-index:2`，粒子层 3 恒在其上；
  `#tod` 从 auto 提到 4 —— 时段滤镜连粒子一起调色，画面是一体的。
- **摆动是速度项不是位移项**：花瓣横摆按 `x += sin(phase)·sway·dt` 积分，stage:pause
  恢复后相位连续不会瞬跳；单步 dt 一律钳到 ≤50ms。Ken Burns「重置即跳变」的教训
  （2026-09-25 实锤）在粒子这边从第一天就避开。
- **初始铺满全屏**：开启瞬间就是「正在下雨」，不是从零攒出来的空场。
- **默认 256 粒、默认关闭**：数量收紧 0~1000（「保守 200~300」的拍板中值）；装饰效果不替
  用户做主。绘制只走 2d 路径（线段/椭圆），不用 shadow、不用每粒子渐变 ——
  常驻图层的预算按「用户零感知」给。
- **纯逻辑与绘制分离 + require-safe**：`particles.js` 在 Node 里 require 直接测
  clamp / spawn / step，在渲染层 `<script>` 挂 `window.WPParticles` ——
  无打包器，两种加载方式共用一个文件。

### 改动

- 新增 `src/renderer/particles.js`（218 行）：雨 = 短线段雨丝带 8%~16% 风斜、900~1400 px/s；
  樱花 = 慢落花瓣（55~125 px/s）+ 横摆 + 自旋、三档固定粉；出屏回收到顶部、左右绕回。
- `stage.html`：两层 `.layer` 之后、`#tod` 之前插 `<canvas id="particles">`，
  particles.js 先于 stage.js 加载；`stage.css`：`#particles` z-index:3 + pointer-events:none，
  `#tod` 提到 z-index:4。
- `stage.js`：rAF gate 块内 `particleFx.frame(now)` —— 与过渡/缓动共享 fpsCap 闸门，
  stage:pause 停 rAF 即冻结，恢复的时间跳变由 DT_MAX 兜住；`applyChannelConfig` 透传
  profile.particles / particleCount；resize 时同步粒子画布。Ken Burns 只 transform
  图层的内层 canvas，兄弟画布天然不被带动。
- `store.js`：PROFILE_KEYS 13 → 15（`particles` / `particleCount`，可每屏覆盖、
  随 channels 载荷广播到舞台）。
- 设置面板「系统 → 动态桌面」区块加「粒子特效」下拉（关闭/雨落/樱花落）与「粒子数量」
  滑条（0~1000，步进 4）—— 控件并入现有字段块，字段块总数保持 22，check-wiring 期望不动。
- 新增 `tools/test-particles.js`（96 行，28 项纯逻辑单测；`npm run verify:particles`）。

### 验证

- 纯 Node 全绿：test-scheduler **159** / test-live-desktop **42** / check-wiring **37** /
  verify-resume **28** / test-particles **28**。
- 真机隐形探针（`python tools/run-electron.py tools/tmp/probe-particles.js`，13 项，
  隔离 profile、**不挂桌面不碰 Z 序** —— 用户实例运行中也安全）：真 Chromium 里雨/樱花
  真的出像素（页内 getImageData 非透明像素统计，300 粒 ≈ 2 万像素）、同种子下 1000 粒
  覆盖像素多于 100 粒、关闭态清屏 + display:none、脏值回落；真实 stage.html 的
  `<script>` 相对路径加载成功、`#particles` z-index:3 / pointer-events:none 与
  `#tod` z-index:4 计算样式生效、console 无 particle 相关报错。
- 桌面观感未实测：等用户重启实例肉眼验收（雨丝/花瓣的密度与配色都在 particles.js
  顶部区间表里，调参不用动结构）。

## 第三十九轮：重启后黑屏——首帧被一次 resize 静默作废

### 现象：重启后桌面黑屏，必须等满一个 interval

用户重启（载入第三十八轮构建）后报：动态桌面黑屏，直到下一个轮播间隔才有壁纸；
恢复之后一切正常。不是偶发——每次重启都撞。

### 根因：onResize 的重画作废了取图途中的首帧，自己却画进未点亮的图层

启动链路里有一个天然的 resize 竞态：舞台窗口按 DIP 创建、按**物理取整坐标**挂载
（±1px，任务书 §2.4 的已知差），加上开机阶段 Windows 的 DPI 收敛，渲染层在首帧
取图途中会收到一次 resize。onResize 的旧实现是：

    const token = ++animToken;                       // ← 作废一切在途的 showFrame
    const bmp = await fetchBitmap(currentEntry);
    if (token !== animToken) { bmp.close(); return; }
    paintLayer(layers[active], bmp);                 // ← 画进 active 图层

首帧 showFrame 还在等 wpimg 流 / 解码时，这个 token 自增把它标记为「过期」——
showFrame 的 token 校验分支随后把**已取到的首帧位图静默丢弃**（连「取图失败」
的日志都没有）；而 onResize 自己的重画画进的是 active 图层，此刻它**从未被点亮
（opacity 恒 0）**。两层都不可见、currentEntry 却已设置、rAF 里没有任何东西会再把
图层点亮——桌面纯黑，直到下一个 tick 的 showFrame 正常走完。

竞态窗口的宽窄由首帧图决定：用户图库普遍 2~6MB（流式 + 解码 200~800ms），
mount 后的 resize 稳稳落进去；夹具图 10KB 解码几毫秒，窗口窄到之前的验证全部错过。
这也解释了「时好时坏」：rescue 只取决于 resize 是否恰好落进取图窗口。

### 复现（隐形探针）

`python tools/run-electron.py tools/tmp/probe-startup-frame.js`——隔离 profile 起真实
main.js：`interval=3600`（观察窗内**绝无 tick**）、大图 BMP 顶到 `files[0]`、把首帧的
wpimg 流压住 3 秒（模拟慢盘 / 半同步文件），在「首帧上屏」日志出现（取图在途）时
派发 resize。修复前判定 `no-first-frame-no-error`：25 秒内两层 opacity 恒 0、可见像素
0、tick=0——黑屏坐实且无人兜底。探针全程不挂桌面、不写系统壁纸，用户实例运行中
也安全。

### 修复

- `stage.js onResize`：重画当前帧改走 `showFrame(currentEntry, 1, false)` 本尊——
  token 互斥由它自己管理，画完的图层一定是被点亮的那块。不再手工
  `++animToken` + `paintLayer`（那正是「作废首帧 + 画进暗层」的组合）；
  `paintLayer` 随之失去唯一调用点，删除。
- `showFrame` 的 duration=0 快照式上屏补 `anim = null`：两层刚被钉回原位，
  进行中的旧过渡的收尾帧不能再写它们（此前这条路径会留下僵尸过渡）。
- 视频/网页壁纸仍走原早退路径（下一 rAF 自动按新画布重画 / iframe 自适应），行为不变。

### 验证

- 复现探针修复前/后对照：`no-first-frame-no-error` → `first-frame-ok`
  （可见像素 0 → 320/320，tick 恒 0，同一套恶劣条件：首帧流压 3 秒 + resize 打进取图途中）。
- 纯 Node 全绿：test-scheduler **159** / test-live-desktop **42** / check-wiring **37** /
  test-particles **28** / verify-resume **28**。
- 桌面观感：重启实例后首帧应立即可见，不再等 interval。

## 第四十轮：粒子特效按屏配置 + 「随机」种类

### 现象：特效想一块屏一个样，换图想换花样

用户拍板两件事：① 粒子特效以**显示器为单位**配置（一块屏下雨、另一块飘樱花）；
② 新增「随机」种类——**每次壁纸切换时在雨落 / 樱花落之间随机抽一种**。

### 设计决定

- **沿用既有覆盖模型，不发明新通道**：`particles` / `particleCount` 本来就在
  PROFILE_KEYS 里（随 channels 载荷广播到每块舞台），这一轮只是把 UI 接上——
  每屏卡片加控件，顶部「系统」页的全局设置保留为默认值。三态语义：
  「跟随全局」= 不写覆盖（落盘发 `null`，writeProfile 删除该键回落顶层）；
  「关闭」= 显式写 `''`；其余 = 这块屏固定用该种类。
- **卡片读「跟随全局」态必须读 monitors 原始覆盖**，resolveProfile 合并后的值
  区分不出「没设过」和「设成和全局一样」——cardHtml 直接读
  `state.config.monitors[ch.id]`；存完用 set-profile 返回的最新 config 重画
  （该接口本来就带 `config: store.get()`，不用再发一次 config:get）。
- **random 在舞台侧解析，不进 particles.js**：`cfg.particles` 存配置值，
  `cfg.particlesActive` 存实际生效种类；每次 channel:tick（手动翻页也走 tick）
  重抽一次并同步给粒子层，particles.js 的白名单继续只认 rain/sakura。

### 改动

- `stage.js`：新增 `rollParticles()` + `cfg.particlesActive`；applyChannelConfig
  解析后生效，onTick 在 random 时每次换图重抽。
- `app.js`：每屏卡片「更多」区加「粒子特效」块（种类下拉 + 数量输入，留空 =
  跟随全局）；change 委托新增 particles / number 两类分支（null 语义见上）。
- `index.html`：全局「粒子特效」下拉加「随机（每次换图抽一种）」选项。

### 验证

- 纯 Node 全绿：159 / 42 / 37 / 28（particles）/ 28（resume）；app.js / stage.js
  语法检查通过；字段块总数保持 22（卡片控件不是 field block）。
- 桌面观感未实测：等用户重启验收（一块屏下雨另一块飘樱花、random 换图换特效）。

## 第四十一轮：粒子特效全家桶（11 种）

### 现象：两种不够看

用户看完候选清单拍板：「都加上我看看」。在雨/樱花之外一次加九种：
**雪、萤火虫、星空流星、泡泡、落叶、柳絮、光粒漂浮、彩带纸屑、雷雨**。

### 设计决定

- **类型注册表取代 if/else 链**：`particles.js` 的 `TYPES` 里每种特效登记
  `make / step / draw` 三个纯函数（可选 `begin/end` 做批次级 ctx 状态，比如萤火虫的
  lighter 混合）。11 种特效共用同一套 clamp / spawn / step / draw 出口与 DT_MAX 钳位
  —— 以后再加一种就是注册表里 +1 项，外加两个下拉各 +1 行。
- **雨/樱花的数学逐字节不动**：注册表化是纯搬运，单测对这两类的断言
  （同种子确定性、速度区间、回收坐标）原样通过，证明重构没有顺手改行为。
- **雷雨的闪电长在粒子里**：~2% 的粒子是 flash 载体（fTimer 倒数 → fDur 亮 ~0.1s
  全屏白），不引入第二套状态机；星空的流星同理 —— 86% 静星 + 候场流星
  （wait 倒数，2~10s 一颗），都在同一条粒子数组里按 kind 分派。
- **random 自动扩池**：`rollParticles` 从 `WPParticles.PARTICLE_TYPES` 抽取，
  新增种类自动进池，不用改随机逻辑。

### 改动

- `particles.js`：类型注册表化 + 九种新特效（218 → ~500 行）；顺手修掉一个旧瑕疵
  —— 关闭态不再养「影子粒子」（此前 `setConfig('', 256)` 会 append 一批永不被画的粒子）。
- `stage.js`：rollParticles 抽取池改为全种类。
- 全局/每屏下拉补齐 11 种；`test-particles.js` 白名单断言更新 + §5 全种类冒烟
  （spawn/step 逐种跑一遍），28 → 32 项。

### 验证

- 纯 Node 全绿：159 / 42 / 37 / **32**（particles）/ 28（resume）。
- 真机探针（隐形）全绿：11 种特效逐种真画出像素
  （rain=19636, sakura=25118, snow=14543, fireflies=63888, stars=6014, bubbles=33161,
  leaves=58429, fluff=39924, dust=4473, confetti=18242, storm=22972，非透明像素数），
  数量单调、关闭态清屏、脏值回落、stage 接线不变，共 11 项。
- 观感调参都在 `TYPES` 各自的区间表里（密度/速度/大小/透明度）；用户挑定之后，
  不想要的种类从下拉里删一行即可（白名单照旧兜底）。

## 第四十二轮：粒子放大 + 光效类（丁达尔/光晕）

### 现象：粒子偏小；想要「光」

用户反馈两点：① 部分特效观感偏小，让我判断哪些该放大；② 想要光特效——
丁达尔现象、光晕这类，其余候选列出来再挑。

### 设计决定

- **放大的判据是「自然界里该多大」**：花瓣/雪花/泡泡/叶片/绒絮/彩带有真实参照物，
  整体上调一档（4K 物理像素下 3px 的雪花根本看不见）；尘埃和星点**保持小**——
  那是它们的存在方式，只微调；雨丝长度微调。像素取证印证放大量：
  樱花 25118 → 41065 非透明像素、雪 14543 → 29100。
- **光效类不是粒子雨，是场景光**：大面积、低透明度、慢呼吸、lighter 混合。
  数量内置（`cap` 字段：丁达尔 6 根封顶、光晕 3 团封顶，spawn/setConfig 经
  countFor 收口），不随「粒子数量」滑条走 —— 256 根光柱会把整个桌面刷白。
- **丁达尔的软边用惰性预渲染贴图**：横向衰减 × 纵向渐隐（destination-in 做乘法
  遮罩）离屏画一次，之后每帧只是一次 drawImage + rotate；比每帧拼两层渐变便宜，
  效果也更柔。纯 Node（单测）没有 document，sprite 返回 null 直接不画。
- **random 自动扩池**：两种光效进 PARTICLE_TYPES，随机抽取自动包含。

### 尺寸调整明细（单位 px）

| 特效 | 原 | 现 |
|---|---|---|
| 樱花（长半轴） | 2.6~6 | 3.5~8 |
| 雪 | 1.2~3.4 | 2~5 |
| 泡泡 | 2~7 | 3~11 |
| 萤火虫核心 | 1.2~2.4 | 1.6~3.2（光晕随之） |
| 落叶 | 4.5~10.5 | 7~14 |
| 柳絮 | 1.4~3.2 | 2~4 |
| 彩带 | 4~9 × 2.5~5 | 6~12 × 3.5~7 |
| 光粒 | 0.6~1.6 | 0.8~2（本性小，微调） |
| 雨丝长 | 12~28 | 14~32（微调） |

星空星点保持自然小；雷雨复用雨。

### 改动

- `particles.js`：TYPES 加 `rays`（丁达尔光束）/ `halo`（光晕）+ cap 机制；八种粒子
  尺寸上调（明细见上表，区间也写在各自 make 的注释里）。
- 全局/每屏下拉补齐 13 种；提示文案注明光效类数量内置。
- `test-particles.js`：白名单 13、樱花新尺寸、cap 断言（rays=6 / halo=3 / rain 原样）。

### 验证

- 纯 Node 全绿：159 / 42 / 37 / **34**（particles）/ 28（resume）。
- 真机探针（隐形）13 种逐种取证全绿：rays=448937、halo=403703（大面积低 alpha，
  符合预期）、rain=21877、sakura=41065、snow=29100、fireflies=118305、stars=6118、
  bubbles=52039、leaves=99507、fluff=62397、dust=6526、confetti=30344、storm=22972；
  数量单调、关闭态清屏、脏值回落、stage 接线不变，共 11 项。
- 观感未实测：等用户重启验收（光效类上真机后如果太亮/太暗，改各自 alpha 区间即可）。

### 补充（同轮后续）

用户报「粒子没有生效」——排查结论：**链路没问题，是每屏覆盖在起作用**。
隐形探针（probe-live-particles.js）走完用户的完整操作链：主窗口 setConfig →
重建 → 广播 → 两块舞台的粒子画布都在真画花瓣（44483 / 42818 非透明像素），
profile 载荷两路都带 particles。而用户配置里一块屏覆盖了 `particles:"random"`、
另一块覆盖了 `particles:""（关闭）+ particleCount:0` —— 全局的樱花到不了它们。
顺手补一条当场提醒：全局粒子设置保存时，若存在每屏覆盖，toast 直接点明
「N 块屏设了独立粒子覆盖」。

## 第四十三轮：四种「隐约系」特效按反馈调亮

### 现象：流星/光晕/光粒/丁达尔都看不出来

用户上机验收：这四种当初按「隐约质感」调的，实际观感是「看不见」。逐项提亮。

### 改动（全是 TYPES 区间表调参，无结构变化）

| 项 | 原 | 现 |
|---|---|---|
| 流星星点 | 0.6~1.6px / alpha 0.4~1.0 | 1.1~2.7px / alpha 0.55~1.0 |
| 流星拖尾 | 长 70~160 / 每 2~10s 一颗 / 线宽 1.4 | 长 90~220 / 每 1~5s 一颗 / 线宽 1.8 / 占比 14%→22% |
| 光晕 | alpha 0.05~0.11，半径 160~380，3 团 | alpha 0.11~0.19，半径 200~420，4 团 |
| 光粒 | alpha 0.08~0.26，0.8~2px | alpha 0.16~0.40，1~2.6px，微加速 |
| 丁达尔 | alpha 0.05~0.11，宽 70~200，呼吸下限 0.15 | alpha 0.10~0.17，宽 90~240，呼吸下限 0.35 |

### 验证

- 纯 Node 全绿：159 / 42 / 37 / **34**（particles）/ 28（resume）。
- 真机探针 13 种逐种取证全绿，可见度在像素上兑现：stars 6118 → **11248**、
  dust 6526 → **10349**、halo 403703 → **439792**、rays 448937 → **458939**
  （非透明像素数，其余种类不变）。
- 观感终验：等用户重启后再看；还嫌淡/嫌闹就继续改区间（都在 TYPES 注释里）。

## 第四十四轮：特效阵容调整——下线三种，新增四种

### 现象：丁达尔/光晕确实不明显，雷雨不要了；想要烟花、火焰灰烬、雨落水花、雨滴挂屏

用户上机后拍板：丁达尔、光晕删掉（不明显），雷雨也删掉；换成烟花、火焰的灰烬、
雨滴落地的水花，还有挂在屏幕上的雨珠。阵容 13 → 14 种。

### 设计决定

- **烟花是一条粒子的三段人生**：wait（候场）→ rocket（升空亮点，~1.1s）→
  burst（36~61 颗火花：阻力减速 + 重力 260 + 渐灭 + 末段闪烁，炸开瞬间有一圈闪光）。
  数量内置 cap=5 —— 大场面特效，256 发齐炸没有意义。
- **火焰灰烬是「火源在画面下方」的雨**：橙红四色、上升 + 摇曳 + 高频闪烁、
  越高越淡（hFade 按 y 收），lighter 混合让重叠的火屑发亮。
- **雨落水花复用 rain 的造型**：一条粒子两段人生 —— 雨丝触地 → 变成水冠
  （半圆弧 0.22~0.38s 展开）→ 变回顶上重来的雨丝，数组长度恒定。
- **雨滴挂屏是「挂-滑-挂」**：水珠挂着（0.4~4s）→ 缓缓下滑一小段（带渐隐拖尾 +
  左上高光的玻璃质感）→ 接着挂；滑出屏底才换位置。
- 配置兼容：手改 config.json 里残留的 storm/rays/halo 会被白名单回落为关闭，
  不会炸。

### 改动

- `particles.js`：删除 storm/rays/halo；新增 fireworks（cap=5）/embers/splash/raindrops。
- 全局/每屏下拉同步为 14 种；提示文案改为「烟花数量内置（最多同时 5 发）」。
- `test-particles.js`：白名单 14、fireworks cap=5、烟花三段人生断言、
  水花两段人生断言（34 → 35 项）。

### 验证

- 纯 Node 全绿：159 / 42 / 37 / **35**（particles）/ 28（resume）；app.js 语法过。
- 真机探针 14 种逐种取证全绿（烟花取 8 秒峰值）：rain=22058, sakura=44190,
  snow=30270, fireflies=118374, stars=11248, bubbles=54424, leaves=111627, fluff=65102,
  dust=10509, confetti=32627, **fireworks=3554, embers=66577, splash=22733,
  raindrops=32242**（非透明像素）；关闭态清屏、脏值回落、stage 接线不变。
- 观感未实测：等用户重启验收。

## 第五十四轮：启动黑闪的余党 —— 3s 兜底亮黑窗，以及缩略图「黑块」观感

### 现象：用户验收 53 轮首帧门控后的反馈

重启还是有黑闪，而且是**同步**出现的：重启那一刻桌面本来有壁纸（系统壁纸层
正常），但主窗口的缩略图条是黑的，同时舞台也是黑的——过几秒才一起缓过来。

### 根因：53 轮自己留的「3s 兜底」就是黑闪余党

53 轮的首帧门控挂载后窗口保持隐藏、等渲染端画完第一帧再亮 —— 但留了一个
「3 秒超时兜底显示」：超时就 `showInactive` 把窗口亮出去。而窗口的底色是
纯黑（`backgroundColor: '#000000'`）。冷启动时首帧要做什么？GPU 进程冷启、
wpimg 拉 8K 原图、解码 130MB 位图，加上主窗口同时在生成缩略图、调度器在写
系统壁纸 —— 3 秒根本不够。于是时间线变成：

- 0~3s：舞台藏着，桌面显示系统壁纸（对，用户看到的「有壁纸」）；
- 3s：**兜底把纯黑舞台亮出去**，正好盖在壁纸上（黑闪 + 舞台黑）；
- 同一时刻主窗口的缩略图还在加载（黑块）—— 两个黑同步出现；
- 5~7s：首帧画完、缩略图到位，一起缓过来。

53 轮探针其实打出过「首帧超时(3s)兜底显示」，当时误判成预期路径了。

### 改动（第一批，commit eee7034）

- `liveStage.js`：兜底**不再亮窗**，超时（放宽到 30s）只打一条告警日志、
  保持隐藏。首帧无论多晚到达都由 `onFirstFrame` 正常亮窗 —— 桌面显示系统
  壁纸永远比亮一块黑窗好，隐藏着等没有任何代价。
- `stage.js`：网页壁纸的首帧改为等 iframe 真正 `load` 再通知亮窗（10s 兜底），
  此前提前亮窗露的是空白 iframe；被切走的帧不通知（token 判定）。
- `app.js` + `style.css`：胶片条缩略图加载完成前 `img` 透明，格子显示一层
  缓缓扫过的微光占位（shimmer），加载完 0.22s 淡入 —— 启动那几秒读作
  「正在载入」而不是「一排黑块坏了」；404 的破格子停掉动画、垫稍亮的底。

### 改动（第二批，用户追加两个诉求：黑改透明 + 「是不是在等壁纸读出来」）

- **舞台窗口透明化**：`transparent: true` + `backgroundColor #00000000` +
  `stage.css` body 透明 —— 今后任何「还没画上内容」的空窗期透出的都是底下的
  系统壁纸/图标，物理上不可能再露黑（内容画上后是不透明 canvas，鼠标行为
  与之前一致）。
- **缩略图快亮**（对症「等壁纸读出来」）：等首帧的时间大头其实是**原图取回 +
  解码**（8K 秒级），不是频道清单（有启动缓存）。首帧先用磁盘缩略图
  （`wpthumb://`，缓存命中 ~6ms）垫一帧、点亮窗口，原图解码完无缝重绘 ——
  观感是「壁纸先略糊一瞬、马上变清晰」，而不是「先黑一下再出图」。
  只在首帧做（正常运行中的过渡有旧图垫底，垫模糊帧反而穿帮）。
- **挖出一个老坑**：`registerSchemesAsPrivileged` **多次调用会互相覆盖**——
  main.js 里 wpthumb（line 39）和 wpimg（line 40）各注册了一次，wpthumb 的
  特权（含 fetch 支持）从第一天起就被 wpimg 清掉了；胶片条只用 `<img>`
  （不走 fetch）所以六年……五十四轮都没暴露。舞台垫图一用 fetch 立刻
  「Failed to fetch」（0ms 即拒、连 no-cors 都拒 = scheme 特权没生效，
  ACAO 响应头都轮不到看）。修法：两个协议合成一个数组、只调一次。

### 验证

- 新探针 `probe-firstframe-noblack.js`（隐形不挂桌面）：6s 延迟大图流压住原图
  路径做负向对照 —— 核心不变式「**每次亮窗时页面必有非透明内容**」（亮黑窗/
  空窗在此现形）+ 页面底色 = rgba(0,0,0,0) + 首帧快亮 <5s。最终 showInactive
  @0.7s、画布 192/192 像素、wpthumb 页内 fetch 31ms 成功。VERDICT OK。
- 39 轮回归探针 `probe-startup-frame.js` 依旧 first-frame-ok（elapsed 1.4s）。
- 纯 Node 基线全绿：live-desktop 72 / scheduler 162 / particles 45 / resume 28 /
  wiring 42。
- 未实测：透明窗口挂上 Progman 后的真机观感与独占全屏游戏的兼容性（透明会改变
  交换链的 alpha 路径，艾尔登法环场景如有异常第一时间回退一行配置即可）——
  等用户重启验收。

### 追记（真机验收翻车：透明窗口与桌面挂载不兼容，整体回退）

用户重启验收：黑闪确实没了，但**舞台位置不对、没有完整覆盖显示器**。

`b3f421b` 里唯一碰几何的改动就是 `transparent: true`。透明窗口走 DirectComposition
合成路径，挂成 Progman 子窗口后，合成面的几何与 HWND 的位置/尺寸脱钩——
这正好呈现为「窗口在、内容整体错位、盖不满屏」。而且 2026-09-25 那套按不透明
GDI 重定向表面实测调出来的「边框补偿 + 窗口区域裁剪」，与 DComp 合成路径
天生不在一个层面，补偿前提已失效。

决定：**transparent 整体回退**（窗口 `transparent: false` + `backgroundColor
'#000000'`、stage.css body 回 `#000`），保留其余全部 54 轮改动（首帧门控、
缩略图快亮、协议特权合并注册）。防黑闪靠「有内容才亮窗」——第一帧垫的是
壁纸缩略图而不是黑底，透明的兜底价值本就趋近于零，不值得拿几何正确性换。

验证：首帧探针 VERDICT OK（亮窗 @0.6s、每次亮窗画布 192/192 像素、底色
rgb(0,0,0)）；五套基线 72/162/45/28/42 全绿。附带教训写进交接文档坑 33：
沙箱里创建透明窗口会原生崩溃，**这个改动当时根本不可能被任何探针拦下**，
纯靠真机验收兜住——「探针全绿 ≠ 可上线」的又一例。

### 追记四（真机反馈：QQ 截图/录屏把舞台干掉 → 排除 QQ + 全屏暂停默认不藏窗）

用户反馈：开 QQ 截图或录屏时**主屏舞台会掉**（副屏不受影响），且任何全屏
退出时都能看到一段「恢复过程」。

**根因**：QQNT 的截图/录屏遮罩是全屏窗口，被全屏自动暂停（fullscreenWatch）
判成「全屏应用」；而 52 轮引入的「暂停时隐藏舞台」（`hideOnPaused`，为防
艾尔登法环独占全屏把驱动挂死）把这个暂停变成了隐藏 —— 遮罩一出现舞台就被
藏起来，退出全屏再经历「亮窗 + 首帧」的恢复过程。

**改动一：QQ 镜像路径排除。** QQNT 是 Electron 套壳，遮罩窗口类名是
`Chrome_WidgetWin_1`，与所有 Chromium 应用相同 —— **不能按类名排除**（会
误伤浏览器 F11 全屏）。改为按 `exeOf(pid)` 的**进程镜像文件名**排除：
`EXCLUDED_IMAGE_NAMES = { 'qq.exe' }`（小写比较）。只对「eligible 且完整
盖住某块屏工作区」的窗口才调 OpenProcess 解析路径（通常 ≤2 个/轮，开销可
忽略）；路径取不到（权限等）一律**不排除**——宁可误暂停、不可漏暂停。

**改动二：全屏暂停默认改为「冻结不藏窗」。** `hideOnPaused` 默认值翻转为
关（`=== true` 才隐藏），设置项文案同步改写。现在全屏/锁屏暂停的行为是：
舞台留在原地、画面钉在当前帧（停 rAF = 粒子也停）、调度器停表不走针，退出
全屏 1 秒内原地续播，**没有任何掉/恢复的视觉过程**。

⚠️ **代价与取舍（重要）**：独占全屏游戏（艾尔登法环，实测 6 次黑屏无信号）
的风险随隐藏的默认关闭而回来 —— **玩独占全屏游戏前请在设置里勾回「全屏 /
锁屏暂停时隐藏桌面画面」**；无边框全屏不受影响（52 轮用户对照实验实证）。
已存了旧配置的用户注意：配置里已落盘的 `hideOnPaused: true` 不会被新默认
覆盖，需要手动去设置里把勾去掉。

**验证**：fullscreen-watch 单测新增 §7 共 5 条断言（QQ 排除 / 大小写 /
非名单 exe 照常暂停 / imageName 缺失不排除 / QQ+真全屏并存），30/30 全绿；
五套基线 72/162/45/28/42 不变。QQ 遮罩的进程归属（是否真是 QQ.exe）未能在
沙箱探针里实测到（采样输出两次被超时杀丢），待真机验收：开 QQ 截图若舞台
仍掉，回报我再扩名单。

### 追记五（新功能：桌面手势切壁纸 —— 鼠标横向拖拽 / 触屏横扫）

用户需求：在桌面上按住拖一下就能切壁纸；触摸屏横扫同理。

**行为**：在桌面空白处**按住左键横向拖 ≥120px**（纵向偏移不超过横向的 1/4）
松手 —— 往左扫 = 下一张，往右扫 = 上一张。切换发生在**起手点所在的那块屏**，
多屏互不影响；统一模式归唯一一路频道。触摸屏的按下/移动由 Windows 合成鼠标
输入，无需单独处理。

**实现要点**：

- **轮询不钩子**：16ms 轮询三个 Win32 调用（GetAsyncKeyState / GetCursorPos /
  WindowFromPoint），事件一个都不吞 —— 桌面框选、拖图标、右键菜单完全不受
  输入层影响。低级鼠标钩子要自带消息泵，卡一下全系统鼠标都卡，壁纸常驻功能
  不值得冒这个险。
- **起手点判定**：WindowFromPoint → GetAncestor(GA_ROOT) → 类名 ∈
  {Progman, WorkerW} 才算桌面（图标层是 Progman 子树，根还是它；任务栏与
  应用窗口都不算）。本项目舞台窗口 WS_EX_TRANSPARENT 穿透命中测试，无需特判。
- **复用链路**：从 `channelAtCursor` 抽出 `channelAt(pt)` 与
  `stepWallpaperAt(pt, dir)`，桌面菜单与手势共用同一条「定位屏 → step(±1)」
  路径，失败都给 notice。
- **已知取舍**：横向橡皮筋框选、横向拖图标与手势同形，也会触发切图 ——
  语义如此，设置里有开关（`swipeSwitch`，默认开，即时生效）。

**验证**：新增 `tools/test-swipe-watch.js` 17 条纯函数断言（方向 / 阈值 /
横向主导 / 脏输入 / 常量），17/17；koffi `WindowFromPoint` 按值传 POINT 冒烟
实测命中正确；wiring 42/42（UI_ONLY_KEYS 断言同步）；其余基线
live 72 / scheduler 162 / particles 45 / resume 28 不变。真机手势观感待用户验收。

### 追记六（新功能：粒子绕开鼠标 —— 光标斥力避让）

用户需求：粒子会绕开「以鼠标为圆心的一定范围」。

**行为**：光标周围 **140px（CSS 逻辑像素）** 半径内的粒子被沿径向外推，
推速按 `(1 - d/R)` 线性衰减（圆心处最快 260 px/s，边缘归零）——雪 / 樱花 /
萤火虫 / 泡泡这类慢粒子会明显绕行，雨丝这类快粒子一帧穿过、隐约让路。
**烟花不吃斥力**（候场态的 x,y 无意义、炸开态的火花是独立数组，推了会瞬移）。
设置 → 动态桌面新增开关「粒子绕开鼠标」（顶层键 `particleCursor`，默认开，
经 `resolveProfile` 流进各屏 profile）。

**实现**（为什么这么做）：
- 舞台窗口是点击穿透的（`WS_EX_TRANSPARENT`），渲染端**永远收不到 mousemove**
  ——光标位置只能由主进程喂。`liveStage` 起一个 **30Hz 轮询**
  （`screen.getCursorScreenPoint()` → 按各舞台 `getContentBounds()` 减法换算
  成本屏 CSS px → `stage:cursor` 广播；窗外发 `null` 让该屏停用避让）。
  Electron 里 1 CSS px = 1 DIP，坐标不用除缩放。
- 斥力是**纯函数** `WPParticles.applyCursorAvoidance`（原地外推位置，不改速度
  字段）：暂停恢复 / 帧率波动都由既有 DT_MAX 钳位兜住，不会瞬移。

**验证**：test-particles 45 → **52**（§7 斥力 7 项：径向外推 / 线性衰减 /
半径外不动 / null·NaN·dt=0 脏输入 / 烟花三态免疫 / 常量区间）；
新探针 `probe-cursor-feed`（隐形不挂桌面）VERDICT OK——preload 桥 + 渲染端
回调 + null 语义 + 常量导出全过；基线 live 72 / scheduler 162 / fs 30 / swipe 17 /
resume 28 / wiring 42 不变。真机观感（140px 半径合不合适）待用户验收。

### 追记七（用户实报「切图有时候出现很模糊的图」）

**根因**：不是图坏了——是 **blur-dissolve（模糊溶解）过渡**。用户两条频道
`animation: "random"` + `duration: 1500ms`，而 random 随机池含 blur-dissolve
（11 选 1）：入场从 `blur(24px)` 渐清晰、旧图向 `blur(18px)` 消散，3512×2160
的大图上 GPU 模糊又慢，1.5 秒过渡期内任意时刻看都是「整张糊掉的图」——
「有时候」就是随机抽中它的那一次。

**改动**：
- `blur-dissolve` 移出 app.js 预览层与 stage.js 舞台端的 **random 随机池**
  （想用它仍在动画下拉里显式选，效果不变）；
- 顺带补 app.js 过渡收尾的小漏：清理定时器此前只重置**出场层**的
  clip/filter，blur-dissolve 的终态 `blur(0px)` 会永久挂在**活跃层**上
  （filter 非 none 会让巨图一直占一块合成层）——现在活跃层也清 filter/clip
  （不动 opacity/transform/zIndex，那些是活跃层的正常状态）。

**验证**：wiring 42 / live 72 / scheduler 162 / particles 52 全绿（改动不碰
配置链路，无新断言）；行为变化 = random 抽签不再出现模糊过渡。

### 追记八（用户实报「切换动画不够顺滑、比较生硬」）

**根因**：`fpsCap`（默认 30，用户配置里也是 30）的 rAF 闸门把**整条渲染循环**
都闸在 30fps——包括过渡动画。闸门本是省电策略（画面静止时 GPU 零占用），
但 slide/zoom 这类位移过渡在 30fps 下肉眼可见的掉帧生硬。stage.js 里早写过
「30 在 60Hz 屏上过渡明显掉帧」的注释，却一直没落实到闸门逻辑上。

**改动**：**过渡动画不吃 fpsCap 闸门**——`ensureRaf` 循环里 `animTick` 每帧
执行（跟满垂直同步），Ken Burns / 呼吸 / 粒子 / 视频是长驻动画，继续走闸门
省电（30fps 对缓慢缩放足够）。过渡只持续一两秒，短时全帧率代价可接受。
用户配置里已落盘的 `fpsCap: 30` 不用改，过滤断然全帧率；三处过时注释
（stage.js 默认值 / store.js 默认值 / PROFILE_KEYS）一并对齐。

**验证**：wiring 42 / live 72 / scheduler 162 / particles 52 全绿；真机观感
待用户验收（60Hz 屏应可感知过渡变跟手；高刷屏收益更大）。

### 追记九（用户实报「新用户提示没有图片目录，选择后卡在首屏进不去」）

**根因**：新用户首屏没有图片 → 空态大按钮「选择图片目录」→（53 轮改的）只开
**相簿页**。但相簿页从头到尾**没有「绑定屏幕」的操作**：新建相簿、添加目录后，
频道的 `profile.albumId` 仍是空串（空 = 无图可播），频道永远 0 张图，空态遮罩
（inset:0 / z-index 12，盖住顶栏 z-index 10）永远在 —— 用户卡死在首屏。
而本来会「自动建相簿 + 自动绑定」的 `folder:pick` 原生对话框路径，恰恰被这次
改版绕开了。相簿卡片 meta 里那句「未绑定屏幕」没有配套操作，等于提示了个寂寞。

**改动**：
- 空态大按钮恢复**直接弹原生目录对话框**（`folder:pick`：自动建相簿 + 绑定
  当前屏 + 重建轮播），这才符合按钮文案的预期；取消选择留在原地无副作用；
- 相簿页补上引导收尾：`addDirsToAlbum` 加完目录后，若该相簿未被任何屏幕使用
  且存在还没绑相簿的屏，**自动绑定**（复用 channel:command 的 set-profile）
  并收起相簿页让壁纸立刻出来；所有屏都已绑别的相簿时不抢，提示手动绑。

**验证**：wiring 42 / live 72 / scheduler 162 / particles 52 / resume 28 /
fs 30 / swipe 17 全绿。新用户流程待真机走一遍（选目录 → 壁纸出现）。

## 第五十九轮：全屏暂停把过渡钉死在半截 —— 主屏黑屏只剩 12px 窄条

### 现象（用户实报）

「壁纸切换器.vbs 打开主显示器又是黑的，不过退出后倒是会显示壁纸。」
副屏一切正常；退出应用后系统壁纸（数据层完好）就回来了。
上一轮的「主屏黑屏 = Explorer 渲染层卡死」其实是同一件事——重启 Explorer
把黑掉的舞台一起带走了，误诊。

### 取证（PrintWindow 逐窗口抓帧 + 注册表 + 进程时间线）

- 数据层完好：`BackgroundType=0`、`CurrentWallpaperPath` 指向真实存在的
  新世界 jpg、`TranscodedWallpaper` 2.75MB 当场重写过 —— 不是壁纸数据问题；
- 抓两个舞台窗口本体（PrintWindow，不吃顶层窗口遮挡的亏）：**副屏 100% 非黑、
  主屏 0.5% 非黑** —— 黑屏在主屏舞台的渲染内容里，非 12px 窄条莫属；
- 窄条 = 一张图的右缘切片，25 分钟内非黑采样数一帧不变（966/207368）；
- 主屏频道 playback 存档停在应用启动**之前**：interval 30s 却 30+ 分钟没推进过；
- 主屏上有 `ELDEN RING NIGHTREIGN` 全屏窗口（2560×1440 盖满工作区，15:26 启动，
  早于应用 17:50 的启动）—— fullscreenWatch 按设计判「全屏暂停」：
  调度器日志实录「SAC2766 处于冻结（全屏/锁屏/电池），停表不走针」；
- 隔离复现探针（tools/probe-freeze-pin.js）：手动 applyPauseState 打断 8s 长过渡，
  未修复代码下「暂停落在过渡中段」时画面被**永久定格在半截**。

**根因**：`setFrozen(true)` 只停 rAF，不收尾 —— 若暂停恰好落在过渡进行中
（slide 已滑到 e≈0.995 / wipe 刚揭出 0.5%），画面被钉在中间帧；调度器同时
「停表不走针」，永远等不到下一帧来收尾。全屏游戏一开几小时，这一黑就黑几小时。
52 轮的「暂停=画面钉在当前帧」语义没规定"当前帧"必须是**完整帧**，这是个洞。

### 改动

- `stage.js` 新增 `pinAnimToEnd()`：**冻结瞬间把进行中的过渡钉到终态**
  （incoming REST(1) / outgoing REST(0) / clearFx / shrinkCanvas）——
  停在完整帧，不停在半截。incoming 的画布在 anim 启动前就已画好，钉终态必然有内容；
- `stage.js` 新增**静止态自愈**（10s 巡检，开销可忽略）：不变量「anim=null 时
  活动层必须完整盖屏（transform=REST / op=1 / 无 clip / canvas 非缩样）」，
  被任何路径弄坏就用快照路径重画钉正 —— 冻结态也生效（drawSource 不依赖 rAF）；
- `stage.js` 新增 `stage.html?debug=1` 诊断埋点（`WP_STAGE_DEBUG=1` 时由
  liveStage 附加查询参数开启）：每 3s dump 双图层 transform/opacity/clip/canvas
  尺寸，黑屏类问题从此有渲染端现场可取证。⚠️ 渲染层没有 `process`
  （nodeIntegration=false），埋点读 `process.env` 顶层抛错会杀死整个 stage.js
  （第一跑实锤），开关只能走查询参数；
- 新增 `tools/diag-stage-capture.py`（PrintWindow 抓挂载舞台 + 非黑统计，
  黑屏取证的标准工具）与 `tools/probe-freeze-pin.js`（冻结钉帧回归探针）。

### 验证

- 真机重启验收（游戏保持全屏）：主屏舞台 `frozen=true` 且活动层 op=1 /
  canvas 全尺寸 / transform REST —— 冻在完整帧上，不再黑屏；
- probe-freeze-pin 6/6：暂停后画面完整（100% 非黑）+ 解冻恢复轮播；
- fullscreen-pause e2e 11/12（末项「撤掉全屏⇒暂停集合为空」因真机正跑着
  全屏游戏，采样必然命中，环境性失败非回归）；wiring 43 全绿；
- live e2e 12/13，末项「看门狗重申 Z 序」在 HEAD 未改版同样失败（对照实验确认
  与本轮改动无关，同为游戏全屏环境干扰）。

## 第 58 轮追记一：退出/让位后幻灯片还是切不动 —— slideshow.ini 快照守卫


### 现象（用户实报）

58 轮之后：「现在我退出项目了，然后想在个性化切换壁纸模式为幻灯片还是不行，秒回壁纸。」

### 取证

- 全盘进程扫描（按镜像路径精确匹配）：`壁纸切换器.exe` **0 进程**，只有 tag-viewer
  的 4 个 electron（不相干）—— 报障时应用确实已退出；
- `Themes/slideshow.ini` = **0 字节，mtime 14:09:27**；`TranscodedWallpaper` 停在
  14:08:45 —— 14:09:27 之后**没有任何一笔壁纸写入**，说明那次「切幻灯片」根本
  没有真正生效过；
- 注册表 `Explorer\Wallpapers`：`BackgroundType = 0`（图片模式），但
  `SlideshowDirectoryPath1`（幻灯片相册 PIDL）**还在**；
- `config.json` mtime 14:08:57（`applyToSystem: false`）—— 应用 14:08 时还活着，
  用户是试完幻灯片才退出的；14:08:45 那笔壁纸写入发生在「接管」还开着的窗口期
  （接管期间的任何一笔写入都会把 slideshow.ini 踩成 0 字节，57 轮已取证）。

**根因**：接管期间写系统壁纸不仅打回「图片」模式，还把 slideshow.ini 里的
**幻灯片相册配置**一并清空 —— 这个伤害是**永久性**的，退出/让位之后 Explorer
没有相册配置可用，个性化里选「幻灯片放映」直接弹回。57 轮的「让位」开关只保证
让位后不再写，**没救回已经被踩掉的配置**。

### 改动（快照守卫）

- 新增 `src/slideshowGuard.js`（纯文件操作，不碰 electron，可单测）：
  - `snapshotIfGood()`：任何一笔系统壁纸写入**前**，若 slideshow.ini 有内容
    （>0 字节 = 用户配置过的相册）就快照到 userData 下；ini 已空则保留手头
    旧快照不覆盖；
  - `restoreIfEmpty()`：ini 为空且有非空快照时还原；ini 有内容（用户自己在
    用幻灯片）绝不动。还原的只是相册配置文件，**不代拨背景模式**；
- `win32.setWallpaper` 写入前快照（所有写壁纸路径的单一咽喉），备份路径由
  `configureSlideshowGuard()` 注入（主进程 ready 时传 userData 路径）；
- `main.js` 三个还原时机：① 设置面板「接管系统壁纸」拨到关的瞬间；
  ② 托盘「接管系统壁纸」让位的瞬间；③ `before-quit` 锚点补写完成之后
  （锚点那一笔又会踩空，必须还回去）；
- 新增 `tools/test-slideshow-guard.js` 14/14（临时目录隔离，不碰真实 APPDATA）。

### 验证

slideshow-guard 14/14；wiring 43 / scheduler 162 / live 72 / particles 52 /
resume 28 / swipe 28 / video-optimize 14 / portable-path 11 / fs-watch 43 全绿。
**注意**：本次用户的 slideshow.ini 已经被踩空且守卫还没跑过第一次快照，所以
**需要在个性化里重新选一次幻灯片相册**；此后守卫接管，退出/让位都会自动救回。

## 第五十八轮：熄屏检测判死刑 —— 拔电暂停改 GetSystemPowerStatus 直查

### 现象：屏幕关闭事件真机收不到

57 轮之后继续推进「熄屏毫秒级暂停」：displayWatch 三件套（worker 线程隐藏窗口 +
RegisterPowerSettingNotification + POWERBROADCAST_SETTING 解析）全部写完，
koffi 一串坑（proto 参数顺序 / GUID 结构体 / register 回调 / worker terminate 挂死）
逐个排掉，worker 注册成功（READY 315ms）、优雅退出也通了。但**真机手动熄屏
监听 3 分钟，零事件** —— `GUID_MONITOR_POWERED_ON` 压根不对普通窗口投递
（只给系统电源管理器/服务用），SC_MONITORPOWER 广播同样收不到。

### 决定（用户拍板）

「要不就监测拔电池好了」—— 放弃熄屏事件检测，电池供电检测就够了：
平板耗电的根因是「拔电后还在跑」，`pauseOnBattery` 修的正是这个。

### 改动

- **拆掉 displayWatch 整条链**：`displayWatch.js` / `displayWatchWorker.js` /
  `displayPowerCodec.js` / 单测 / 真机探针 / main.js 接线（start/stop/getFlags）/
  设置面板复选框（`cfg-pause-display-off`）/ store 键 `pauseOnDisplayOff`，
  全删。`evaluatePause` 移除 displayOff 参数（reason 集合回到
  away/idle/battery/fullscreen 四种）；
- **电池检测换成 koffi 直查**：`fullscreenWatch.isOnBattery()` 走
  `kernel32!GetSystemPowerStatus`（12 字节结构体一次同步调用，ACLineStatus
  0=电池 1=市电 255=未知不瞎猜），**无窗口无线程，不依赖任何系统消息投递**
  —— 熄屏事件收不到的教训就是别赌消息能到。查不到再退回
  `powerMonitor.isOnBatteryPower()`。轮询 2s 一拍，拔电 2 秒内冻结、插回恢复；
- 顺手修一个存量 bug：`sample()` 用了 `GetWindowThreadProcessId`（54 轮追记四
  QQ 排除引入），但 `load()` 里**从未注册**这个函数，全屏暂停真机 e2e 一直在
  这里炸（单测是纯函数吃假数据，测不出来）；
- README 配置示例补上 57 轮的 `pauseOnIdle` / `idlePauseMinutes`；设置页
  提示文案同步（「用电池」直接读系统电源状态，不再提系统电源事件）。

### 验证

fs-watch 43/43（§9 重写为电池：触发/开关/恢复/优先级压过全屏/真机 isOnBattery
不炸）；fullscreen-pause 真机 e2e 12/12（修复后首次全过）；wiring 43 /
scheduler 162 / live 72 / particles 52 / resume 28 / swipe 28 / video-optimize 14 /
portable-path 11 全绿。平板真机拔电冻结待验收。

## 第五十七轮：托盘可让出系统壁纸（修 Windows 幻灯片被踩）+ 挂机/熄屏自动暂停（修平板合盖耗电）

### 问题 1：关掉软件后，Windows 个性化的幻灯片放映切不动

**根因（本机取证）**：「关窗口」不是退出 —— `closeToTray` 默认开，进程还活着，
调度器每个间隔照写系统壁纸（IDesktopWallpaper）。每次写入都会把个性化里刚选的
「幻灯片放映」打回「图片」模式并**清空 slideshow.ini**（本机 `%APPDATA%\Microsoft\
Windows\Themes\slideshow.ini` 实测 0 字节，进程列表里实例活着）。真正的退出要托盘
右键 →「退出」。

**改动**：
- 托盘菜单新增勾选项「接管系统壁纸」：关掉 = 让位，本程序停止写入系统壁纸，
  Windows 幻灯片随便选随便切；动态桌面 / 预览 / 手势等其余功能照常。让位与收回
  都有气泡提示（收回时会覆盖幻灯片，明说）。

### 问题 2：MateBook E 合盖熄屏后还在跑，几小时把电池跑光

**根因（两层）**：
- 挂机判定用的 `SHQueryUserNotificationState`（QUNS_NOT_PRESENT）只覆盖
  **锁屏 / 屏保** —— 平板「合盖 = 仅熄屏」不锁屏不睡眠，QUNS 照常 RUNNING，
  代码注释里写「息屏」是错的（本轮修正）；
- 暂停轮询此前**随动态桌面启停**，静态系统壁纸模式下整条电池/挂机暂停链路
  根本没在跑。

**改动**：
- `evaluatePause` 新增 idle 判定：无输入 ≥ `idlePauseMinutes` 分钟也算「人离开」
  （reason='idle'），动一下输入立即解除。熄屏 = 无输入，天然被兜住；
- 暂停轮询**常驻**（不再随动态桌面启停）：静态壁纸模式的平板同样吃到
  电池 / 挂机暂停（`scheduler.isFrozen` 钩子本来就常装，这次链路才真正通到它）；
- 新配置 `liveStage.pauseOnIdle`（默认开）/ `idlePauseMinutes`（默认 5，0~120）；
- 设置「系统」页新增 UI：挂机暂停开关 + 3/5/10/15 分钟档 + 电池暂停开关
  （pauseOnBattery 默认开但一直没有 UI，一并露出）。

**验证**：test-fullscreen-watch 37/37（新增 §8 七项：超阈值触发 / 未超不触发 /
阈值 0 关闭 / 显式关开关 / 锁屏并存时 reason 归属 / 旧调用方兼容 / 恢复解除）；
wiring 43 / scheduler 162 / live 72 / resume 28 / swipe 28 / particles 52 /
video-optimize 14 / portable-path 11 全绿。托盘勾选、平板实际耗电待真机验收。

## 第五十六轮：视频省电优化出按钮 —— 设置面板可开关、目标帧率三选一

### 背景

视频优化转码（追记：60fps→30fps 副本缓存，解码负载约减半）一直只有
配置键 `videoOptimize` / `optimizeTargetFps`，**设置面板里没有任何 UI**，
用户想关/想改帧率只能手改 config.json。本轮补上按钮。

### 改动

- 设置面板「轮播」页新增「视频省电优化」字段块：
  - 总开关 checkbox（`cfg-video-optimize`）：关掉后永远播原件，
    已生成的副本保留（重新打开可继续用）；
  - 目标帧率分段选择（`cfg-optimize-fps`）：降到 30fps（推荐）/ 降到 48fps。
    **故意不做「60fps=只转码不降帧」**：解码负载一点不省还白吃一次
    重编画质损失，没有存在意义。
- `store.js`：`optimizeTargetFps` 落盘前钳位，只认 30/48，其余回落 30
  （null/undefined 删键走默认）；顺带导出 `normalizeConfig` 供单测。
- `videoOptimize.js`（关键防线）：
  - 转码入账时记录 `targetFps` 到索引条目；
  - 缓存命中时校验 `copyMatchesFps(entry, targetFps)` —— 帧率策略变了
    旧副本不直供，照常重转覆盖。**指纹 = 路径|大小|mtime 不含 targetFps，
    不加这道校验的话改帧率等于白按**。老条目没记 targetFps 视为一致
    （升级不触发全量重转）。

### 缓存目录路径的结论（本轮讨论记录）

`optimizeCacheDir` 维持默认 `D:/video-optimize-cache` 不动：
放进项目仓库会污染 git（40GB 上限的缓存目录）；userData 在 C 盘
不符合「缓存走 D 盘」的约定；现状与安装形态解耦。配置键本来就可改。

**验证**：新增 tools/test-video-optimize.js 14/14（copyMatchesFps 8 项 +
normalizeConfig 钳位 6 项）；wiring 43（字段块 26→27 + 新控件归属断言）/
scheduler 162 / live 72 / resume 28 / swipe 28 / particles 52 / fs 30 /
portable-path 11 全绿。UI 实际点击待真机验收。

## 第五十五轮：portable 版两个断点 —— 托盘「重新启动」直接退出 + 开机自启失效

### 现象：用户用 0.2.0 portable 包验收

1. 托盘点「重新启动」没有反应，应用**直接关闭**、不再拉起；
2. 勾了「开机自启」，重启电脑**不启动**。

两个症状都只在 portable 形态出现（NSIS 安装版与开发模式无此问题）。

### 根因：portable 是自解压形态，`process.execPath` 指向 %TEMP% 临时副本

portable exe 启动时把自己解包到 `%LOCALAPPDATA%\Temp\<随机>.tmp\` 再运行里面的
副本 —— `process.execPath` 拿到的是**临时副本的路径**，退出时启动器会把整个
临时目录删掉。于是两处按 execPath 写的代码同时翻车：

- **重新启动**：`restartApp()` 的 `app.relaunch({ args })` 不传 `path`，默认
  relaunch `process.execPath` —— 等当前实例退出、启动器删完临时目录，重启目标
  已经不存在了。用户看到的就是「点了没反应、直接退出」。
- **开机自启**：`setLaunchItemSettings({ path: process.execPath })` 把**临时
  路径**写进 Windows 启动项 —— 路径开机即失效（而且每次解包目录名都不同），
  「勾了自启但开机不起」。

### 改动

- 新增 `src/portablePath.js`（纯函数，不碰 Electron，可 plain-node 单测）：
  从 portable 启动器注入的环境变量解析**原始 exe** 的真实路径 —— 依次尝试
  `PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_FILENAME`（不同版本命名
  不一），兜底 `PORTABLE_EXECUTABLE_DIR + PORTABLE_EXECUTABLE_APP_FILENAME`
  拼路径；每个候选用 `existsSync` 验证，全都解析不出返回 null（宁可回落
  execPath 也不瞎猜）。
- `main.js` `restartApp()`：portable 下 `app.relaunch({ path: <原始 exe> })`
  显式指向原始 exe；非 portable 行为不变（path 走默认）。
- `tray.js`：新增 `launcherPath()`；`setLaunchAtLogin` / `getLaunchAtLogin`
  的 `path` 用它回落 execPath —— portable 下写进启动项的是原始 exe，重启
  匹配状态也不再拿临时路径对不上号。
- `main.js` `tray:state` 的 `loginCommand` 展示同步改用 `launcherPath()`，
  设置面板里看到的自启命令与实际写入的一致。

### 验证

- 新增 `tools/test-portable-path.js`（11/11）：非 portable 形态返回 null、
  FILE/FILENAME 命中与优先级、路径不存在不采信、DIR 兜底拼接（带/不带
  扩展名）、只有 DIR 不猜。
- 纯 Node 基线全绿：wiring 42 / swipe 17 / particles 52 / fs 30 / scheduler
  162 / live 72 / resume 28。
- **待用户验收**：重新打包 portable 后实测 ① 托盘重启真的拉起新实例；
  ② 重新勾一次「开机自启」（旧版本写入的启动项指向已失效的临时路径，
  勾选操作会用新路径覆盖写一次）。

### 追记（触摸横扫不生效 + 端到端实证）

**现象**：用户验收「触摸屏左右滑动切壁纸」没生效。排查期间确认本机无触摸屏
（`GetSystemMetrics` 触点数 = 0），遂改用合成输入做端到端实证。

**实证链**（全部有日志/落盘证据）：
1. `tools/tmp/probe-touch-swipe.js` 16ms 采样：真实鼠标按下时
   `GetAsyncKeyState(VK_LBUTTON)` 置位、桌面点根类 = Progman ✓；
2. `tools/tmp/sim-desktop-swipe.js`（SendInput 合成按下+横拖+松开）→ 独立
   跑 `swipeWatch` 的 e2e 脚本两次 `[FIRED]` ✓；
3. 对**用户正在运行的实例**模拟横扫 → `playback.json` 主屏 index 252→251
   （prev 方向正确）、`at` 时间戳与模拟松手秒级吻合 ✓ —— **鼠标路径端到端是通的**。

**根因（触摸）**：代码原假设「触摸由系统合成鼠标输入，VK_LBUTTON 照常置位」
在 Win8+ 不成立 —— 触摸走 WM_POINTER 消息级合成，不更新异步按键状态，
轮询层在触摸下看到的是「从未按下」，手势从第一步就进不去。该假设因本机无
触摸硬件当初就没法实测，属于裸奔上线。

**改动**（src/swipeWatch.js）：
- 新增**触摸兜底**：未按下时持续采集光标轨迹（只采桌面点），`evaluateFlick`
  纯函数判定「快速横扫」（窗口 300ms、最短持续 40ms 防瞬移、位移/直度复用
  evaluateSwipe）；**只在检测到触摸硬件的机器启用**（SM_MAXIMUMTOUCHES > 0，
  查一次缓存），纯鼠标机器行为零变化；
- 修掉死代码：`getEnabled` 一直只接线从没被读 —— 设置里的手势开关是摆设；
  现在每拍现查，关闭时清空轨迹与按压状态；
- `_setTouchOverride` 测试钩子 + `tools/tmp/sim-touch-flick.js`（无按键纯
  光标滑动模拟触摸形态）：强制开启兜底后 prev/next 各触发一次、方向正确 ✓；
  鼠标路径回归 `e2e-swipe-standalone` `[FIRED]` ✓。

**验证**：swipe 单测 28/28（新增 flick 10 项）/ wiring 42 / portable-path 11 /
scheduler 162 / live 72 / resume 28 / particles 52 / fs 30 全绿。
**待验收**：在有触摸屏的机器上装新版实测触摸横扫；若仍不生效，先跑
`tools/tmp/probe-touch-swipe.js` 看触摸按下时光标是否跟随（触摸不带动光标的
机器需要另走 WM_POINTER 路线）。

### 追记二（sim 脚本 INPUT 布局坑）

`SendInput` 的 INPUT 结构（x64）：type(4)+pad(4) 后是 MOUSEINPUT =
dx(+8) dy(+12) mouseData(+16) dwFlags(+20)。首版把 dwFlags 写到了 dx 位置 ——
SendInput 照单全收**不报错**，实际只是把光标挪了 2px，等于没按，且表现为
「脚本说成功、系统没反应」。教训：手写二进制结构先验证一遍再下结论。

## 第五十三轮：统一模式画面形态（跨屏拼一幅/每屏同一幅）+ 粒子 UI 互斥 + 暂停联动粒子与按钮

### 现象：用户三连反馈

1. 「统一配置」我本来想要的是**每块屏各自显示同一张壁纸**，不是拼成一幅——
   不过拼幅效果意外的棒，也想留着。「写入目标显示器」选了没反应。
2. 粒子特效全局关了屏上还在动（其实是每屏覆盖 random 在起作用）——对新手不友好，
   全局和按屏两套入口要有**互斥**；切每屏模式时希望有个指路提示。
3. 点了暂停粒子还在飘（想要也停）；全屏自动暂停时工具栏按钮图标没跟着变。

### 定性与决定

- 「写入目标显示器」（config `monitor`）只作用于**系统壁纸层**（写入哪几块屏的
  静态壁纸），动态桌面开着时画面全由舞台窗口绘制，切它当然无感 —— 提示文案写明。
- 画面形态做成双选项 `liveStage.unifiedSplit`：`span` 跨屏拼一幅（默认，保留）/
  `per-display` 每屏同一幅（新增）。展开逻辑进纯函数 `stagePlan.expandUnifiedChannel`：
  伪频道 id 带 `::d<displayId>` 后缀防 stages Map 撞 key、`_displayId` 让 stageBounds
  直达 Display（displayForMonitor 按尺寸匹配，同尺寸双屏会全部落主屏 z-fight）、
  保留原 channelId —— stage 渲染端按 channelId 过滤 tick，同一频道的每块舞台
  吃同一拍，调度器零改动。
- 粒子 UI 互斥：全局控件加 `unified-only`（每屏模式下收起），每屏模式给指路
  字段；首次切每屏弹指路弹窗（含「下次不再提示」，存 `hintParticlesPerMonitor`，
  进 UI_ONLY_KEYS 不惊动调度器）。数据模型不动：卡片「跟随全局」的屏仍吃全局值。
- 暂停联动：手动暂停（频道 playing=false）→ `liveStage.applyManualPause` 下发
  `stage:pause` 冻结舞台（**粒子也停**），但**不藏窗口**——用户只是要画面停，
  不是要让出桌面；自动暂停照旧按 hideOnPaused 藏。全屏/锁屏自动暂停态经
  `live:paused` 推给主窗口，工具栏图标同步显示暂停态（tooltip 说明自动暂停中）。

### 验证

- test-live-desktop 56 → **66**（§10 统一频道展开 10 项：span 透传/per-display
  展开/channelId 保留/_displayId/物理 monitor 形状/非统一频道透传/空显示器/
  脏输入/split 脏值默认）。
- scheduler 162 / particles 45 / resume 28 / wiring 39 全绿（wiring 字段块
  23→24、UI_ONLY_KEYS 期望同步更新）。
- 真机探针双形态：probe-unified-split.js per-display **VERDICT OK**（两块屏各挂
  一块舞台，bounds 精确盖各自屏幕，channelId 保留）；probe-unified-stage.js span
  复测 OK（3627×1707 并集）无回归。

### 追记（用户验收反馈后，同轮）

- 画面形态开关从「系统」页挪到**「轮播」页统一配置区**（形态是统一配置自己的
  事，跟相簿/间隔放一起更顺）。
- **撤掉「写入目标显示器」UI**（用户拍板「以舞台为主」）：config `monitor` 键与
  后端 resolveUnifiedTarget 保留兼容，只是没有入口了——它只作用于系统壁纸层，
  动态桌面开着时入口只会误导。app.js 三处接线（回填/refreshMonitorTargets/
  change）随之删除；wiring 字段块计数复核：撤一添挪总数仍 24。

### 追记（层级审计 + 重分类，同轮）

- **层级审计**（用户追问「写入目标显示器这类还有没有」）：逐控件核对消费者，
  实锤系统壁纸写入（win32.setWallpaper 写原图路径）不吃 fit/动画/视频/粒子/呼吸；
  无第二个失效控件。补准 5 处提示文案（过渡动画/填充方式/粒子局部/画面形态依赖
  动态桌面/视频只在舞台播）。
- **重分类**（用户拍板，按作用层归堆）：「视频播完再切」→「轮播」页（自动扫描
  下方，节奏类行为，始终显示）；「呼吸缩放」3 项 →「外观」页（填充方式下方，
  画面动效类，无每屏覆盖故始终显示）。系统页动态桌面块瘦身为纯接合开关
  （启用 + 暂停隐藏；fpsCap 以后接 UI 也归这）。
- 验证：wiring 39→**42**（字段块 24→**26** + 视频/呼吸/动态桌面三条 pane 归属
  断言）；live 66 / scheduler 162 / particles 45 / resume 28 全绿。

## 第五十二轮：暂停时隐藏舞台窗口（防独占全屏黑屏）+ 统一配置的动态桌面补齐

### 现象：艾尔登法环 6 连黑屏，用户对照实验定性

- 玩艾尔登法环必黑屏：突然卡顿 → 主屏失去信号 → 副屏画面冻结、游戏有声，
  只能强断电。事件日志 6×Kernel-Power 41（Bugcheck=0），无 TDR / WHEA /
  nvlddmkm 记录、无 dump —— GPU 显示管线挂死形态，非蓝屏非断电。
- 用户对照实验实锤：**独占全屏 + 壁纸程序 = 必炸**（主界面挂着都炸，连切
  无边框都来不及）；退壁纸程序 + 无边框 = 不炸；**开壁纸程序 + 无边框 = 正常游玩**。
- 机理：舞台窗口挂在桌面下、暂停只是停 rAF，手里始终攥着 4K flip 交换链；
  独占全屏接管显示器要做模式切换，DWM 在该屏被旁路 —— 带活动交换链的桌面
  窗口正好挡在驱动最脆的路径上。全屏暂停检测 2s 轮询，切换瞬间的间隙还在渲染。

### 决定与改动

- **暂停时隐藏舞台窗口**（`liveStage.hideOnPaused`，默认开，设置 → 系统 →
  动态桌面有开关）：`applyPauseState` 对暂停屏 `win.hide()`、恢复
  `showInactive()`——把交换链从显示路径里整个摘掉。画面留在原帧不重载；
  看门狗重挂尊重 `rec.hiddenForPause`，不把隐藏态在暂停中亮出来。
- **统一配置的动态桌面补齐**：`liveStage.syncTo` 此前按「width=0 跳过统一
  伪频道」处理（注释写着「阶段 2 再接」一直没接）——统一模式下动态桌面
  从未生效（用户实报「切统一配置舞台就没了」）。新增纯函数模块
  `src/stagePlan.js`：`virtualBounds` 算虚拟桌面 DIP/物理并集（混合缩放、
  负坐标屏都处理），统一频道建一块跨屏窗口；`isStagePaused` 统一舞台
  「任一覆盖屏被暂停即暂停」。
- `isChannelFrozen` 走同一判定；`stats()` 增加 `hiddenForPause` / `unified`。
- store.js 顺手清掉 `normalizeConfig` 里重复的 liveStage 收紧行。
- 设置面板「系统 → 动态桌面」新增开关（`cfg-live-hide-paused`），改设置
  实时生效（applyConfigChange 对 liveStage 键重启轮询读新值）。
- README（防护说明 + 配置键）、交接文档 11.1 同步。

### 验证

- 新增 `stagePlan` 纯函数断言 14 项（并集几何 7 + 暂停映射 7，含本机
  150%+100% 混合缩放、负坐标竖屏、away 优先、脏输入防御）：
  **test-live-desktop 42 → 56 项全绿**。
- 回归：test-scheduler 162 / test-particles 45 / verify-resume 28 /
  check-wiring 39 全绿；5 个改动文件语法过。
- 真机验收未做（用户正在游戏，探针会动真实桌面）：重启实例后需验收
  ① 统一配置下动态桌面出现 ② 全屏游戏时桌面画面消失、退出恢复。

### 追记（真机探针抓漏，用户实报「重启了还是没舞台」）

- 新增 `tools/tmp/probe-unified-stage.js`：隔离 profile 走真实 createStage +
  真实 mount 建统一跨屏窗口取证。首轮即抓到真凶——
  **`创建失败: 统一频道：枚举不到任何显示器`**：`stagePlan.virtualBounds`
  期望 `{width,height}` 扁平字段，而 Electron `Display` 只有 `bounds.width`
  （顶层 `width` 不存在），真实对象全被脏值过滤砍光返回 null。
  单测喂的是扁平假数据，恰好掩盖了这个形状差——纯函数单测绿 ≠ 真机能跑。
- 修复：stageBounds 统一分支把 `getAllDisplays()` 显式拍平成扁平方块再传入。
- 复测：探针 VERDICT OK——统一舞台挂载成功（strategy=progman），
  bounds `(-1067, 0, 3627×1707)` 精确覆盖双屏 DIP 并集，边框补偿 L10/R10/B10、
  裁剪区域 ok；回归 56 / 162 / 39 全绿。

## 第五十一轮：泡泡七彩膜 + 灰烬每粒一色 + 精简重复特效（14 → 12 种）

### 现象：用户两点反馈

① 泡泡想要「反射太阳光的七彩光芒」，且上升途中缓缓变大；② 有些特效重复，要求合并/删除。

### 设计决定

- **泡泡重做**：白色圆环 → 肥皂泡七彩膜——圆环拆 3 段弧、各占一个色相（相隔
  120°），色相随时间流转（8~28°/s）、起始角跟摆动相位慢转，膜面彩虹光在流动；
  加极淡白色填充当泡体 + 保留白色高光点；弧段留 18% 缺口才像膜不是环。
- **泡泡变大**：`grow`（0.15~0.4 px/s）持续长到 `maxSize`（初值 ×2.0~2.6，硬顶
  26px）封顶；飘出顶边回收时整体重置回初生小泡（复用 make），「长大 → 重来」
  天然循环。按升程估算（v 20~65 px/s），一屏 35~100s 途中肉眼可见地鼓大。
- **精简（拍板删两个）**：柳絮（与雪高度重复：同为白点+摆动慢落）→ 删；
  光粒（与萤火虫高度重复：同为慢速漂浮光点）→ 删。**老配置迁移走
  `TYPE_ALIASES`**（fluff→snow / dust→fireflies，clampType 内落地），
  不会静默变「关闭」。
- **灰烬全彩**：4 色橙红固定盘 → 每粒独立随机色相（全轮 0~360°，饱和度
  75~95%、亮度 55~70% 各自微抖），lighter 混合下重叠处混成流光。

### 改动

`src/renderer/particles.js`（PARTICLE_TYPES 14→12、TYPE_ALIASES、删
TYPES.fluff/TYPES.dust、bubbles 重做、embers 全彩）、`index.html` / `app.js`
（两处下拉删柳絮/光粒）、README（14→12 种 + 新观感描述）、交接文档 11.3。

### 验证

- `test-particles.js` 35 → **44** 项全绿：新增别名迁移 ×2、泡泡
  maxSize/grow/hue 区间、推进变大与色相流转（按 DT_MAX 钳位步长核对精确值）、
  maxSize 封顶、顶边回收重置、灰烬 30 粒 ≥24 个不同色。
- check-wiring 39 项全绿（下拉删项未触字段块期望）；渲染层语法 OK。
- 真机探针（probe-particles，12 种逐种取证）与观感：待用户重启验收。

## 第四十七轮：单屏/幻影屏治理 + 设置重排 + 卡片折叠 + 呼吸可调

### 现象：新电脑上「两个显示器」；设置越堆越乱

用户在只有一块屏的新电脑上跑免安装版，界面出现「显示器2」（无分辨率信息、
预览能切过去但不生效）；另提出设置面板五项整理需求。

### 根因与修复（幻影屏）

系统（IDesktopWallpaper）偶尔会枚举出「没有当前分辨率」的幽灵输出，频道建出来
预览能切但写入永不生效。`listMonitors()` 现在过滤掉无有效宽高/无设备路径的条目 ——
频道、徽章、卡片、托盘从此只认真屏；显示热插拔的动态增减本来就有（display 事件
触发 rebuild）。

### 其余四项

- **单屏治理（拍板：隐藏切换，单卡片）**：只接一块屏时隐藏「统一/每屏」切换
  （body.single-monitor CSS），refreshChannelInfo 自动落到每屏语义 —— 单屏下两者
  等价，且只有每屏语义显示器卡片才可编辑。
- **控件集中（拍板：集中到轮播页）**：「过渡动画 / 动画时长」从外观页、「粒子特效 /
  数量」从系统页，统一搬进「轮播」页（全局默认在显示器卡片之前；过渡动画/时长
  保持 unified-only——每屏模式下由卡片接管）。系统页的时段滤镜 UI 整体移除
  （timeOfDay 键与渲染端能力保留，暂不暴露）。
- **每屏卡片折叠（拍板：默认全折叠、记住状态）**：卡片默认只留头 + 相簿行 + 状态条；
  头部加折叠按钮（chevron），点「预览」自动展开对应卡片；状态记在
  `config.expandedMonitors`（UI_ONLY_KEYS，改动不触发频道重建），重进保持。
- **呼吸缩放可调（拍板：速度+幅度两条滑条）**：新 profile 键 `breathPeriod`
  （2000~15000ms，默认 6000）与 `breathAmplitude`（0.5%~5%，默认 ±2%），
  PROFILE_KEYS 15 → 17，stage.js kenTick 改由 cfg 驱动（BREATH 常量退役）。
- **释放内存旁显示缓存**：设置面板底部常驻「缩略图缓存 X MB（N 张）」，
  释放后附带主进程 RSS。

### 改动

`store.js`（PROFILE_KEYS/DEFAULTS）、`main.js`（listMonitors 过滤 + UI_ONLY_KEYS）、
`stage.js`（呼吸参数化）、`index.html`（轮播页特效区 + 呼吸滑条 + 删旧位 + mode-field id）、
`app.js`（折叠/预览展开/呼吸滑条/mem-label/单屏逻辑）、`style.css`（折叠样式）、
`tools/check-wiring.js`（字段块 23、归属断言 ×2、UI_ONLY 正则）。

### 验证

- check-wiring **38** 项全绿（+2 归属断言）；渲染层语法 OK；
  159 / 42 / 35 / 28 全绿。
- 观感与单屏行为未实测：等用户上机验收（尤其幻影屏过滤是否命中他那台机器）。

## 第四十八轮：性能优化周（平板供电场景驱动）

### 现象：性能三连问

用户把壁纸跑在华为 MateBook E 2022（平板，供电吃紧）上，要求「能做的都做」，
外加一条：全屏暂停时把「切图」也停掉。

### A. fpsCap 断线（bug 级，实锤）

`liveStage.fpsCap` 从未生效：profile 的 fpsCap 取的是**顶层** config.fpsCap ——
这个键根本不存在（真值住在嵌套的 liveStage 里），stage 拿到 undefined 永远跑默认 60。
用户的 30 形同虚设，舞台渲染量整整翻倍。修复：resolveProfile 里 fpsCap 回落
liveStage.fpsCap（每屏显式覆盖仍优先）。顺手清掉 store.js 的历史重复定义：
liveWallpaper/liveStage 双份 DEFAULTS、clampLiveFps/clampLiveStage 双份函数、
module.exports 重复导出 —— 全是「后定义生效」的暗坑。

### B. 静态画面停表

rAF 循环条件 `anim || currentEntry` 恒真（currentEntry 首帧后永远非空），
纯静态壁纸也在以刷新率空跑心跳。改为「有东西在动才续帧」：过渡中 / 视频壁纸 /
Ken Burns / 呼吸 / 粒子层任一开启；否则循环死掉，tick / showFrame /
applyChannelConfig / 暂停恢复都会 ensureRaf 唤醒。静态图 + 无特效 = 渲染心跳归零。

### C. 粒子画布 DPR 封顶 1

粒子不读文字，不需要 retina 精度。DPR 封顶 1 后填充率按 dpr² 下降
（150% 屏 −56%，2K 屏 −75%），观感只是边缘更柔。图层画布保持满 DPR。

### D. 雨/雪/水花批量绘制

alpha 归并 3 档、同档合并成一条 path：300 粒从 300 次 stroke/fill 降到 3 次。
fireflies/embers（逐粒闪烁）、樱花/落叶（逐粒旋转）保持逐粒绘制。

### E. 后台图层释放

过渡结束把被替换层的整屏 canvas 缩到 1×1（下次过渡由 canvasSize 重新分配），
每屏常驻省一块全屏物理像素缓冲（竖屏 4K ≈ 16MB）。

### F. 扫描缓存落盘 + 启动后台校准

大图库冷启动要扫完才出画面。每轮真扫后把清单原子落盘到 userData/scan-cache.json
（>10 万条的目录跳过）；下次启动先把上次的清单喂进 scanCache 立即建台出画面，
再由 drainRefreshQueue() 后台逐目录真扫校准，有变化（新增/删除）补一次 rebuild ——
索引按路径对齐，播放进度不跳；死图/坏图由 §24/§25 的既有兜底消化。

### G. 深度暂停：全屏/锁屏/电池时「停表不走针」

此前 stage:pause 只停渲染（rAF 取消），调度器照样走针、照样尝试写入。
48 轮：liveStage 新增 isChannelFrozen(channelId)，main 注入调度器；定时器到点
发现频道被冻结 → 不推进、不写入，1 秒后再看一眼，取消全屏后 ≤1s 恢复。
手动翻页不受影响。冻结只影响自己那块屏（与按屏暂停的既有哲学一致）。
**pauseOnBattery 顺带接线** —— 配置里这个键此前从未被读取：用电池时全停
（MateBook E 的核心诉求）。evaluatePause 纯函数加 battery 规则，默认关闭，
既有单测不受影响。

### 验证

- 纯 Node 全绿：test-scheduler 159 → **162**（新增 §30 冻结停表：冻结不推进不写入 /
  只影响自己 / 解冻 ≤1s 恢复）、live 42、particles 35、resume 28、wiring **38**。
- 真机探针：14 种特效逐种取证全绿（批量绘制后 rain=11512 等，阈值全过）、
  启动首帧探针 first-frame-ok（停表与后台层释放不影响首帧）。
- 量化收益待用户上机实测：任务管理器 GPU 占用（fpsCap 30 × 静态停表）与
  平板电池续航。

## 第四十九轮：抓到一个「从没启动过」的功能——暂停轮询漏挂

### 现象：最大化后胶片条仍前跳（48 轮修完深度暂停还跳）

用户实测（新版）：最大化程序，切回项目发现胶片条跳过了好几张——冻结停表没有生效。

### 根因：startFullscreenWatch() 定义了，却没有任何调用

`src/fullscreenWatch.js` 的判定算法本身完全正常（探针实测：最大化 → 窗口覆盖
100.0% → 2 秒内判定暂停、且只暂停那块屏；还原 → 2 秒内恢复）。
断的是**启动**这一环：`startFullscreenWatch()` 在 main.js 里被定义后从未挂上调用，
轮询从未启动，pauseDisplays 恒空——于是全屏/锁屏/电池/挂机四类暂停在生产里
**从来没有生效过**（阶段 3 写好那天起就漏了）。单测只覆盖了 watch 纯函数与
applyPauseState，「有没有人调它」没有测试，这就是漏网原因。

### 修复

- 启动（liveWallpaper 开）与动态桌面开关切换两处接线 startFullscreenWatch /
  stopFullscreenWatch；will-quit 的 stop 原本就有。
- `check-wiring` 新增防回归断言：startFullscreenWatch 调用数 ≥ 2（启动 + 开关）。
- 诊断利器留档：`tools/tmp/probe-fs-watch.js` —— 逐拍打印每屏最佳候选窗口的
  类名与覆盖率，最大化没触发时一眼看出差在哪。

### 验证

- 纯 Node 全绿：162 / 42 / 35 / 28 + check-wiring **39**（+1 接线断言）。
- 探针实测（用户配合三轮最大化/还原）：判定 100% 跟手——这正是「算法没病、
  病在没启动」的证据链。
- 观感终验：重启后最大化程序，该屏 ≤2 秒静止、还原 ≤1 秒恢复；另一块屏不受影响。

## 第五十轮：暂停体系的第二个断点——rec.displayId 从未写入

### 现象：修了 #29（接线）之后，最大化后胶片条仍然前跳

用户重启新版后复现。probe-fs-watch 证明判定链路完全正常（最大化 → 覆盖 100% →
2 秒内判定、只暂停那块屏），但暂停日志里出现反常一行：
`暂停：display=[3166080857] … 受影响频道=[无]` —— 被全屏的显示器上**没有任何
一块舞台认为自己在那**。

### 根因：createStage 从未把 rec.displayId 写进舞台记录

stageBounds() 算出了正确的 displayId（stage:bind 载荷用的局部变量 sb，所以
初始暂停态恰好是对的），但 rec 上这个字段**从项目第一个字节起就不存在**。于是：

- `applyPauseState` 给每块舞台发 `stage:pause` 时，
  `pauseDisplays.has(rec.displayId)` = has(undefined) = **恒 false** ——
  全屏时舞台收到的永远是 `paused:false`，Ken Burns 在全屏程序背后照常动画；
- 48 轮的调度器停表查 `isChannelFrozen` → 同样恒 false → 切图照常、胶片条照常跳。

### 修复与验证

- `liveStage.createStage` 补一行 `rec.displayId = sb.displayId`；
- `[tick-bus] tick` 日志补时间戳（排查 SAC2766 频道在复现窗口推进 107 次、
  节奏远快于 30s 间隔的次生疑点，下次复现有时间轴可对）；
- 纯 Node 全绿：162 / 42 / 35 / 28 + wiring 39。
- 观感终验：重启后最大化 → 该屏 ≤2s 静止、另一屏不受影响、还原 ≤1s 恢复。

## 第四十六轮：README 补全动态桌面与粒子特效，推远端，出包

### 现象：文档停在第二十五轮的时代，代码要见人了

用户拍板「可以推送了」并要求更新 README、跑打包脚本出一版。README 此前整个
动态桌面纪元（第 26 轮起）都没有记录。

### 改动

- README 新增「动态桌面与粒子特效」章节（14 种特效 / 随机模式 / 按屏覆盖 /
  烟花比例规则 / fpsCap 与暂停体系），目录、功能表同步；
  「配置文件」示例补齐动态桌面纪元的键：liveWallpaper / liveStage（fpsCap 与
  三个 pauseOn*）/ videoPlayFull / breath / timeOfDay / particles / particleCount；
  与同类工具的对比表更新定位（本地图库轮播器 + 动态桌面）与动态壁纸一行。
- 交接文档 11.7 #11 标记推远端完成。
- 本轮把本地 master 全量推送 Gitee（含粒子系统 / 黑屏修复 / 按屏配置 / 14 种特效 /
  烟花加码等 11 个提交），并以 git ls-remote 复核；随后跑 tools/build-exe.py 出
  安装包 + 免安装版。

## 第四十五轮：烟花按反馈加大加粗

### 现象：烟花不够显眼——炸得太小、火花太细（竖屏为例至少要占一半）

### 设计决定

- **半径锚定屏幕短边**：R = min(W,H) × 0.30~0.48（竖屏 1600 宽 → 半径 480~768，
  直径占屏宽六~九成）。以后不管什么分辨率的屏，烟花都按同比例占画面，不再吃分辨率亏。
- **火花初速按物理反推**：指数阻力下总位移 = v0·(1-e^(-kL))/k（k=0.9），
  取「外圈火花恰好飞满 R」反解 v0；内圈 0.35~1.0 倍掺匀填球。重力同步随屏幕缩放
  （min(W,H)×0.12），大烟花才有自然坠尾（柳树效果）。
- **看得清**：火花数 36~61 → 60~110；线宽 1.6 → 2.2；火花拖尾 0.02s → 0.05s；
  炸开闪光半径随 R（0.22R）；火箭上升尾迹 12 → 20px。

### 改动

- `particles.js` TYPES.fireworks：burst 半径/初速/重力/火花数/线宽/拖尾/闪光全部
  重参数化（见上），wait/rocket 阶段与 cap=5 不变。

### 验证

- 纯 Node 全绿：159 / 42 / 37 / **35**（particles）/ 28（resume）。
- 真机探针 14 种逐种取证全绿：fireworks 像素 3554 → **8574**（探针画布上直径已占
  短边六成以上；真机按短边比例放大）。
- 观感未实测：等用户重启验收。

## 尚未迁移的功能

- 文件监控（原版有 `file_check_timer` 自动感知文件被删）——
  目前靠手动「重新扫描」；因为是两万张级别的目录，用轮询不合适，
  真要做应该上 `fs.watch` + 防抖，且只监视频道目录本身
- 跨屏拼接墙纸（`SetPosition` 设为 span 模式）
- 图片库到 100k+ 规模时，整个列表常驻渲染进程内存不算优雅，
  后续可改成主进程持有 + 分页取用
- 「播放历史」列表：这一轮用胶片条取代了（能点回上一张，比翻列表更直接）。
  胶片条的顺序**就是播放顺序**：左边是刚看过的、右边是将要看的，
  「上一张」永远在左边一格，可以直接当历史读。
  原版 Python 还把历史**落盘**，所以重启后接着播没看过的 ——
  想跨会话继续的话，把 `played` 存成文件、在 `_rebuild` 里读回来即可
- 排除子目录（例如按目录名拉黑「垃圾桶」）—— 讨论过，还没做

## 关于 Tauri

已确认不做 —— Electron 版够用，不再为省 360 MB 引入 rustup + MSVC 构建链。

如果以后想上，只有一处要改：`win32.js` / `desktopWallpaper.js` 从 `koffi` 换成 `windows-rs`，
前端 `index.html` / `style.css` / `app.js` 和 `scheduler.js` 的调度逻辑可以直接平移。
## 深度视差壁纸（depth3d）第一轮（2026-10-08）

### 现象 / 需求

用户要求「正在查看的所有壁纸都自动带视差效果」——2D 插画伪 3D 化
（灵感来自开源项目 MoyuFloat：AI 深度 → 视差 + 法线光照）。

### 决定

- **深度离线按需生成**，不走浏览器端推理（transformers.js 首次要下载 50MB 模型、
  推理峰值和 ComfyUI 抢卡、坏缓存都是事故源；壁纸是「不能黑屏的东西」）。
- **缓存集中存放**（`userData/depth-cache`，可配 `depthCacheDir` 挪到 F 盘），
  绝不散落进相簿目录 —— 相簿在 Syncthing 同步范围内，sidecar 进去会同步垃圾。
  缓存键 = sha1(路径|mtimeMs|size)，图一换内容自动失效。
- **渲染进 stage 原生 WebGL 层**（不做 html 旁路）：暂停/挂机/fpsCap/TOD 滤镜
  全套基建直接联动。
- **调度器零改动**：渲染端拿 entry 后自己 `depthFor(path)`（IPC → depthService），
  有缓存即视差、没缓存先 2D 播、生成完 `depth:ready` 广播现场升级。

### 改动

- `src/depthService.js`（新）：按需生成 + 集中缓存 + 常驻 Python worker 管理。
  队列上限 64、单并发、单张超时 90s、空闲 10 分钟杀 worker 省显存（3070 Ti 还
  要跑 ComfyUI）；worker 连挂 3 次 → 功能静默降级（永远返回 null，壁纸照常 2D）。
- `tools/depth_worker.py`（新）：stdin 行协议常驻 worker，模型从本地目录离线加载
  （`--model`，默认指向 D:/workbuddy/tools/MoyuFloat/wallpaper/model，99MB 三件套，
  curl 直拉 —— 沙箱代理下 HF hub 元数据校验必炸）。输出走「.tmp + os.replace」
  原子落盘。⚠️ PIL 对 `.tmp` 扩展名推不出格式，save 必须显式 `format='PNG'`
  （冒烟测试实锤：FAIL ValueError: unknown file extension: .tmp）。
- `src/preload.js`：+`depthFor(path)`、`onDepthReady(cb)`。
- `src/main.js`：depthService.configure + `depth:lookup` IPC + ready 广播
  （主窗口与全部舞台都收，各自判定是否与当前帧相关）。
- `src/renderer/stage.html` / `stage.css`：+`#depthgl` WebGL 层（z-index 3，
  在 2D 图层之上、#tod 之下 —— #tod 补 z-index:4 让时段滤镜罩住视差层）。
- `src/renderer/stage.js`：+WebGL 单 quad 视差渲染路径：
  - 自动漂移（双频 Lissajous）+ 两盏巡游彩灯 + 鼠标临时接管（停 2.5s 淡回自动）；
  - 过渡：视差帧进/出统一交叉淡入（变换型动画只作用于 2D 层，不复刻到视差帧
    —— 视差自带运动，叠位移会晕）；视差→普通内容时旧视差层淡出让路
    （glFadeOutIfAny，html/video/2D 图三个路径都挂）；
  - Ken Burns 在视差模式下不叠加（双重运动会晕）；fpsCap/暂停照常联动；
  - profile 开关：`depthParallax`（默认**开**）/ `depthAmp` / `depthDrift` / `depthLight`。

### 验证

- **已实测**（无头 Chromium + mock window.wp，不与真实实例并存）：
  - stage.js 完整 GL 路径：取深度 → 纹理 → 视差+灯光 → 上屏，零控制台报错，
    截图画面正确；
  - ⚠️ 实锤坑：`UNPACK_FLIP_Y_WEBGL` 对 `createImageBitmap` 源不生效（Chromium），
    首测画面上下颠倒 —— 改为纹理按「v=0 图顶」上传 + shader 里翻 uv01.y，
    两条上传路径都确定；
  - worker 冒烟：模型冷启动 9.4s，热态 **1.1s/张**（2048 最长边，2048×1152 输出）；
  - 全部改动文件 node --check 通过。
- **未实测**（要用户重启应用看真机）：真实实例上的观感、GPU 常驻占用（预估 <2%）、
  全屏暂停联动、多屏双舞台。e2e 基线本轮未跑（避免与用户在跑的实例起桌面冲突），
  下轮补 `probe-depth` 探针回归。

## 深度视差第二轮：每屏独立暂停开关 + 文件日志（2026-10-08 深夜）

### 现象（用户真机反馈）

1. 视差「一张行一张不行」交替；
2. 双屏一块在跑全屏游戏，希望**分开设置**；
3. 主窗口左右滑动切图疑似消失；
4. VBS 启动丢 stdout ⇒ [depth]/暂停日志全部看不到（老坑复发）。

### 根因分析

- 「时好时坏」两个候选机制并存：①暂停语义按屏生效（fullscreenWatch 逐屏判
  coversWork），游戏盖住的屏冻结=视差停，焦点切出即恢复——与交替现象吻合；
  ②按需深度首次出场先 2D 后升级（冷启动 9.4s + 游戏抢 VRAM 会放大）。
  无日志无法定谳 ⇒ 先补日志再下结论。
- 滑动切图在 app.js 主窗口（els.stage 指针事件），本轮深度改动没碰 app.js，
  #depthgl 在桌面窗口且 pointer-events:none，不构成遮挡；app.js 相对 HEAD 的
  -315 行来自 60~72 轮（未提交、历史被啃），滑动代码块现存完好。疑为主窗口
  渲染层 JS 报错或用户在桌面（而非主窗口）操作，待用户确认。

### 改动

- `src/fullscreenWatch.js`：evaluatePause 增 `perDisplay` 覆盖
  （monitors[displayId].pauseOnFullscreen，undefined=跟全局；away 语义保持全局）。
- `src/main.js`：getFlags 组装 perDisplay（读 store.monitors）；+debugLog.init。
- `src/renderer/app.js`：每屏卡片加复选框「本屏被全屏窗口盖住时暂停」
  （data-field=pauseOnFullscreen，走既有 pushProfile → monitors[did] 持久化）。
- `src/debugLog.js`（新）：userData/logs/live-debug.log 文件日志（appendFile 静默失败），
  depthService.log 与 liveStage.applyPauseState 双写——VBS 丢 stdout 的诊断兜底。

### 验证

- 全部改动 node --check 通过；evaluatePause 纯函数段抽出后 8/8 断言过
  （覆盖开/关/跟全局/away 不受覆盖/空覆盖）。
- 未实测：真机（用户重启后观察）+ live-debug.log 落盘效果。

### 深度视差第二轮补丁：worker 编码 bug（2026-10-09 00:2x，实锤修复）

- **现象**：live-debug.log 首战立功 —— `[depth] 生成失败 … FAIL JSONDecodeError:
  Invalid \escape`，与成功记录交替出现（≈一半任务挂）。这才是「一张行一张不行」
  的主根因（全屏暂停只是叠加因素）。
- **根因**：depthService spawn worker 时继承 Electron 环境（用户桌面无 PYTHONUTF8），
  worker 按系统默认 cp936 解码 stdin。主进程写的是 UTF-8 JSON 行，GBK 双字节解码
  错位时**尾字节会吃掉 0x5C（反斜杠）**——JSON 里 `\\` 被吃剩 `\`，中文/日文路径
  变非法转义。字节排列不同，有的行吃得到有的吃不到 → 伪随机失败。沙箱测试没踩到
  是因为沙箱环境有 PYTHONUTF8=1（workbuddy 注入），掩盖了问题。
- **修复（双侧）**：worker `sys.stdin/stdout/stderr.reconfigure(utf-8)`；
  depthService spawn env 钉死 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`（双保险）。
- **验证**：模拟用户环境（剥掉两个变量，探针证实子进程 stdin=gbk）下，
  日文路径任务 DONE（0.9s/张，输出 202KB 正常）。修复前该路径必挂。
- 失败的任务不自动重试（丢弃），图下次出场 miss 会再入队 → 自愈。

### 深度视差第二轮补丁 2：首播升级被退场动画卡死（2026-10-09 00:25，真机「隔一张」定谳）

- **现象**：编码修复后生成 100% 成功（log 零 FAIL，缓存 5→22 张），但真机仍
  「隔一张才有视差」。
- **根因**：stage.js 的 depth:ready 升级处理器 `if (glActive || glState.anim …) return`
  —— 上一张视差的退场淡出（duration≈900ms）和本张 depth:ready（生成延迟≈1s）
  几乎同时到期；ready 抢在淡出结束前到达 → 处理器看到 glState.anim 直接放弃
  → 本张永远停在 2D。而 2D 图后面没有退场动画 → 下一张升级必然成功
  ⇒ **严格隔一张交替**。tick 间隔（60s）远大于竞态窗，交替完全由
  「上一张是否视差」决定，所以是规律性的不是随机的。
- **修复**：处理器改具名 tryDepthUpgrade，遇到退场淡出未完 → 250ms 后重试
  （等 glTick 自然收尾），不再放弃；稳态视差/GL 过渡进行中仍跳过。
- **观测**：新增渲染端→主进程文件日志通道（preload.stageLog → ipc stage:log →
  debugLog.dlog），stage 每拍 tick 记 depthFor hit/miss、升级成功/等待，
  与 [depth] 生成日志同文件可对时间线。
- 已 node --check；真机待用户重启验证。

### 深度视差第二轮补丁 3：slog 作用域 bug（2026-10-09 00:40，上一补丁的回归，实锤修复）

- **现象**：重启后壁纸彻底切不动了（上一补丁引入的回归）。
- **根因**：补丁 2 把 slog 定义在 init() 内部，却在顶层函数 showFrame 里调用
  → ReferenceError: slog is not defined，showFrame 在 depthFor 之后、上屏之前
  抛异常 —— 每张图都上不了屏。深度入队在炸点之前，所以 [depth] 生成日志照常
  （真机日志特征：有生成、无 tick 记录、仅 2 条 upgrade —— 与作用域完全吻合）。
- **修复**：slog 提升到模块顶层（showFrame 与 init 内处理器共用），删除 init 内
  重复定义。
- **快速切图的队列策略**：depthService pump 改 LIFO（取队尾）—— 短时间连切 N 张
  时正在看的那张插队先生成，积压的老任务等停下来再补（path 去重，不重复生成；
  上限 64 不变）。此前 FIFO + 单并发 + 4K 单张 5~30s，连切时最新一张要排在
  几十张后面。
- **其他快速切换保障（已有机制确认）**：渲染端 animToken 令牌——连切时旧 showFrame
  全部作废、最后一张赢；depth:ready 迟到广播按 path 对当前帧校验，过期即弃。
- **验证**：无头 Chromium + mock window.wp 同会话闭环：__stageLogs 捕获
  "tick hit demo.jpg"、控制台零报错、GL 视差渲染正常。
  ⚠️ 取证教训：agent-browser 会话被 SIGTERM 重置后 eval/截图打到 about:blank
  或残影页面（本次截图一度是昨天 8437 预览页的残影）——取证前必须先 eval
  location.href 验页面身份。

### 深度视差第二轮补丁 4：升级守卫顺序 bug —— 「隔一张」真正根因（2026-10-09 01:0x，实锤修复）

- **真机日志定谳**：升级成功的全部紧跟在「前一张是 2D」之后，失败的全部紧跟
  在「前一张刚升级成视差」之后 —— 严格交替指纹。
- **根因**：tryDepthUpgrade 第一行守卫 `if (glActive) return`（意图：已是稳态视差
  不用升）。但新图上屏时旧视差层要走 ~900ms 退场淡出，**期间 glActive 仍为
  true**——ready 在这个窗口到达就被第一行丢弃，补丁 2 的重试分支
  （`glState.anim && !anim.in`）排在它后面永远走不到。前一张视差 → 本张必丢
  （停 2D）→ 下一张前面无退场 → 必成功 ⇒ 严格隔一张。补丁 2 修的「放弃不重试」
  只是半截：重试分支本身到不了。
- **修复**：稳态判断改为精确比对 `glActive && cur.imgPath === payload.path`；
  其余 glActive 状态（退场淡出中）一律走 250ms 重试（上限 40 次=10s 兜底）；
  补回 depthFor 查询块（编辑事故自查发现 dp 未定义）与 await 后的过渡守卫。
- **验证**（无头 Chromium + mock window.wp，DOM 落日志跨 eval 稳定读取）：
  场景 a 图升级 → 切 b（退场窗口内 ready 到达）→ 日志呈
  「升级完成 a → tick miss b → 等视差层退场 0/1 → 升级完成 b」，两图全部升级、
  控制台零报错 —— 旧代码在 b 处必丢。
- ⚠️ 取证坑：agent-browser 会话中 eval 的 JS 世界在两次调用间会被重置
  （window 自定义变量读不到），**断言结果必须落 DOM（textContent）再读**；
  另遇 http.server 假响应 size=0（重开即好）与旧服务残留 8439（TaskStop 只杀
  外壳，python 子进程存活——按 netstat PID+镜像路径确认后处理）。

## 深度视差第三轮：启动黑屏防护 + 恢复被 60~72 轮重构删掉的功能（2026-10-09 01:2x）

### 用户真机反馈

1. 重启后桌面黑屏，要手动切换壁纸才出画面；
2. 「桌面手势切壁纸」（左右滑动切图）整个消失，设置里的开关也没了。

### 排查结论

- **手势切壁纸消失 ≠ 本轮深度改动**：对拍 HEAD 实锤 —— 60~72 轮（未提交、
  提交历史被 .git 啃食事故吞掉的那批改动）把 swipeWatch 功能整个删除：
  src/swipeWatch.js（270 行，54 轮的桌面手势轮询）、main.js 的 require/start/
  stop 三处接线、index.html 的「桌面手势切壁纸」开关、app.js 的读写 wiring。
- **更严重的连带发现**：startFullscreenWatch() 在当前工作区**没有任何调用点**
  （HEAD 有 3 处：boot / applyConfigChange(liveStage key) / 动态桌面开关分支）
  —— 即 60~72 轮之后**全屏/锁屏暂停系统整个没启动过**，第二轮做的每屏暂停
  开关也是死代码。日志里 boot 时段的「[pause] 暂停解除」实为旧实例 will-quit
  时 stopFullscreenWatch 的兜底解冻（时间线吻合）。
- 启动黑屏：静态分析未能完全定谳（bind 显示有跑、GL 失败会回退 2D），按
  「bind 显示撞上冻结被打断 + 首帧异常无回退」双重防护处理，并加渲染端
  错误上报，下次复现看 live-debug.log 直接定位。

### 改动

- **恢复 swipeWatch**（从 HEAD blob 提取，对象幸存）：src/swipeWatch.js 原样恢复；
  main.js 恢复 require/boot 启动/will-quit 停止 + UI_ONLY_KEYS 加 swipeSwitch；
  channelAtCursor 拆回 channelAt(pt) + 薄包装；新增 stepWallpaperAt(pt, dir)
  （桌面菜单用 dir=1 不变）；index.html「动态桌面」块恢复开关与提示；
  app.js 恢复读写 wiring。
- **恢复 fullscreenWatch 启动**：boot（liveWallpaper 开时）+ applyConfigChange
  的 liveStage-key 分支 + 动态桌面开启分支，共 3 处（60~72 轮删掉的
  setUnifiedSplit 不恢复 —— 该 API 已在此重构中移除）。
- **stage.js 防护**：glShowFrame 整体 try/catch（任何 GL 异常都回退 2D 不黑屏，
  原因落日志）；everRendered 标记 + setFrozen(false) 解冻自愈（一帧都没画过
  就强制重显当前 entry，不等 60s tick）；init 挂 window error /
  unhandledrejection → live-debug.log。

### 验证

- 全部改动 node --check 通过；mock 回归三条路径全绿（GL 直接管 / 2D 回退 /
  现场升级，零控制台报错）。
- 未实测（真机）：手势切图、暂停系统恢复后的全屏暂停、启动黑屏是否消失
  —— 等用户重启验证；黑屏若复现，live-debug.log 现在会记录渲染端错误与
  gl 失败原因。
## 深度视差第四轮：启动黑屏真根因——第 39 轮的 onResize 修复没移植到 live 树（2026-10-09 凌晨）

### 现象

重启后桌面黑一小段时间自己亮回来，且不是到了轮播间隔；用户两次反馈（第三轮的黑屏
防护只是兜底，没断根）。

### 根因

live 树在主树第 26 轮之前分叉，主树第 39 轮实锤的「启动 resize 作废首帧」修复
（onResize 手动 `++animToken` 再画进未点亮图层 → 首帧被静默丢弃）**从未移植过来**。
第三轮加的「解冻自愈」恰好把它兜住了（所以表现为黑一会儿自己好），本轮把主树修复
原样移植：onResize 改走 `showFrame(currentEntry, 1, false)` 本尊，保留 glActive 早退。

### 另：.git 事件损失盘点（本轮一并固化）

- master 提交历史完整（至第 59 轮追记 + README 7 连），feature/live-desktop ref 已恢复
  指向 a8e5a3d（与 master 同源）。
- 60~72 轮重构从未提交过：全部代码改动都在工作区，**0 行代码永久丢失**；丢的是
  「提交历史 + 60~72 轮的 CHANGELOG 记录」（后者本就未写）。
- 工作区 CHANGELOG 曾被旧版本覆盖（丢主树 26~59 轮记录 ~1200 行），HEAD 里有完整
  副本，本轮已合并回来。

### 验证

node --check stage.js 通过；真机重启黑屏窗口应从「10s 自愈」缩到首帧级。

## 深度视差第五轮：副屏首帧黑到下一次切换 —— wpimg 流无超时（2026-10-09 02:1x）

### 现象

第四轮 onResize 修复后主屏重启即显，但副屏要等下一次轮播切换才显示；哪块屏黑随机
（一次重启反过来）。且「显示的时刻恰好是切换时刻」，不是黑屏自愈。

### 根因

fetchBitmap 的 fetch() **没有超时**。启动期 wpimg 协议流可能被卡住且**永不返回**：
GL 分支在 glLoadLayer 里整个 await 挂死 → 不上屏、不报错、无日志（glFreeLayer/
回退 2D 全都走不到），桌面黑到下一个调度 tick 的 showFrame。主屏能显示纯粹因为
mount 期 resize 触发了 4 次重画（4 次里一次成功）；副屏只有 1 次机会，卡住就黑。
日志佐证：副屏 18:08:47.186 有唯一的 tick hit（showFrame 进入）后再无任何日志，
18:09:45 tick miss 即「等到的那次切换」。

### 改动

1. fetchBitmap 加 8s AbortController 超时 + 自动重开一次新请求，失败 slog 落盘
   （此前这类故障零取证）。
2. GL 接管时 2D 垫底（仅 animate=false 的启动/重显场景）：glLoadLayer 把原图位图
   一并带回，showFrame 先画进 2D 层再让 GL 淡入盖上（同内容交叉淡入无感知）；
   GL 万一画不出来，桌面也不再黑。真实过渡仍由 GL 全权交叉淡入。
3. glShowFrame 返回值从布尔改为 {ok, bmp, layer}；glFreeLayer 顺带关闭随层携带的
   位图（废弃路径不泄漏）。

### 验证

node --check 通过；真机重启观察两屏是否都首帧即显（含连续多次重启看随机性是否消失）。

## 深度视差第六轮：图层分割（2.5D 双平面）+ 深度梯度阻尼/位移钳制（2026-10-09 02:3x）

### 设计

用户拍板：在 MoyuFloat 单平面视差上增加 Layer Segmentation。单平面 uv 偏移的撕裂
是物理性的（源图没有「被前景挡住的背景」），抠出前景分层才能根治：

- 背景层 = 背景板（原图抠掉前景 + Telea inpaint 补全），视差幅度 ×1.0
- 前景层 = 原图 + mask alpha（Otsu 阈值 + 形态学清理 + 去碎连通域 + 高斯羽化），×1.35
- 露洞处显示背景板的修补内容，大角度不再拉伸出条纹；mask 羽化边让两层无缝，
  边缘穿帮顺带解决（比引导滤波更彻底）

### 改动

- `tools/depth_worker.py`：推理后顺带产出 mask.png + bg.jpg（按文件存在性交付，
  失败只 WARN 不 FAIL）；新增 depth_in 入参 —— 老缓存回填复用现有深度图，不重跑
  模型。cv2.imwrite 的 .tmp 扩展名坑改走 imencode（PIL 同款坑第二次踩）。
- `src/depthService.js`：缓存从单文件变三件套（<key>.depth.png/.mask.png/.bg.jpg），
  lookup 返回 {depth, mask?, bg?}；命中 depth 但缺 mask/bg 自动入队回填。
- `src/renderer/stage.js`：DEPTH_FS 增 uBG/uMask/uHasMask/uIsBG/uAmpScale，
  双平面模式画两刀（背景板→前景带 alpha 淡入合成）；glDrawPair 按层能力自动选
  双平面/单平面；**L1 一并落**：位移乘深度梯度阻尼（四邻梯度，与灯光法线共用采样）
  + 0.035 uv 钳幅兜底；旧缓存/无 mask 自动单平面，全链 fail-soft。

### 验证

- 三文件 node --check / ast.parse 通过。
- 真图端到端（F://壁纸 实测图 + 真模型 CUDA）：单张 layers 2.91s（含 cv2 冷启动），
  mask 3500×1967 前景占比 24.5%、羽化中间带 0.5%，背景板 554KB；旧缓存 depth.png
  （mode L 8bit 半分辨率）确认可作 depth_in 回填。
- 真机观感（穿帮带/大角度撕裂是否消失、双平面立体感）待用户重启验收。

## 深度视差第七轮：2.5D 双平面回滚，恢复单平面（2026-10-09 02:4x）

### 现象与决定

用户真机验收：2.5D 效果不如原单平面。回滚渲染端 stage.js 至第五轮（6bde461）
单平面版本；worker/service 的 mask+背景板生成侧改动**保留**（additive，不影响
渲染，为迭代版备料，缓存三件套继续积累）。

### 根因复盘（双平面为什么输给单平面）

1. **主犯：L1 深度梯度阻尼系数 40 太狠且殃及单平面** —— 深度边缘四邻差常达
   0.3~0.5，阻尼因子≈1/(1+40×0.4)≈0.06，位移几乎归零；而立体感主要来自深度
   边缘的前后相对位移 → 连原有效果都被砍平。
2. **从犯 1：Otsu 硬阈值 mask 对动漫图质量差** —— 大面积同色背景/人物与背景
   深度接近时 mask 脏（前景带洞、背景带块），双平面「贴纸撕裂」比单平面穿帮
   更难看。
3. **从犯 2：Telea 修补是糊斑** —— 前景占比 25% 时露洞处显示模糊色块。
4. **结构缺陷：前景整片同速率 1.35x** —— 前景内部无相对运动，「贴纸浮起」感
   不如单平面连续形变自然。

### 迭代方向（v2，见回复/后续轮次）

mask 质量（line-art 引导 / matting 细化）→ 修补质量（LaMa）→ 前景内分层或
mesh warp（前景内部形变）。渲染端在 v1 三件套素材质量达标后再重接。

### 验证

node --check 通过；grep 双平面符号清零。

## 深度视差第八轮：一步到位 —— POM 视线步进 + ISNet/LaMa 素材链（2026-10-09 10:0x）

### 市面调研结论（用户要求搜成熟开源项目）

- **DepthFlow**（BrokenSource，AGPL）：最成熟开源 2.5D，核心是 steep parallax
  （POM 视线步进）而非图层分层 —— 证明单图+深度图即可大角度无撕裂。
- **Tiefling**（MIT）：深度图边缘外扩压伪影的技巧。
- **SkyTNT anime-segmentation**（ISNet）：动漫角色 mask 社区标准（rembg 内置）。
- **LaMa**（advimman）：大洞修补标准；fashn-ai 镜像有 torchscript 版。
- 第六轮四根因（Otsu mask 脏/Telea 糊/贴纸感/阻尼砍效果）说明分层路线的坑
  全在素材质量 —— 本轮用成熟开源模型逐一替换。

### 改动

**worker（tools/depth_worker.py）**
- mask：Otsu → **ISNet**（isnetis.onnx 176MB，onnxruntime，软边直出），
  失败回退 Otsu。实测前景 10.6%（Otsu 是虚胖的 24.5%），CPU 推理 0.86s。
- 背景板：Telea → **LaMa**（big-lama.pt torchscript，hf-mirror 下载），
  失败回退 Telea。关键优化：①bbox 裁剪修补（洞外原样贴回）②LAMA_MAX_SIDE=768。
  试过动漫微调版 anime_manga_lama.pt（large FFC）——修补质量好但 3070Ti 上
  FFT 慢 10 倍（14s/张），standard 版 bbox 后 5s 级，定为首选（anime 版留作备选）。
- 深度图边缘外扩（Tiefling 技巧）：近景值吃进远景 2px，压渲染端轮廓拉伸。
- 单张稳态：**7.1s/张**（ISNet 0.9s + LaMa ~5s + resize），后台缓存回填可接受。
  onnxruntime CUDA provider 起不来（缺 cudnn9 独立安装）但 CPU 已够快，不折腾。

**渲染端（src/renderer/stage.js）**
- DEPTH_FS 重写：**POM 视线步进**（14 步 march + 4 步二分，借鉴 DepthFlow 思路，
  POM 为通用图形学算法）替代单步 uv 偏移 —— 前景挡住的视线停在前景表面，
  物理上不露洞，根除大角度撕裂；第六轮的深度梯度阻尼**彻底移除**（教训：砍立体感）。
- 分层模式：三件套齐（mask+bg 存在）→ 背景板（×1.0）+前景（×1.3）两刀，
  前景 alpha 用 ISNet 软边 —— mask 渐变处两层速率连续过渡（治贴纸感）；
  mask/bg 路径由 depth 路径按命名规则推导（零新增 IPC），旧缓存自动降级单平面。
- glLoadLayer 四纹理、glDrawPair、灯光法线照旧（uv0 四邻，省采样）。

### 验证

- node --check / ast.parse 通过。
- 真图端到端：mask=isnet 前景 10.6% 软边带 9.1%，bg=lama 221KB，稳态 7.1s/张。
- .gitignore 挡掉 tools/models/*.onnx|*.pt（~400MB 模型不进库）。
- 真机观感（撕裂是否消失、双平面立体感、ISNet 边缘）待用户重启验收。

## 深度视差第九轮：第八轮真机验收再次不达标，回滚并终止分层方向（2026-10-09 10:2x）

### 现象

用户截图：前景层把人物头部「贴」到旁边（双脸鬼影）—— ISNet mask 把两张脸都
圈进前景，LaMa 在洞里补出第三张脸，×1.3 速率差一拉当场精神分裂；另有限象：
切走再切回该图加载不出（疑四纹理×过渡峰值触发 GL 上下文丢失）。

### 决定

- 渲染端 stage.js 回滚至第五轮（6bde461，用户唯一认可版本）：单步 uv 偏移
  单平面，自动漂移+灯光+鼠标接管。
- depthService 停掉老缓存 mask/bg 回填（315 张 ×7s 空烧 GPU）。
- worker 三件套生成保留（新图顺带产出，成本可忽略，素材留档）。
- **分层路线（Layer Segmentation）宣告终止**：第六轮（Otsu+Telea）与第八轮
  （ISNet+LaMa+POM+速率渐变）两连败，根因是「图层分割的效果上限依赖
  mask 与修补双达标，而动漫壁纸（多人物/贴脸构图）恰好是两者最难的情形」。
  壁纸场景应回到 DepthFlow 证实的路线：单图+深度图+shader 视线步进。
- 后续若还要升级，唯一候选：正确移植 POM（只动 shader、不动素材链），
  且必须先出对比录屏验收再落库。

### 验证

node --check 两文件通过；双平面符号 grep 清零。

## 深度视差第十轮：DepthFlow POM 实时移植（C 路线），离线逐帧验收通过（2026-10-09 11:3x~12:2x）

### 背景

第九轮终止分层后，用户确认社区方案 DepthFlow（AGPL，1.6k star）样片效果——
Circle 预设出片通过。给用户对比 A（离线视频壁纸：实测 1440p/8s 仅 3.4s 渲染、
1.1MB/张、首尾帧差 0.17 无缝循环）vs C（实时移植：保鼠标交互、零依赖零磁盘、
效果为近似复刻）后，用户拍板 **C 路线**，并按第九轮纪律先离线对比验收再落库。

### 移植内容（src/renderer/stage.js，未提交待真机）

- **DEPTH_FS 新增 uFlow 分支**（旧单平面路径原样保留，可回退）：
  - POM 两阶段步进 1:1 移植：粗探步长 1/85 overshoot + 细步回退 1/1100
    （iQuality=0.5 对应 CLI 默认 quality 50）；
  - shaderflow camera.glsl 投影：origin 在 z=0 按 zoom*isometric、target 在
    z=focal 按 zoom，与 z=1 面求交；
  - Circle 预设参数（intensity 0.5 / isometric 0.6 / steady 0.3，height 默认 0.20）；
  - `texMirror` 镜像重复采样 = 大角度露边时的边缘外扩。
- **glCamFlow**：8s/圈圆轨迹（cycle=(t/8)*2π，首尾无缝），鼠标接管平滑共存；
  lens/blur/vignette/colors 全默认关未移植。
- **cfg.depthFlow 默认开**，`profile.depthFlow: false` 一键回退第五轮。

### 离线对比验收（真机纪律，_tmp/depthflow-demo/flowtest/ 四脚本）

真图 + App 同款 worker 生成深度 → DepthFlow 原版渲 1280x720/8s 参考视频 →
无头 Edge 用**同一份 shader 源码**（从 stage.js 正则抽取，单一真源）逐相位渲染 →
5 相位帧差全部 ≈2.5（编码噪声级；垂直翻转对照 95+ 证明非碰巧）。
修复一个方向坑：DepthFlow offset 是 y 向上、shader 内 uv01 已翻 y 向下，
`negoff_y` 矩阵实验把带 y 相位帧差从 21 打到 2.5，glCamFlow 的自动漂移 y 取反
（鼠标 clientY 天然同轴不翻）。

### 踩坑记录

- harness 模板 `const SHADER = %s` 忘包反引号 → 整个 script 解析期语法错误，
  表现为**黑屏+无任何报错**（页面无错误 DOM）；node --check 抽取脚本定位。
- file:// 页面 fetch 本地文件被 CORS 拦：改 `<img>` 加载 + `--allow-file-access-from-files`。
- headless WebGL 截图要 `--headless=new --use-angle=swiftshader`。
- cv2 VideoWriter avc1 缺 OpenH264 DLL：PNG 序列 + imageio_ffmpeg（libx264）编码。

### 验证

- node --check 通过；5 相位离线帧差 ≈2.5（噪声级）；
- 并排对比视频 compare_loop.mp4（左原版/右移植，16 相位循环）用户已认可；
- 真机重启验收通过（用户 12:2x 反馈「效果很不错的」）。

## 深度视差第十一轮：流模式参数化 + 设置面板入口 + 深度派工瘦身（2026-10-09 17:4x）

### 背景

第十轮落库推送后收尾三件事：①depthFlow 只能靠 profile 手改，进设置面板；
②Circle 参数（intensity/iso/steady/height）写死在代码里，做成可调；③发现
depthService 仍在给每张新图派工 mask+bg（ISNet+LaMa 约 6s/张），而渲染端
（第五轮单平面 / 第十轮 POM flow）零消费 —— 纯浪费。

### 改动

- **stage.js**：`flowSample` 的三个魔法数（0.20/0.30/0.60）提升为 uniform
  （uFlowHeight/uFlowSteady/uFlowIso）；`glCamFlow` 幅度接 `cfg.flowIntensity`
  （鼠标接管幅度同源）；cfg 新增四个 flow 键 + applyProfile 接同名 profile 键。
- **store.js**：`PROFILE_KEYS` 补 depthParallax/depthFlow/depthAmp/depthDrift/
  depthLight/flowIntensity/flowIso/flowSteady/flowHeight —— 此前视差键在
  config 层写了也到不了 stage 的 profile（resolveProfile 只拷 PROFILE_KEYS），
  属潜在断链，本轮一并修通；BOOL_KEYS 补 depthParallax/depthFlow。
- **设置面板（index.html + app.js）**：新增「深度视差」区块 —— 总开关、
  DepthFlow 流动模式开关、流动幅度/漂移速度滑杆、进阶折叠区（斜视角/背景
  稳定/视差强度），改动即存即生效（config:set → rebuild → applyChannels）。
- **depthService.js**：新图派工只带 `out`（深度），不再派 out_mask/out_bg；
  worker 的三件套能力保留，复活分层只改 lookup 一处。

### 离线回归抓到一个真 bug

参数化首次跑对比即黑屏（diff≈100）—— shader 里用了 uFlowIso/uFlowSteady/
uFlowHeight 却没写 uniform 声明，GLSL 编译失败。**真机表现会是静默回退 2D**
（glInit catch 降级），用户根本看不出坏 —— 离线对比 harness（READBACK +
dump-dom 取 ERROR）当场揪出。补声明后重跑：5 相位帧差 ≈2.5（噪声级），
与第十轮基线一致，参数化未破坏数学。

### 验证

- node --check 四文件通过；
- 离线逐帧回归 5 相位 ≈2.5（噪声级）；
- 设置 UI 为真机验收项（面板开关/滑杆 → 桌面实时生效）。

## 深度视差第十二轮：深度空闲预取（2026-10-09 18:1x）

### 背景

深度是按需生成的（首次显示某图时后台生成约 3s，期间 2D 垫底）。用户反馈
希望把「第一次显示是平的」这几秒也吃掉 —— 调度器知道队列顺序，预取顺理成章。

### 改动

- **depthService.prefetch(entryPath)**：空闲预取入口。纪律三条：
  ①队列非空或 worker 忙 → 直接放弃（正事优先，下次 tick 再试）；
  ②已缓存 → 跳过；③入队走 enqueue（queuedSet 去重）。
  顺手补一道护栏：`currentJob.path === job.path` 时不再入队 —— 生成中的图
  被 lookup/prefetch 重复请求会排两次队（生成完覆盖写，纯浪费）。
- **main.js prefetchUpcomingDepths()**：挂在调度器 `tick` 事件（每次切图后
  触发），给每个频道取 `index+1..+2` 的条目，只认图片扩展名
  （jpg/jpeg/png/webp/bmp），喂给 prefetch。预取失败只 warn，不影响播放。

### 验证

- node --check 两文件通过；
- 离线纪律模拟：首次 prefetch 入队即被 pump 取走（busy）、busy 期间第二次
  prefetch 让路不入队、currentJob 护栏生效 —— 与设计一致
  （测试用的假 python ENOENT 崩溃是测试自身问题，非代码缺陷）。
- 真机验收项：切换若干张后，切到「之前预取过的图」应直接出视差（不再有
  2D 垫底的几秒）。

## 深度视差第十三轮：性能档位（流动质量 + 帧率上限）+ 暂停机制实测确认（2026-10-09 18:4x）

### 背景

用户问「还有什么性能可以优化的」。实测当前开销：视差渲染单屏 3D 引擎 ~25% GPU、
渲染进程 ~45%+24% CPU（30fps 下）。给方案后用户拍板 1（帧率上限）+2（POM 步数可调）。
顺带实测确认暂停机制：暂停生效期间全部 6 进程 3 秒 CPU 增量 = 0.0% —— 被盖住/
全屏时壁纸真正零开销（用户看到的「还在渲染」是设置窗口自己的预览画面，不属于冻结范围；
「倒计时在走」是调度器设计行为，冻结舞台由 tick 处理器 `if (frozen) return` 跳过新图）。

### 改动

- **stage.js**：`flowSample` 的步长魔法数（细步 1/1100、粗探 1/85）还原为 DepthFlow
  原式 1/mix(200,2000,q)、1/mix(50,120,q)，q 来自新 uniform `uFlowQ`
  （= cfg.flowQuality，clamp 0.15~1）；cfg 新增 flowQuality: 0.5（=CLI 默认）；
  applyProfile 接 profile.flowQuality。
- **store.js**：PROFILE_KEYS 补 flowQuality。
- **设置面板**：深度视差区块新增「流动质量」滑杆（0.2~1，默认 0.5）与
  「帧率上限」下拉（15/24/30/60，默认 30 = store 既有默认，此前 fpsCap 链路已存在
  但无 UI 入口）。改完即存即生效。

### 离线回归（flowtest harness，补 uFlowQ uniform 后）

- q=0.5：5 相位帧差 2.44~2.51 —— 与第十/十一轮基线一致，参数化未破坏数学；
- **q=0.3 / q=0.2：帧差 2.51 / 2.52 —— 与原版仍噪声级**（POM 收敛到同一表面），
  低质量档在本测试图上零画质代价；保守默认仍 0.5，用户可自行调低验证。

### 验证

- node --check 三文件通过；离线回归 q=0.5/0.3/0.2 全部 ≈2.5；
- 真机验收项：设置面板两个新控件生效（流动质量调低 → GPU 占用下降；
  帧率上限 15 → 任务管理器 GPU 明显下降）。

## 深度视差第十四轮：暂停语义修正——冻结期间轮播不推进 + 解冻补同步（2026-10-09 19:1x）

### 背景与根因（用户实测踩中）

用户反馈：桌面右键「删除当前显示器的壁纸」删掉的是**别的图片**。排查链：

- 菜单命令（注册表 DesktopBackground\\Shell）指向 live 树 exe，单实例转发正常，
  删除目标 = `scheduler.channels.get(光标所在屏).files[index]` —— 调度器的当前 index；
- 但冻结（最大化/全屏/挂机）期间 tick 全被 stage 的 `if (frozen) return` 拦掉，
  **调度器却照常推进** —— 桌面停在冻结前那张，index 已前进 N 张；
- 解冻后桌面最长憋 60s 旧图，期间右键删除删的是**从没显示过的图**。
  用户今天多次最大化 WorkBuddy（live-debug.log 三次 [pause] 均吻合），正好踩中。

### 改动（双层修复）

- **scheduler.js**：构造器新增 `isPaused(displayId)` 依赖；`_schedule` 的定时器
  到点先查暂停，被冻结的显示器**不推进轮播**，每隔一个 interval 空转重查，
  恢复后自然续播 —— 退出全屏看到的是进去时那张，index 与显示永远一致。
- **main.js**：把 `liveStage.isPausedForDisplay` 作为 isPaused 传入；
  **liveStage.js** 导出该方法。
- **stage.js**：解冻补同步（双保险）——恢复时 `listChannels → applyChannels`，
  若 index 与显示脱节（如老版本暂停期间已走拍）立刻补显当前张；
  applyChannels 自带「路径没变就不动」守卫，正常情况零开销。

### 语义变化

「暂停」从「画面冻着但后台照切」变为**真暂停**（轮播也停）。全屏退出后
不再跳图；系统壁纸写入/预取/删除等所有按 index 的消费者与显示保持一致。

### 验证

- node --check 四文件通过；
- 真机验收项：最大化 WorkBuddy 越过一次切换间隔 → 还原 → 桌面应仍显示
  冻结前那张（不再跳新图），右键删除删的就是看见的那张。

## 深度视差第十五轮：动效轨迹（Orbital/Dolly）+ 桌面右键「暂停/继续」（2026-10-09 19:4x）

### 改动一：动效轨迹（用户拍板「更多动效轨迹」）

- **shader（stage.js DEPTH_FS）**：补齐 DepthFlow 相机的 focus/zoom 两参数
  （新 uniform uFlowFocus/uFlowZoom）——focal = 1 - focus*height、射线矩形按
  zoom 缩放。Circle 参数（focus 0/zoom 1）下数学与旧版完全一致。
- **glCamFlow 重写**：返回 { off, iso }，三轨迹公式与 DepthFlow 官方预设 1:1
  （cycle=(t/8)*2π 无缝循环不变）：
  - circle —— offset=(cos,-sin)*amp，iso=滑杆（原样）；
  - orbital —— offset=(sin,0)*amp，iso=0.5·cos+0.75 动态摆动，focus 0.30/zoom 0.98；
  - dolly —— offset=0 纯推拉，iso=0.5·(1-cos)，height 0.30/steady 0.35/focus 0.35/zoom 0.95。
  鼠标接管逻辑不变（iso 不受鼠标影响）。cfg.flowStyle + profile.flowStyle +
  store PROFILE_KEYS + 设置面板「动效风格」下拉（class=select 暗色同款）；
  切风格时 app.js 自动把该风格的 steady/height 预设值写回滑杆。
- **离线对比验收（flowtest_styles.py，新 harness 支持 ?style=）**：
  Orbital 4 相位帧差 2.41~2.48、Dolly 2.46~2.59 —— 全部噪声级
  （v-flip 对照 94+）；Circle 回归 2.44~2.51 基线不变。
  （途中旧 compare harness 没设 uFlowZoom 默认 0 导致黑屏，补 uniform 后恢复——
  真机 stage.js 恒设 1，不受影响。）

### 改动二：桌面右键「暂停 / 继续壁纸」（用户要求，方便测试）

- **shellMenu.js**：新菜单项 key=pause（WallpaperSwitcherDesktopPause，
  arg=--toggle-pause-wallpaper，sortOrder 15）；已用 node 直接调 installItem
  装进注册表（命令指向 live 树 exe，与已装的「删除」同款；无需等设置面板手动装）。
- **main.js**：manualPausedDisplays 手动暂停集 + broadcastPauseState 统一广播
  （fullscreenWatch 每 2s 的自动暂停快照在合并并集，手动暂停不会被覆盖）；
  runDesktopMenuAction 加 case 'pause' → togglePauseAtCursor()：切光标所在屏，
  立即重广播 + notice 气泡。暂停语义与自动暂停完全一致：渲染冻结（GPU 归零）
  + 第十四轮的调度器不推进（isPaused 感知 liveStage.isPausedForDisplay，
  手动集自然并入）。stopFullscreenWatch 兜底解冻保留手动集。

### 验证

- node --check 五文件通过；离线三风格逐帧对比全绿（见上）；
- 真机验收项：①动效风格下拉三个选项实际观感（切风格即生效，滑杆值自动重置）；
  ②桌面右键「暂停 / 继续壁纸」：暂停后 GPU 占用归零、轮播停走，再点恢复；
  ③暂停状态下右键删除删的就是看见的那张（index 与显示一致的直接验证）。

## 深度视差第十六轮：桌面菜单路由 + 暂停 id 口径 —— 两个真机 bug 一次修（2026-10-09 20:xx）

### 现象（用户实测）

1. 右键「暂停 / 继续壁纸」：舞台**消失又瞬间加回来**，动画照转，暂停完全不生效；
2. 右键「删除当前显示器的壁纸」：删掉的不是正在显示的那张。

### 根因（两层，日志实锤）

- **根因一（路由，两个 bug 共同）**：单实例锁按 userData 分钥匙，而验货实例的
  userData 是 VBS 环境变量 `WP_USER_DATA=wp-live-userdata`；注册表菜单命令不带
  userData → 点菜单新起的进程拿**默认** userData 的锁 → 拿到了 → 自己成为完整
  实例：挂自己的舞台盖住原实例（=「舞台消失又瞬间加回来」），800ms 后把动作
  办在**将死的进程**上再退出，运行中的实例毫无感知（live-debug.log 全程 0 条
  manual/desktop-menu 记录）。删除落在新实例上 = 用它刚 rebuild 的 index 删 → 删错图。
- **根因二（id 口径，暂停链路）**：暂停集的口径是 Electron displayId（数字，
  fullscreenWatch 产出、liveStage 舞台判定都用它），而频道 id 是 IDesktopWallpaper
  设备路径（字符串）。第十五轮手动暂停把设备路径直接塞进暂停集 →
  `pauseDisplays.has(rec.displayId)` 永远 false；第十四轮的调度器 isPaused 感知
  同理（isPaused(ch.id) 传设备路径，对照集里是数字）—— **感知从未命中过**。

### 改动

- **shellMenu.js**：commandLine 追加 `--wp-user-data="<userData>"`（在 Electron
  主进程里从 app.getPath 现取；CLI 直装必须显式传 override.userData）；
- **main.js**：①锁之前解析 argv 的 `--wp-user-data=`（与 WP_USER_DATA 环境变量
  并列，新进程先换 userData 再抢锁 → 拿不到锁 → second-instance 正常转发）；
  ②monitorPathToDisplayId（设备路径→displayId，复用 liveStage 几何匹配 ±2px）；
  ③手动暂停集改存 displayId（unified 用 PAUSE_ALL 哨兵，广播时展开成全部舞台）；
  ④调度器 isPaused 依赖先换算再查（unified 频道用 anyDisplayPaused）；
- **liveStage.js**：导出 displayIdForMonitor / allDisplayIds / anyDisplayPaused；
- **tools/reinstall-desktop-menu.js**：三项菜单命令重装进注册表（带 userData），
  statusAll 核验 installed=true stale=false。（教训：node -e 内联脚本里的反斜杠
  路径会被 Git Bash 改写成 `D://`，必须用脚本文件跑。）

### 验证

- node --check 三文件通过；注册表三项命令核验一致；
- 真机验收（需重启验货实例加载新代码）：①右键暂停 → 舞台冻结、GPU 归零，
  再点恢复续播，且**不再出现舞台消失/闪回**；②暂停期间与播放中右键删除，
  删的都是看见的那张。

### 验证补记（同轮稍后）

- 重启验货实例后用注册表命令同款参数端到端触发：`[pause] 暂停
  display=[1998535732] {"1998535732":"manual"}` —— 手动暂停正确转发到运行中
  实例且以 Electron displayId 命中舞台（路由 + id 口径两层修复同时验证）。
- 再次踩实两条环境铁律：①自动化层注入 `ELECTRON_RUN_AS_NODE`（存在即致命），
  常驻启动必须走 `tools/launch-dev.py`（剔变量 + DETACHED_PROCESS + 日志落盘），
  直接 nohup electron.exe 会先以纯 Node 崩（`protocol undefined`）或被会话回收；
  ②提权命令疑似双执行会让「切换类」端到端测试连翻两次（暂停又恢复），验证
  结论要以日志条目为准，不能只看最终状态。
- 本轮死过一次实例，复现排查确认是测试工具误伤（幽灵执行 + timeout 击杀），
  重启后纯观察 55 秒稳定运行，非应用缺陷。

## 深度视差第十七轮：暂停真凶 = rec.displayId 丢失（历史修复被重建弄丢）+ 设置页补「暂停/继续」开关（2026-10-09 21:2x）

### 现象（用户复报）

1. 桌面右键「暂停 / 继续壁纸」还是没用；
2. 设置里没有控制「桌面右键暂停/继续」的开关吗？

### 根因

- **暂停无效真凶**：`createStage` 建的舞台记录 `{ win, hwnd, anchor, bounds, boundsPhys, degraded, fails, creating }`
  **从来没有 displayId 字段** —— `applyPauseState` 用 `rec.displayId` 对号入座拿到的是
  undefined，`pauseDisplays.has(undefined)` 恒 false，**任何暂停（全屏/挂机/手动）在舞台层
  从未生效过**。这正是 49 轮实锤修过的断点（0f4e8ba「修暂停体系第二个断点」），
  10-09 重建 live 树时该修复丢失，第十六轮修好路由+id 口径后才暴露出这第三层。
- 诊断盲区：切换动作只 console.log（GUI 子系统 stdout 接不住，dev.log 0 字节），
  live-debug.log 里看不到「一次点击翻两次」还是「舞台对不上」。
- 问题 2：第十五轮给 shellMenu 加 pause 菜单项时，设置页只补了 UI 的一半——
  `cfg-desktop-menu-next/delete` 有开关，pause 没补（shellMenu/statusAll/IPC 全都支持）。

### 改动

- **liveStage.js**：①恢复历史修复 `rec.displayId = sb.displayId`（0f4e8ba 同款）；②
  applyPauseState 诊断日志带 `stages=[displayId...] 命中=[true/false...]`——暂停集与
  舞台是否对上从此一眼可见；
- **main.js**：①togglePauseAtCursor/runDesktopMenuAction 动作落盘 dlog（入口 key、
  pausedId、手动集变化）；②uncaughtException/unhandledRejection 补 dlog 落盘
  （stdout 接不住，异常现场全丢的教训）；③before-quit 记退出原因（分辨托盘退出 /
  window-all-closed / 异常）；
- **stage.js**：setFrozen 实际变化时 slog「冻结（rAF 停）/恢复（rAF 续）」→ 经
  console-message 转发可见，渲染端是否收到 stage:pause 从此有据可查；
- **index.html / app.js**：桌面右键菜单设置补第三个开关 `cfg-desktop-menu-pause`
  （暂停 / 继续壁纸，图标两竖线），三处接线（事件绑定 / 状态回填 / 提示文案改三项）。

### 验证

- node --check 五文件通过；
- 端到端：注册表同款命令触发 → `[pause] 暂停 display=[1998535732] stages=[1998535732,532850581]
  命中=[true,false]` + `[stage] stage:pause → 冻结（rAF 停）` —— 舞台层冻结首次真机实锤；
- 诊断日志同时抓到测试命令幽灵双执行（20.8s 后多翻一次），状态以日志为准；
- 实例三连「安静消失」复盘：纯观察 3 分钟稳定存活（tick 正常），非应用缺陷，
  系测试命令抢锁/timeout 击杀连锁；另实锤 20:43:34 用户会话「动态桌面已停止」
  （用户在设置里找暂停开关时疑似关掉了动态桌面 → app 正常退出）；
- 注意：launch-dev.py 启动的实例 cmdline 是 `electron.exe .`，psutil 判定要认这个形态。

## 深度视差第十八轮：切相簿「没一起切」= 沿用旧进度序号 + 手动继续误清全屏暂停（2026-10-09 22:3x）

### 现象（用户报）

切换相簿后，桌面舞台观感上没跟着切。

### 排查（日志实锤）

- 22:08:56 用户把主屏相簿从「里世界」(4526) 切到「Anima-Random」(9703) → reason=profile
  重建 → channels:changed → 舞台 applyChannels **立即** showFrame 了新相簿的图
  （14:08:56 的 showFrame 脱离 30s tick 网格 = 非 tick 触发，实锤即时切换）。
- 观感问题的真因：重建时 `index = min(progress.index, max)` **沿用了旧相簿的进度
  序号 1921** —— 桌面只是「从新相簿中间继续轮」，用户看到的是又换了一张同类图，
  完全没有「切到了新相簿」的可见跳变。
- 顺带发现：21:43 手动「继续」把主屏的全屏暂停一并清掉后再没接上 ——
  fullscreenWatch 只在状态变化时回调，手动广播 [] 清空后 watch 的内部状态
  没变、不重发，全屏暂停静默失效直到下一次全屏翻转。

### 改动

- **scheduler.js**：①用 playedAlbum 判定「显式切换相簿」，切了就 index=0
  （随机模式下 = 洗牌后第一张）并清 played；②切换的频道 rebuild 后立即
  `_write(ch, 'album-switch')`（对齐 takeover 模式），stage / 系统壁纸 /
  playback.json 三路同步跳变；改间隔等普通 rebuild（albumId 未变）照旧续播。
- **main.js**：togglePauseAtCursor 广播前先 `fullscreenWatch.tickNow()` 取当前
  全屏/挂机暂停集再合并 —— 手动暂停/继续都不再误清全屏暂停。

### 验证

- node --check 两文件通过；重启实例后双屏轮播正常（playback.json 主屏=
  Anima-Random、副屏=涩不了一点）；切相簿跳变语义待用户真机验收。

## 深度视差第十九轮：深度缓存 LRU 上限 2GB + live 线转正（2026-10-09 深夜）

### 改动

- **depthService.js（LRU）**：缓存上限 2GB（实测 104KB/张，全库 ~2.5 万张 ~2.6GB，
  2GB 足够覆盖且防无限增长）；lookup 命中 touch mtime（LRU 使用信号）；生成成功后
  排一次超限检查（5 分钟节流 + 30s 错峰），超限按 mtime 从旧到新删到 90%；
  configure 支持覆盖 cacheLimitBytes，stats 带 cacheLimitMB。
- **live 转正**：①桌面 VBS（D:/Backup/桌面/壁纸切换器.vbs）改指 live 树 +
  `--wp-user-data=`（原版备份 _archive/壁纸切换器.vbs.bak-20261009）；②HKCU Run
  自启键 electron-wallpaper（主树，--hidden）→ electron-wallpaper-live（live 树 +
  wp-user-data + --hidden，原值备份 _archive/run-key-electron-wallpaper.bak-20261009.txt）。
  ⚠️ 再踩回传污染：heredoc 里写注册表回读显示成正斜杠，改用脚本文件
  tools/set-run-key-live.py（chr(92) 拼路径）写入并 EXACT_MATCH 核验通过。
- **第54轮结论**：主树「3s 兜底亮黑窗」是 53 轮首帧门控自留的回归；live 树无
  首帧门控（挂载成功才 showInactive），不存在该路径，不需移植。透明舞台
  （transparent）属增强非缺陷，暂不动。
- 遗留观察：今夜实例多次「无日志安静消失」（无崩溃转储/无事件/无 lifecycle 日志
  =外部硬杀或瞬时退出），与我的工具链启动方式的相关性未定罪；用户拍板不追。
  桌面 VBS 为最终入口，经验上该路径稳定。

### 验证

- node --check depthService 通过；重启后双屏 tick 正常、深度生成正常（缓存
  204MB 远低于上限，清理路径未触发——首次触发时会打「缓存清理」日志）。

## 深度视差第二十轮：主树 26~58 轮设置功能补全移植（呼吸参数化/粒子/暂停扩展/联动禁用）（2026-10-10 00:5x）

### 背景（用户复报）

live 树分叉早于主树 26 轮，此前只移植了视差线 —— 设置页缺一大片：呼吸速度/幅度
滑杆、粒子特效全家（种类/数量/绕开鼠标/每屏覆盖）、全屏暂停时隐藏桌面画面、
人离开/熄屏自动暂停、电池暂停。用户点名要回来。

### 移植内容

- **呼吸参数化（主树 47 轮）**：stage.js cfg.breathPeriod(2000~15000)/breathAmplitude
  (0.5~5) + kenTick 用 cfg（原 BREATH 常量弃用）+ store PROFILE_KEYS + 设置页两条滑杆。
- **粒子特效（主树 52/54 轮）**：particles.js 整文件（939 行，13 种粒子 + random）+
  stage.html #particles canvas（z-index:4，盖视差层、被时段滤镜罩住）+ stage.js 全套
  集成（cfg 六键/rollParticles/applyProfile 透传/rAF gate 内 frame/静态续帧条件/
  onResize/换图重抽/鼠标斥力）——鼠标斥力不走主树的主进程 30Hz 广播（live 舞台
  本就吃得到真实 mousemove，视差接管同源，本地直喂更简单）+ store PROFILE_KEYS
  （particles/particleCount/particleCursor）+ 设置页全局区块 + 每屏卡片
  种类/数量覆盖（null 删覆盖回落全局，'off' 显式关闭）。
- **暂停扩展（主树 48/57/58 轮）**：fullscreenWatch.js 整文件换主树版（idleSec
  无输入超时=人离开、isOnBattery kernel32 直查、QQ 截图按进程镜像名排除、
  GetWindowThreadProcessId 存量 bug 修复），**嫁接回 live 独有的 perDisplay 每屏
  pauseOnFullscreen 覆盖**（evaluatePause + tickNow 传参）+ 单测文件同步（25→43 例）；
  main.js getFlags 补 battery/idleSec/pauseOnBattery/pauseOnIdle/idlePauseSeconds
  （powerMonitor 新导入）；store liveStage 补 pauseOnIdle/idlePauseMinutes(0~120)/
  hideOnPaused 默认与 clamp；liveStage.js 补 setPauseHide + applyPauseState 藏窗/
  showInactive 恢复（主树 52 轮核心，53/54 轮首帧门控机械不移植——live 没有）；
  hideOnPaused 默认关（独占全屏游戏前手动勾，防驱动挂死）。
- **深度视差联动禁用（用户新诉求）**：总开关关 → 整块置灰（总开关自身除外）；
  DepthFlow 关 → 流专属项（动效风格/流动幅度/流动质量/进阶参数）置灰，漂移速度
  与帧率上限保留（单平面平移也吃）。depth-flow-only 类标记 + updateDepthDisabled
  （applyConfigToUI 回填后经 window.__syncDepthUI 重算）。

### 验证

- node --check 七文件全过；fs-watch 单测 43/43（主树版含 idle/battery/QQ 用例）、
  scheduler 159/0、live-desktop 42/0；
- 重启实例双屏 tick 正常、视差升级正常（upgrade 完成）；
- 待真机验收：呼吸滑杆、粒子种类（含 random 每图重抽）、绕开鼠标、
  拔电暂停（台式机无电池=isOnBattery 返回 false/null 不误触）、联动置灰。

---

## 第三十二轮：修复「装好包、建好相簿加好目录，一直卡在选择相簿页面」

### 现象

- 用户反馈：打包版安装后，设置好相簿（`D:/test/image`，23 张受支持图片，目录实际存在），
  首页却永远停在「还没有图片目录」空态页；相簿卡片显示「1/1 目录启用 · 未绑定屏幕」。
- 排查结论（配置实测定罪，非路径/权限/格式问题）：相簿保存了、目录也启用了，
  但统一频道的 `profile.albumId` 是空字符串、播放记录里 album 为 null ——
  **相簿从未被绑定到播放频道**，调度器按 `profile.albumId` 找不到相簿就返回 0 张图。

### 根因（回归）

- 历史提交 `bc4ab05`（54 轮追记九）曾修过同一个问题：空态按钮直弹目录对话框
  （`folder:pick` 自动建相簿并绑屏）+ 相簿页加目录后 `ensureAlbumBound` 自动绑定空屏。
- 重建功能分支时这两段逻辑丢失：空态按钮退化为只开相簿页（相簿页没有「绑定屏幕」的操作），
  `addDirsToAlbum` 只写 folders 不绑频道 —— 新用户从空态进相簿页新建相簿再加目录，
  必然形成「有相簿、有目录、但没绑定」的死局。已绑定过相簿的老配置不受影响，
  所以不是所有电脑都能复现。

### 决定与改动

- `src/renderer/app.js`：
  - 补回 `ensureAlbumBound(albumId)`：相簿没被任何屏幕用时绑给第一个空 `albumId` 的屏，
    绑完收起相簿页；所有屏都已绑别的相簿时不抢（不动现有配置），toast 提示手动绑；
  - `addDirsToAlbum` 收尾调用它，加完目录壁纸立刻出来；
  - 空态大按钮恢复直弹 `pickFolder(previewId)`（`folder:pick` 主进程侧自动建相簿并绑屏），
    无可预览频道时回落到相簿页。
- `tools/check-wiring.js`：+3 条接线断言（空态直弹 / 加目录即绑 / 只绑空屏不抢）；
  顺手修两条过时断言 —— 字段块计数不再钉死数字（改为页内数==全部数），
  `UI_ONLY_KEYS` 对齐四键现状。

### 验证

- node --check 通过；check-wiring **40/0**、scheduler **159/0**、testConfig 0 失败；
- 夹具复盘：`tools/fixtures/monitor-*.bmp` 是 gitignore 的生成型夹具，
  盘上被清后 `test-scheduler` 崩溃（ENOENT），`npm run fixtures` 重新生成即恢复；
- 绑定后闭环对拍：`pushProfile` → `applyChannelInfo` 尾部 `previewSignature` 变化
  → `loadPreviewChannel` 重取文件 → `els.empty.hidden = true` 空态自动收起。

---

## 第三十五轮：回答「新开发者克隆仓库能否一键打包」+ 主界面截图换回备份分支版

### 现象

- 用户问：换一个开发者，只用仓库里的代码和资源文件能完成打包吗？
- 排查结论：**不能** —— ①`models/depth-anything/*.onnx`（~99MB）r26 起 gitignore 不进库，
  且 ONNX 导出脚本从未提交过任何一棵树（落在仓外 depth-onnx-exp/），克隆后无模型也无导出工具；
  ②electron-builder 对缺失的 extraResources **静默跳过不报错**（r34 实锤，113MB 假正常包），
  新开发者会打出没有深度视差的包而毫不知情；③`打包exe.bat` 不带 `npm install`，
  全新克隆直接 npm run dist 会因依赖缺失出假包。

### 改动

- `tools/export_onnx.py` 入库（自仓外 depth-onnx-exp/ 移植并收口）：
  HF 模型目录支持 argv/环境变量 DEPTH_HF_MODEL_DIR 传参（默认本机历史路径），
  产物直接落 `models/depth-anything/`（打包源路径），删 68~72 行不可达死代码，
  测试图缺失时跳过比对（SKIP）而不是崩。
- `打包exe.bat` 加两道护栏：`node_modules\electron\dist\electron.exe` 不存在时先
  `npm install`（全新克隆自举）；ONNX 缺失时**打印获取方式并失败退出**
  （拷贝或 `python tools\export_onnx.py <HF model dir>`），不再静默出假包。
- README 打包章节补「深度模型不在仓库里（新机器必读）」条目。
- `docs/界面-主界面.png` 换回备份分支 backup/master-premerge-20261010（6e9c074）的版本
  （1920x1127 真实界面截图：双屏徽章+胶片条+番剧壁纸；live 重构时被换成 2133x1397 老图）。

### 验证

- 界面图：`git show 6e9c074:docs/界面-主界面.png` 导出目检确认后覆盖，两版本 byte 级 DIFFERENT（97871B vs 331203B）。
- 打包链自举推演：新机器 clone → 双击 bat → npm install 自举 → 模型缺失即明确报错并给出两条获取路径；
  模型就位后与 r34 流程一致（已实测出包 291MB + 冒烟全过）。

---

## 第三十六轮：深度模型打包自动下载（新机器零手工）

### 现象

- 用户问：模型不在仓库里，打包的时候能自动下载吗？
- 前情（r35）：bat 只做「缺失即失败+两条手动获取路径」，新开发者仍需手工准备 99MB ONNX。

### 决定（先验证再换源）

- 下载 HF 公开的 onnx-community/depth-anything-v2-small fp32（onnx/model.onnx，94.5MB），
  与现役自导出 ONNX 对拍（同图、同预处理）：输出名 predicted_depth、dims [1,392,700]、
  **CORR=1.0000、MAD=0.0/255（逐像素一致）**——r30「不换公开版」的顾虑系当时无实测数据，
  现撤销：公开版可直接当自动下载源，省掉自建 Release 托管。
- 两文件 SHA256 不同属正常（导出器元数据差异），数值层等价已实证。

### 改动

- `打包exe.bat`：模型缺失时自动下载——主源 hf-mirror.com（国内直连约 18MB/s），备源 huggingface.co；
  curl.exe（Win10+ 自带）优先、PowerShell Invoke-WebRequest 兜底；
  `certutil` SHA256 校验（afb6a5c2...）→ 原子 move 落位；
  失败回落 r35 的三条手动路径（浏览器下载改名 / 跨机拷贝 / export_onnx.py 自导出）。
- README 打包章节「新机器必读」条目改写为「深度模型自动下载（新机器零手工）」。

### 验证（真机全链）

- 移走本地模型后跑打包脚本：下载 5 秒 → SHA256 过 → 原子落位 → 构建出包
  `壁纸切换器-Setup-0.2.1.exe` 291,195,554B；包内 ONNX hash = afb6a5c2（下载版）、
  零 .py/.pyd、app.asar.unpacked 含 sharp/onnxruntime-node —— 全部达标。
- 坑实录：①Git Bash 直接 `cmd //c xxx.bat` 参数被吞（日志只有 cmd 横幅、1 秒假成功），
  须经 python subprocess 起 cmd；②经 bat 链启动的构建在 packaging 阶段卡死 8 分钟
  （electron 解包完 351MB 后零 CPU 零 IO 停滞，r34 直接 npm run dist 无此问题，未定罪），
  按 PID 树杀掉后清理 dist/win-unpacked.tmp 与 .lock（目录）残留，改走 npm run dist 完成。
  对外说明：用户双击 bat 不经本会话环境，卡死与 bat 无关，属 agent 会话环境问题。

## 第六十轮：顶栏快捷开关三枚 + Auto 搬到重新扫描旁（2026-10-13~14）

### 现象

- 深度视差/视频轮播/粒子这三个高频开关埋在设置页深处，每次切换要点开面板翻页。
- Auto（自动扫描）藏在设置页，与「重新扫描」按钮天各一方。

### 改动

- 顶栏 preview-badges 旁新增快捷开关组：视频轮播/深度视差/粒子三枚 SVG 图标 chip
  （on 态 accent 高亮），绑定当前预览显示器，走现成 pushProfile（PROFILE_KEYS 全覆盖），
  调度器零改动；粒子关=覆盖空串、开=有全局种类跟全局否则 random 兜底。
- 每屏卡片删 depthSwitch 块、轮播页删「视频轮播」块，设置页三块对应移除（配置跟显示器走）。
- Auto 独立 qchip 挪进 rescan-group（重新扫描旁），亮=autoScanMinutes>0，
  ▾ 菜单七档间隔；点外收起；灭→亮回落会话内记住的最近非零档。
- 过程坑三连：菜单 display:flex 类规则压过 hidden 属性（补 [hidden]{display:none} 全菜单受益）；
  Auto 搬进 rescan-group 后脱离快捷开关组的事件委托范围成死代码（单独挂 click+stopPropagation）；
  split-caret 菜单对齐改按 caret.offsetLeft 左缘对齐。

### 验证

- node --check、check-wiring 56/0、cfg-* 残留引用清零；真机三轮 UI 修复后可用。
- 修复过程中 discovered：.preview-menu 关不上与 Auto 点不动的根因均属上列坑，修后复测通过。

## 第六十一轮：RGB 引导滤波压 DA3 深度爬线（缓存 schema r6）（2026-10-14）

### 现象

- DA3 深度在背景纹理强边处「爬线」——引导滤波强度全开时背景画线被跟随进深度图，
  视差放大后侧面角色变形（用户反馈）。

### 根因与修法

- 前序 self-guided 版（已随三项回退）引导图用深度自身，纹理强边仍会爬。
- 本轮改 He et al. **外部引导**：引导图 = 原图亮度直缩到深度分辨率（fresh sharp 管线，
  避开 resizeSource 链 resize 语义坑），boxMean 可分离滑动均值（Float64 累加防量化）。
- 参数定版：eps 1600→2400（提高纹理/背景画线跟随门槛）+ strength=0.5 线性混合
  （q'=p+0.5(q-p)，误拉偏减半）。DEPTH_CACHE_SCHEMA r4→r6 全量失效重生成。

### 验证

- node --check x3、check-wiring 56/0；合成性质 4 场景（纹理不爬入 0.00/台阶保持/恒等）；
  真图 A/B 锐边占比 0.05~0.26% → ~0.00%（tools/depth-ab-test.js da3-gf 变体）。
- 用户真机验收：「比之前好，轻微锯齿可接受」—— 定版保留。

## 第六十二轮：冷开机探测超时一票否决 —— 45s + 自愈重探（2026-10-14）

### 现象

- 用户报：本机开机后壁纸切了好几张，全都没进深度视差。
- live-debug.log 实锤：10:36:32（开机启动时刻）一条
  「深度功能不可用 —— JS 引擎不可用（深度引擎线程被终止（probe-timeout）），
  且缺少 深度模型（models\depth-anything）」，之后整场零深度生成（depth-cache 当日零写入）。

### 根因

- 开机冷启动时磁盘风暴+杀毒扫描把 worker 线程里 require(onnxruntime-node/sharp)
  拖过 20s 探测超时 → 线程被 terminate → probe 判负。
- 而「缺少 深度模型」是 Python 回退引擎在找 model.safetensors（HF 权重，从未存在），
  纯误导性提示；真模型 da3_small.onnx/v2 onnx 都在盘上。
- 结构性缺陷：probe 失败 → Python 回退也缺 → enabled=false **一票否决到会话结束**，
  只有下次 configure（改设置）才重探，会话内永不自愈。

### 改动

- 探测超时 20s → 45s（真坏的情况 require 秒失败，不吃超时；放大无副作用）。
- 自愈重探 armProbeRetry：probe 失败且 ONNX 模型文件还在盘上 → 退避重探
  （30s 起每次 ×2，封顶 5 次；放弃只打一次日志，下次 configure 重置预算）；
  成功即恢复 js 引擎并 pump 排空 disabled 期间攒下的 miss 队列，视差自动追上。
- 测试钩子 WP_PROBE_RETRY_MS 可把退避压到毫秒级（沿用 WP_* 钩子惯例）。

### 验证

- 负向控制（WP_NO_JS_DEPTH=1 模拟探测必败）：5 次退避重探依次出现 → 放弃日志只一次 →
  再 configure 计数重置再来 5 次。
- 正向对照（真模型在盘）：probe 直接过、就绪 [engine=js·worker]、不武装重探。
- node --check、check-wiring 56/0、单测 185/0 + 14/14 + 20/0（test-depth-service 全绿）。

## 第六十三轮：低成本让角色动起来 —— idle 微动画（A 呼吸+飘动 / B 差速视差）（2026-10-14）

### 背景

- DA3 调研定方向：不上 AI 图生视频（每张需人工挑循环点），走「shader 对采样 UV 做微扭曲」——
  前景/背景运动不一致，人眼即解读为「活」。A=分层 idle（深度阈值切前景 mask → 呼吸+发丝衣摆
  正弦扭曲），B=差速视差（角色层移动系数>背景层）；闲置相机轨迹已有（depthDrift 自动漂移）不重做。

### 改动

- **A1 mask 生成**（depthEngineJs.js + depthService.js）：深度落盘后同会话顺手派生前景 mask ——
  Otsu 自动阈值（256 bin 类间方差）切前景（深度值大=近）+ 2.5σ 高斯羽化，与深度图同分辨率
  同缓存键（`<key>.mask.png`）。退化保护：单值深度（Otsu 无峰）/前景占比 <2% 或 >95% → 不写
  mask，渲染端优雅降级。失败绝不影响已落盘的深度本体。DEPTH_CACHE_SCHEMA r6→r7 全量失效
  （旧缓存无 mask），首日按需懒生成。
- **A2 shader idle**（stage.js DEPTH_FS）：新增 uMask(unit 2)/uHasMask/uIdle 三 uniform +
  idleWarp —— ①呼吸：垂直微移 ±0.0012 gluv（≈2px@2160p）3s 周期 + 亮度 ±2% 脉动，
  mask 加权整前景同相；②飘动：双频水平 sin，权重 ∝ mask 边缘梯度（4 邻域差分，发丝衣摆动、
  躯干内部梯度≈0 不变形）；③B 差速：前景层额外吃 12% 相机位移。所有幅度为真机调参起点。
  mask 采样锚定未扭曲基准坐标（stB），扭曲不游走。
- **管线**：glLoadLayer 按深度路径派生 mask 路径（`.depth.png`→`.mask.png`，非此命名→null
  优雅降级）；glFreeLayer 释放 maskTex；pump 派任务带 `job.outMask`（Python 引擎不认识，无害）；
  拼接路径不带 mask（uHasMask=0）。
- **A3 顶栏开关**：快捷开关组加第 4 枚 qchip（人形图标），profile 键 `idleFx`（默认关，跟显示器
  走），resolvedIdle 与 resolvedVideoFull 同构，点击 pushProfile 即时生效。
- shader 无法无头编译（GPU 会话无头必炸的前车之鉴）：CPU 侧静态自证 = 括号配平 0/0、
  uniform 清单含 uMask/uHasMask/uIdle、idleWarp 定义先于调用、调用点签名匹配；
  glInit 失败兜底仍是降级 2D 绝不黑屏。

### 验证

- node --check x5、check-wiring 56/0、单测 185/0 + 14/14 + 20/0（含 onnx 真机推理链全绿）。
- mask 性质三断言（tools/tmp-mask-verify.js，合成深度 CPU 侧自证）：双峰 40/60 → mask 前景占比
  38%（±噪声内）且羽化过渡带存在、分辨率与深度一致；单值平坦 → Otsu 返 -1 不写文件；
  全前景 → 占比超界不写文件。测试分母坑：sharp raw 默认展开 3 通道，值占比=像素占比须除
  buffer 总长而非像素数。
- 真机待验收：idle chip 点亮后角色呼吸/衣摆/差速观感，幅度三参数（0.0012/0.0035/0.12）按
  反馈定版；差速方向符号（+off 同向=人物更动，反向则翻转常数符号）。

## 第六十四轮：idle 差速撕裂修复 —— mask 双通道化（r8）（2026-10-14）

### 现象

- 用户真机反馈：人物的形变「还是老样子，分离的不是很好」，截图实锤轮廓带锯齿撕裂。

### 根因（离屏复现，tools/tmp-idle-sim.py）

- 差速项 `stF += off × 0.12 × m` 的权重 m 用紧羽化 mask（2.5σ，过渡带仅 2~4 mask 像素），
  而 0.12×off 的位移差 ≈ 29 个图像像素 —— 位移差全压在几像素过渡带上，剪切比 1.26px/px
  （纯 POM 基线 0.55px/px 的 2.3 倍），轮廓带必然撕出锯齿。呼吸/飘动幅度小（≤2px）无此问题。

### 改动

- mask 双通道化：mask.png 由单通道改 RGB —— R=2.5σ 紧羽化（呼吸/飘动/亮度脉动），
  G=10σ 宽羽化（差速权重）。29px 位移差摊到 ~60px 宽带 → 剪切回落 0.55px/px 与基线持平。
  不新增纹理单元（一次采样 .rg）。DEPTH_CACHE_SCHEMA r7→r8 全量失效，首日按需懒生成。
- 坑一枚：sharp 的 blur 会把 1ch 输入静默升成 3ch（R=G=B），单通道索引错位 ——
  toColourspace('b-w') 锁回单通道再 raw()。
- shader：early-out 改判双通道（宽羽化在前景外的 halo m=0 而 g>0，不能漏）。

### 验证

- tmp-mask-verify 三断言全过（双通道存在/紧带 500px < 宽带 2400px/退化不写）；
  node --check ×4、check-wiring 56/0、全单测套件通过。
- 离屏四变体对拍：纯 POM 0.55 / +差速 1.26 / 全开 1.26 / 宽羽化修复 0.55（px/px 峰值剪切）。
- 旧缓存 r7 的单通道 mask 若残留在纹理里 .g=0（灰度 PNG 解码 R=G=B 时=g=r），行为同旧版；
  schema r8 已强制重生成，无兼容死角。

## 第六十五轮：mask 换人像分割 —— u2netp 贴轮廓（r9）（2026-10-14）

### 现象

- r8 宽羽化验收仍不过：用户直觉「图没扣干净」实锤——mask 叠回原图，特写图的 Otsu 深度阈值
  mask 把头整个切掉、轮廓从手臂/大腿/胸口身体中间穿过。idle 位移在角色内部不连续 = 形变根源。
  Otsu 只懂「深度近」不懂「人物」，这一层修不好，只能换分割。

### 改动

- depthEngineJs 接入 **u2netp 人像分割**（models/segmentation/u2netp.onnx，4.5MB，
  gitignore 同深度模型待遇；来源 rembg release）：
  - ensureSegSession：**恒 CPU EP**（单张 ~220ms，只在该图首次生成时跑一次就进缓存），
    不与 ComfyUI 等显卡负载抢算力；会话驻留 worker 生命周期（模型小不设回收）。
  - segmentPerson：320×320 RGB → NCHW ImageNet 归一化 → sigmoid → min-max 拉伸
    （原始输出动态范围仅 0.5~0.73，不拉伸 Otsu 切不干净）→ 缩到深度分辨率。
  - generate 的 mask 分支：分割优先，模型缺失/加载失败回落 Otsu 深度阈值（保守降级），
    失败仍不影响深度本体落盘。
  - writeMask 双通道羽化（R 紧 G 宽）原样复用——喂的东西从深度图换成显著图而已。
- DEPTH_CACHE_SCHEMA r8→r9 全量失效（旧 mask 全是深度阈值产物），按需懒生成。
- u2netp 输出名非固定（本例 input.1/d0 探测版）：session.inputNames/outputNames[0] 动态取。

### 验证

- 真图叠加：特写图与女仆图的分割 mask 均贴住人物全身（含头/发/四肢），背景干净排除
  （tools/out/idle-sim/seg_overlay.png）；对比 Otsu 版切头穿身为质变。
- CPU 推理耗时 217ms/张（i5 级），会话创建 124ms。
- node --check ×3、tmp-mask-verify 三断言、check-wiring 56/0、全单测套件通过。

## 第六十六轮：撤销 mask 差速视差 —— B 撤收（2026-10-14）

### 现象

- r8（宽羽化差速）+ r9（人像分割 mask）先后验收仍不过：用户截图轮廓带白齿依旧。

### 根因（离屏复现续测）

- 该区域四变体对拍（tmp-idle-sim.py，真 r9 缓存 mask）：纯 POM 楼梯度 14.5%，
  +差速 18.9%（+30%），峰值剪切 28px/px 级 —— 差速项在 POM 的轮廓错位上再叠一层
  位移带，无论紧羽化还是宽羽化都撕。
- 结构性判断：POM 深度本身就让前景动得多（原生差速视差），mask 差速是叠床架屋；
  它的收益（分层感略强）远抵不过轮廓带撕裂的代价。

### 改动

- shader 删除差速项（`stF += off × 0.12 × m2.g`），idle 只保留呼吸+飘动+亮度脉动
  （幅度 ≤2px，不产生轮廓撕裂）。mask 双通道格式保留（R 紧/G 宽），缓存 schema 仍 r9
  不失效 —— 撤的是 shader 项，mask 数据没变。
- 飘动/呼吸的权重仍用 R 通道紧羽化（贴人物的分割 mask），角色内部无缝。

### 验证

- GLSL 静态自证（括号配平 0/0、差速项移除、呼吸/飘动保留）；node --check、
  check-wiring 56/0、全单测套件通过。
- 真机待验收：轮廓应回到 r41 时代用户验收过的「轻微锯齿」基线（纯 POM），
  呼吸/飘动照常。

## 第六十七轮：发丝钉死撕裂根治 —— mask 引导的深度修复（r10）（2026-10-14）

### 现象

- 用户第四轮截图（精确给到图路径）：人物轮廓毛边「定死在原位」，人物移动后被拉扯成
  梳齿状撕裂。

### 根因（本轮钉死）

- 细发丝/毛边等细结构被 DA3 **穿透**成背景深度（模型解析不出细结构，把背景深度漏给
  覆盖其上的发丝像素）。POM 里这些像素钉死在背景层（steady 点位移≈0），身体（高深度）
  移动时两者之间被拉出梳齿。与用户描述「发丝定死在原来的位置」逐字吻合。
- 深度剖面实锤：轮廓处 68 级（8bit）跳变压在 1~2 texel（22→47→115），位移差 ~50px
  全挤在过渡带。
- 排查弯路两根：①shader 端轮廓自适应降高度（height ÷ (1+k·|∇depth|)）——离屏对拍
  全参数组合都更差（h′ 不连续引入新剪切），已撤销；②展宽过渡带（强边混入模糊版）
  ——对拍改善有限。两根都没修到「穿透」这个点上。

### 修法（离屏对拍定案）

- **mask 引导的深度修复**（depthEngineJs `repairDepthWithMask`）：人像分割先行，
  人体 mask 内的深度洼地用十字 max 膨胀（r=6 texel）填平 —— 发丝获得身体深度，
  跟身体同动；mask 外与已高于膨胀值的像素不动，只升不降；失败保持原深度绝不阻塞落盘。
  离屏四变体对拍（真实撕裂区域+真实视差幅度 SIM_OFF=0.1）：峰值剪切 2.60→0.50
  （-81%）、楼梯度 8.49%→6.91%。
- 十字核而非方形（方形核斜轮廓产轴对齐楼梯齿，r4 教训）；羽化带内权重 0→1 渐入。
- DEPTH_CACHE_SCHEMA r9→r10 全量失效（旧深度带穿透洼地），按需懒生成；LRU 高频
  翻新下旧文件自然回收。
- 排查基建沉淀：tmp-idle-sim.py 支持 SIM_OFF（真实视差幅度）/EPS_TEX/K_ATT/REP_R
  环境变量、mask 缺失兜底、场剪切 P99.9/P50 指标（楼梯度会把原图真实锐边计进去，
  单看会误判）；缓存键定位改「按 mtime 赛跑快照」（LRU 边删边写，键反推不可靠）；
  截图→原图定位必须多尺度模板匹配（壁纸 cover 裁切 3.34x 缩放，单尺度必歪）。

### 验证

- repairDepthWithMask 性质三断言：mask 内发丝洼地填平至周围身体深度、mask 外原值
  不动、羽化带按权重渐入。
- node --check ×3、tmp-mask-verify 三断言、check-wiring 56/0、全单测套件通过。
- 真机待验收：重启后（r10 生效，深度按需重生成）轮廓毛边应跟身体同动，梳齿消失；
  背景与人物整体的轮廓错位属 POM 原生遮挡边界，不在本轮范围。

## 第六十八轮：冷开机提速 —— 扫描缓存持久化 + 舞台链路前移（2026-10-16）

### 现象（实测时间线，GetProcessTimes 硬指标）

- 开机登录 18:33:58 → Run 键拉起主进程 18:34:04 → depth ready 18:34:37 →
  **舞台窗口进程 18:35:40 才出现** → 壁纸 tick 18:35:42。登录到轮播恢复共 104 秒。
- 相库在机械盘（F: ST4000VX000 4TB HDD）上，启用相册 ~44,600 个文件
  （涩一点点 25,437 + Anima-Random 9,479 + 待分类 3,894…），冷开机时
  与杀毒扫描、Syncthing 自启扫描抢盘。

### 根因

- `await scheduler.rebuild('startup')` 串行堵着 `liveStage.start()`；
  rebuild 里的相册扫描没有任何持久化（`scanCache` 只是内存 Map），每次启动全量重扫。
- 热缓存对照实测：同一份 44,634 文件全量扫描只要 **0.21 秒**（tmp/bench_scan.js）——
  算法没问题，纯冷盘放大 400 倍。

### 修法（方案 A + B）

- **A · 扫描缓存持久化**：`scheduler` 新增 `scanCacheFile`（userData/scan-cache.json）。
  构造时**同步水合**磁盘缓存（几 MB JSON，NVMe 几十毫秒），启动 rebuild 全部命中内存
  → 不碰机械盘；真实扫描后 3 秒延迟合并落盘（tmp+rename 原子写），stop() 时兜底补写。
  条目格式为紧凑三元组 `[path,name,ext]`，url 水合时重算。
  兜底链：损坏/超龄(30天)/目录消失/超量(40万)的条目整个不认走重扫；失效文件由既有
  容错兜底（写前 existsSync 预检摘除、一次切换 ≥12 张触发重扫、autoScan）。
  启动吃了缓存 → **两分钟后（盘已热）后台 autoScan 刷新一次**：不洗牌、按路径找回
  当前帧画面不动，刷新结果写回磁盘（关机期间新进的图最迟 2 分钟可见）。
- **B · 舞台链路前移**：`startFullscreenWatch()` 与 `liveStage.start()` 挪到
  `await rebuild('startup')` 之前 —— rebuild 吃水合缓存几乎瞬时；即便缓存未命中
  （首次运行/缓存损坏），channels 事件一到舞台照样立刻创建，不再被冷盘扫描堵住。
  ⚠️ 顺序不变式：暂停监控必须先于 liveWallpaper 开关（舞台 bind 带初始暂停态），
  check-wiring 断言已更新为「先于开关 **且** 先于启动重建」。

### 验证

- 新增 `tools/test-scan-cache.js`（19 断言）：落盘格式、重启水合不重扫（外部增删图
  后列表仍是旧内容 = 没碰磁盘）、水合条目正常走写入链、损坏/目录消失/超龄三路兜底、
  autoScan 刷新后缓存同步更新。
- 已挂进 `npm run verify:unit`；check-wiring 56/0；全单测套件通过。
- 真机待验收：下次冷开机登录后壁纸应在几秒内出来（而非 104 秒）；
  开机 2 分钟后日志应出现「启动用了磁盘缓存，后台刷新一次扫描」。
- 行为变化须知：启动列表来自缓存 → 关机期间被删的图要等首次后台刷新（2 分钟）
  或 12 小时 autoScan 才从列表消失；期间切到它会被写前预检静默跳过（既有策略）。

## 第六十九轮：双层视差（路线 1）—— 人物层叠在补全背景板上（2026-10-16）

### 背景

Live2D 调研定下的近期路线：深度视差与 Live2D 的差距核心在「图是一张纸」——
人物身后没有内容，位移一大就露原图人物像素/拉伸。本轮做最小可交付版：
**干净背景板 + GL 双层合成**；语义部件级分层（See-through）与真 Live2D 模型留后续。

### 修法

- **背景板生成（depthEngineJs）**：`writeCleanPlate` —— 人像区（u2netp 显著图
  Otsu 二值化后**纯 JS 切比雪夫膨胀 8px**）在深度分辨率上做**洋葱皮填充**
  （未知像素取已知 4 邻域均值逐层推进，颜色纯净传播），3 轮局部平滑抹放射纹，
  放大回 preshrink 全尺寸按紧羽化 mask 混合，JPEG q90 落 `trio.bg`（槽位早已
  定义从未有消费者，本轮启用）。⚠️ 实锤教训：sharp blur+threshold 做「膨胀」
  会**侵蚀**小块 mask（16×16 块 256px→208px，整块亮度衰减后低阈值内缩），
  填充圈比人物小就把原图人物色永久留在板里 —— 必须纯 JS 膨胀。
  生成时机：深度首次生成顺手派生（+~1s CPU/张，一次性）+ **老缓存补派生**
  （pump 里 depth 已存在但 bg 缺失 → `depthIn` 直接收编深度只跑 sidecar，
  恒 CPU u2netp ~320ms + 填充 ~2.5s/2048 图）。Python 引擎协议不认识 out_bg 无害。
- **渲染端双层合成（stage.js）**：新纹理 `uBg`(unit3) + `uHasBg`（= bgTex 存在
  且 profile.dualLayer 开）。两条采样路径都接：
  flow（POM）路径 —— mask 跟前景采样坐标（含 POM/idle 位移）对齐，背景板钉在
  基准坐标 stB（sticky 语义：远景本就几乎不动）；经典 uAmp 路径 —— 背景板
  0.35× 低幅视差。`mix(bgc, fg, mask)`，人物移动露出的全是补全背景。
- **开关（五端接线，r73 清单）**：store PROFILE_KEYS `'dualLayer'`（默认关）→
  stage cfg 默认/applyProfile → 顶栏快捷开关 `qt-dual`（qchip，与 idle 同款）→
  app.js resolvedDual/set/click。无背景板的图自动单层（uHasBg=0），绝不影响视差本体。

### 验证（全部自动化实测）

- 新增 `tools/test-cleanplate.js` 13 断言挂进 verify:unit：personBin 三路守卫
  （正常/平坦/占比退化）、人像中心填充收敛到背景色（±20）、区外逐像素=原图
  （JPEG 量化 ±3）、触边人物单侧长入也能填满、输出尺寸契约。中途抓出两个真 bug：
  sharp 膨胀侵蚀（上注）与「取模糊值当填充色」把人物原色永久混入（改洋葱皮）。
- GLSL：tmp-glsl-gen-page 正向 **GLSL-COMPILE-OK** + 负向对照 RESULT-FAIL
  （未声明变量注入，证明通过为真）；tmp-glsl-check.js 顺带修为结果落盘
  （本自动化环境 Electron 主进程 stdout 被吞 + GUI 启动静默 no-op，改 Edge headless）。
- check-wiring 56/0；verify:unit 全链 0 失败（scheduler 199 + scan-cache 19 +
  cleanplate 13 + particles 19 + depth-service 20 + updater 14 + slideshow-guard）。
- 真图冒烟（待分类 helic 立绘 2048 图）：seg 321ms + 填充 2.5s（一次性），
  目检：轮廓边缘颜色延续自然，内部大块柔和色斑 —— 人物遮挡下可见的正是边缘带；
  内容级补全（真背景物体）留给 ComfyUI inpaint 升级，不在本轮。
- 真机待验收：设置顶栏开「双层视差」→ 带人物图视差时人物身后露出补全背景，
  不再出现原图人物残影/拉伸；无 mask/背景板的图自动回退单层。

## 第七十一轮：分割升级 isnetis —— 动漫专训模型替换 u2netp（2026-10-17）

### 背景

第七十轮外扩 3px 只是缓解：u2netp 是**通用显著图**模型，脚踝/发梢/衣摆这类弱响应
区收得比真身紧，且内部有成片软洞（真图冒烟对比实锤：同一张 2048 立绘，
u2netp Otsu 覆盖 44.4% 且身体内部大量灰洞；外扩治标不治本）。调研选定
**isnetis**（SkyTNT anime-segmentation，ISNet 用 AniSeg 动漫角色数据集专训，
MIT，onnx 176MB）——社区抠动漫图的事实标准（rembg isnet-anime 预设同源），
输出软 alpha，动漫边缘公认比 u2net 系高一档。

### 修法（depthEngineJs）

- `segmentAnime`：1024² 黑边居中 letterbox（**只缩小不放大**，thumbnail 语义）→
  **BGR 通道序 + 仅 /255 归一化**（模型契约，对齐 SkyTNT Space / city96 gist，
  不是 ImageNet 均值方差）→ 输出裁掉黑边 → 缩到深度分辨率。返回契约与
  segmentPerson 完全一致（u8 亮=人物），下游 personBin/writeMask/writeCleanPlate 零改动。
- `segmentAny` 三级回落链：**isnetis → u2netp → Otsu 深度**；isnetis 缺模型/加载
  失败本 worker 生命周期内不再重试（与 u2netp 同款 failed 标记）。
- 两处调用点（深度首生成、老缓存补派生）都换成 segmentAny。
- 模型文件 `models/segmentation/isnetis.onnx`（176MB，hf-mirror 下载），按
  u2netp 同例不进 git / 不进安装包 —— 发版里分割自动降级链到 Otsu（既有策略）；
  要在发版带真分割需往 extraResources 加一行（176MB 安装包代价，待定）。

### 验证（全部实测）

- 真图冒烟（同张 2048 立绘，tools/tmp-anime-seg-smoke.js）：
  isnetis **1312ms**（含首跑会话创建）/ Otsu 覆盖 **51.8%**，人物实心、腿脚完整；
  u2netp 311ms / 44.4%，内部成片灰洞 —— 质的差距，且 1.3s 是每张图一次性成本。
- 背景板走真实 writeCleanPlate 管线出图目检正常（对比条 tmp/anime-seg-compare.jpg）。
- 语法 + test-cleanplate 15/0 + verify:unit 全链 0 失败。
- 旧 sidecar（mask+bg）全量重删，下次显示按 isnetis 重派生；深度图不重推。
- 真机待验收：视差时脚部/发梢残影应消失，边缘过渡更干净。

## 第七十二轮：双层视差开启前弹性能警告（2026-10-17）

### 背景

isnetis 分割 + 背景板生成对低配机器是可感知的卡顿来源（每张带人物图首次显示
1~2s 恒 CPU，图库按需补齐），用户要求开启时警告性能损耗并给「以后不再提示」。

### 修法（镜像 askDeletePermission 既有模式）

- main.js `askDualLayerPermission`：warning 型 showMessageBox，文案明确警告
  「每张首次显示后台跑 1~2 秒占满一个 CPU 核 / 数千张图初期翻图有首帧等待与
  切换卡顿 / 推理期持续 CPU 占用笔记本风扇耗电 / 无人物图自动回落单层 /
  随时关掉缓存保留」。buttons=[仍要开启, 不开了]，默认安全侧（defaultId=1）。
  checkbox「以后开启时不再提示」→ `dualLayerHint: false` 落盘 + toast 提示
  设置重开路径。`dualLayerHint === false` 直接放行。
- 仅**开启方向**弹（关→开）；关闭不弹；取消则不动开关（pushProfile 不发）。
- `dualLayerHint` 是纯 UI 偏好：进 DEFAULTS（默认 true）与 BOOL_KEYS，
  **不进 PROFILE_KEYS**（不下发舞台）。
- 设置重开入口：「外观 › 深度视差」节尾新增「开启双层视差前提示」rich check
  （三角警告图标），与 cfg-confirm-delete 同款渲染/保存/推送同步
  （dual-hint:changed → onDualHintChanged）。
- preload：`dualLayerWithConfirm()` invoke + `onDualHintChanged` 推送。

### 验证

- check-wiring 57/0（新增五端齐全断言：handler/preload 桥/renderer 门控/
  store 偏好/HTML 设置行）；verify:unit 全链 0 失败。
- 真机待验收：顶栏开「双层视差」弹警告 → 取消开关不动 → 勾「不再提示」开启
  后下次直接开 → 设置里重开后恢复弹窗。

## 第七十三轮：分割模型按需下载 + idle 微动画移除（2026-10-17）

### 背景

1. isnetis（176MB）不进安装包后，发版用户开双层视差没有模型可用 —— 用户拍板
   方案 B（运行时按需下载），交互对齐 tag-viewer WD14 的成熟模式：
   使用时探测 → 提示 → 遮罩弹窗下载（挡操作、可取消）。
2. idle 微动画（r62）用户真机看不出明显变化：差速视差已被双层合成覆盖（r69），
   呼吸/飘动幅度（±2px@2160p / ±0.0035 gluv）太微弱 —— 决定移除，减一份 shader
   复杂度和一个开关。

### 修法 A：按需下载（新模块 src/segModel.js，模式抄 tag-viewer runtime-setup）

- `status()`：仓库 models/segmentation/（dev）→ userData/models/segmentation/（下载
  落点）两级候选，体积精确匹配才认可用；半截文件报 partialBytes（断点续传现场）。
- `download()`：hf-mirror 直拉（Range 断点续传 + SHA256 锚点
  f15622d8… + 3 次重试，5s 间隔），取消 = onProgress 抛错中断流，半截文件保留；
  SHA 不匹配删文件报错。网络层复用 updater.js 的 downloadToFile/sha256File
  （与更新器同一套已单测的代码）。
- ⚠️ 实锤坑：hf-mirror 对 LFS 文件 302 到 **cas-bridge.xethub.hf.co**（Xet CDN
  签名 URL）—— URL 白名单必须带 `.hf.co` 尾缀，漏了它下载永远被拒（首次冒烟抓出）。
- main：`WP_SEG_MODELS_DIR` env 注入（worker 线程快照 env，先于任何 depth job）；
  `model:seg-status/download/cancel` 三个 handler，进度 120ms 限流推送。
- depthEngineJs：animeModelPath 改多候选（仓库 → env 注入的 userData）。
- 渲染端：qtDual 开启方向 → 性能警告 → segModelStatus → 缺模型弹全屏遮罩
  （.modal-overlay 复用，挡操作），三态：提示（开始下载/取消）→ 进度（百分比 +
  取消下载）→ 错误（重试/关闭）；取消/失败不动开关。

### 修法 B：idle 微动画移除

- stage.js：idleWarp 函数 + uIdle uniform + breathM 亮度脉动 + cfg.idleFx +
  applyProfile 分支全删；stB/uMask/uHasMask 保留（双层合成与氛围金边在用）。
- app.js / index.html / store.js：qtIdle 芯片、resolvedIdle、els、PROFILE_KEYS
  'idleFx' 全删（老配置里残留的 idleFx 键被 applyProfile 自然忽略，无迁移需要）。
- mask sidecar 格式不动（G 通道宽羽化仍在生成，只是暂无消费者）—— 避免全量
  重派生 6400 张。

### 验证（全部自动化实测）

- 新增 tools/test-segmodel.js（9 断言，electron stub）：status 四态（两无/半截/
  坏体积/命中）、仓库候选在位、URL 白名单放行/拒绝（含 Xet CDN 与仿冒域）。
  挂进 verify:unit。
- **真实端到端下载冒烟**：hf-mirror → Xet CDN 完整链 176MB / 5.8s / SHA256 过
  （临时 userData，验后删）。
- GLSL：重生成测试页正向 COMPILE-OK + 负向注入 RESULT-FAIL（idle 删除后 shader
  重新编译通过）。
- check-wiring 59/0（新增下载链五端断言 + idle 五端无残留断言）。
- verify:unit 全链 0 失败（scheduler 199 + scan-cache 19 + updater 14 +
  depth-service 20 + particles 19 + cleanplate 15 + segmodel 9）。
- 真机待验收：全新 userData 下开双层视差 → 警告 → 缺模型弹遮罩 → 下载进度 →
  完成自动开启；重启应用后再开不弹下载（模型已在位）；取消下载开关不动。

## 冷开机提速二段 + 深度呼吸律动（第七十七~八十轮，2026-10-17）

### 第七十七轮：探测期缓存命中（671b959）

- 用户破案：播放顺序固定，启动该直接读前几张的深度缓存，不必等引擎探测（冷开机探测可拖 45s）。
- 修法 = `depthService.lookup()` 的磁盘缓存命中判定提到引擎状态检查之前；`prefetch` 同步先查缓存再入队。
- 效果：缓存命中图启动即出视差，探测期不再白等。

### 第七十八轮：预创建舞台窗口 + 开机 fullscreen 豁免（86ce27e + fb36a65）

- prewarm：启动即给每块显示器建隐藏窗口加载 stage.html（与 rebuild 并行），createStage 按 displayId 收养，60s TTL 看门狗兜底。
- 补：首版逐屏串行 await 让副屏吃不到并行（冒烟实测只有主屏收养）→ 改先全建再逐个等；加载失败只销毁仍未被收养的窗口。
- 开机 20s fullscreen 豁免（BOOT_FULLSCREEN_GRACE_MS）：修冷开机窗口未就绪被误判全屏、首帧冻结 3.3s。
- 实测：壁纸首帧 15.3s → 12.3s；剩余大头 = renderer 冷启动 7~8s（硬成本）。

### r79/r80：深度呼吸律动（dfd0cff → 2980e50 → b23e2b2）

- 验证版 ±5% 故意夸张幅度真机验收「清晰可见」——r73「差速感知不到」翻案成功；转正收敛自然量级 ±1.5%。
- 实现：shader 近景 dN² 加权垂直微移（远景钉住），flowSample 与经典 uAmp 路径双实现；JS 余弦振荡相位永不重置。
- r80 进设置页：外观 › 深度视差「深度呼吸律动」开关（**默认关**）+ 呼吸幅度滑条 ±0.5%~±5%；store 白名单 depthBreath/depthBreathAmp/depthBreathPeriod。

### r81/r82：背景动效尝试与撤收（987efee → ab044f8）

- r81 验证版：远景 (1-d)² 加权 Lissajous 双频低频漂移（23s/31s 互质），双层背景板同步跟随。
- 用户验收后否掉 → r82 整体撤下（shader/uniform/JS/profile 键全清，store 留退役注释），回到 r80 状态。

### 验证

- 每轮 node --check + verify:unit（6 组全 0 失败）+ check-wiring 59/0；GLSL 重启实测编译无错。
- 真机：双屏舞台挂载、首帧上屏正常；呼吸律动 ±5% 感知度实锤、±1.5% 自然量级转正。

## 人物生动（r84）：全身站立像的局部拟人微动（2026-10-22）

### 目标与取舍

用户希望在深度视差上「单独给胸/臀/脚加动效，尽可能拟人」。没有姿态模型，
做方案 A：**脚钉住 + 重心慢摆 + 胸部延迟跟随 + 头部反向稳住 + 局部呼吸**。
不做方案 B（各部位独立物理）——几个弹簧各动各的会打架、发抖，像果冻不像人。

### 实现

- **站立闸门**（`maskMetricsFor`，CPU）：mask 缩采样到长边 192 求 bbox，
  要求 `bh≥0.45 && bw≤0.72 && y0≤0.42 && bottom≥0.70 && 1.5%≤cov≤55%
  && 物理高宽比≥1.5`。半身/坐姿/群像/小人物自动跳过，宁可不做也不把腰当髋摆。
- **shader 局部位移场**（`humanWarp`）：bbox 纵向三段高斯权重（头 0.08 /
  胸 0.30 / 髋 0.56），下段 0.86~0.99 平滑归零=脚钉住；mask 0.55~0.98 的
  轮廓圈再渐隐到 0（只动内部，不拽轮廓）；位移是「内容位移」，采样坐标反向减，
  x 除以 `imgAspect` 让横竖物理像素等比；flowSample 与经典 uAmp 路径双实现。
- **JS 物理**（`humanNow`）：9.4s / 5.7s 双频叠加（不可通约，60s 不重样）；
  髋部横移 ±1.05% 图高（1920 高约 19px、2560 高约 26px）+ 0.16% 纵向；
  胸/肩延迟 0.55s、幅度 0.46；头反相慢 0.95s 抵消到 0.06；呼吸 4.6s、0.34%；
  肩线随重心反相微倾。相位用绝对时间，永不重置。
- **设置页**：外观 › 深度视差「人物生动」开关（**默认关**）+ 幅度滑条 0.3~2
  （默认 1.0）；store 白名单 `humanMotion` / `humanAmp`；文案标注需深度图 +
  人像 mask、建议同时开双层视差。

### 踩坑：mask 跟着微动走 → 补全背景板虚影

第一版把 `humanWarp` 加在 `stF` 上、mask 也跟着同一坐标采样，等于把人物整体
平移 1% 个身高。实测重心摆到极值时，人物腿侧露出一条约 30px 宽的虚影 ——
双层视差的补全背景板是洋葱皮填充，复杂背景处本来就是糊的。

修法：mask 采样固定用微动前的坐标（`stM` / `uvM`），**轮廓钉在原位、只动
轮廓内部的像素**。这样位移侧露出的是原图里紧邻人物的真实背景，A/B 差分图
只剩人物内部的细微差异，虚影消失。也顺带修正了语义：真人重心摆时轮廓几乎
不动，本来就不该像纸片一样整体平移。

另一个坑：高斯权重最初写 `pow((rel.y - center)/sigma, 2.0)`，GLSL 对负底数
的 pow 未定义，改成手写 `d*d` + `exp(-d*d)`。

### 已知限制：腿缝（mask 把背景算进了人物）

isnetis 的 mask 在腿缝窄处是实心的（512×896 的 mask 在膝盖一线是一整条连通
区域），所以重心摆到极值时，腿缝里的亮色背景会跟着人物一起横移，近看像一条
会呼吸的亮边（4× 放大明显，1× 更像打光）。深度图只在裆下几像素判出低深度，
再往下就并成一个面，靠深度开洞不可靠。要根治得重做 mask 生成（按深度/边缘给
腿缝开洞），牵涉既有双层视差缓存，本轮不动。演示里幅度拉到 2× 会更明显。

### 验证

- GLSL：Electron 离屏真实编译 `DEPTH_FS` → ok（含 humanWarp 新增 uniform）。
- `node --check` ×3；check-wiring 60/0（新增 UI/配置/shader/闸门五端断言）。
- verify:unit 全链 0 失败（scheduler 199 + scan-cache 19 + slideshow-guard 14
  + updater 21 + depth-service 20 + particles 19 + cleanplate 15 + segmodel 9）。
- 离线 A/B（工具见 `tools/tmp-human-demo-*.js`，产物在 gitignore 的
  `tools/out/human-motion/`）：真引擎生成 sidecar、真 shader 双面板
  720×1280、同图同镜头。测试图 metrics：x0 .318 / y0 .135 / w .382 /
  h .802 / cov .175 / 物理高宽比 3.68 / **stand=true**。录 8s@30fps，
  产出 `human-motion-ab.mp4`（全景）与 `human-motion-zoom.mp4`（腰腿 1.6× 放大）。
- 真机待验收：开人物生动后全身图应有「重心慢摆、脚不动、头稳住」的观感；
  半身/坐姿图应完全无反应；幅度滑条拉到 2× 是否过头。
