# SSWorld

[![npm](https://img.shields.io/npm/v/ssworld-mcp)](https://www.npmjs.com/package/ssworld-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

*[English](README.md)*

**Agent 看不见自己渲染出了什么。SSWorld 把这个环闭上。**

[![SkylineBoulevard](examples/SkylineBoulevard/preview.webp)](examples/SkylineBoulevard)

一个 MCP 服务器,让任何支持 MCP 的 agent 应用(Claude Code、Codex、Hermes、Cursor …)用 **SSDL**
——一种类 QML 的场景描述语言——在 **SSEngine WebGPU** 运行时上写场景、编译、渲染,并且**回读**渲染结果。
上面这张图就是 agent 写出来的场景,生成它的 42 KB Python 在
[`examples/SkylineBoulevard`](examples/SkylineBoulevard)。

## 和"又一个场景生成器"的区别

- **是真引擎,不是预览。** 延迟渲染、大气天空、阴影、后处理、glTF 资产、GPU 实例化;
  场景站在真地球上——地形、影像图层、3D Tiles、GeoJSON,按经纬度锚定。
  几十万个实例化对象的场景跑在 60 fps。
- **Agent 能拿到画面本身。** `ssworld_capture_frame` 经引擎渲染,回传亮度分位数、曝光尾部、
  3×3 分区的颜色覆盖、主色列表、实际使用的相机位姿与请求位姿的偏差,以及一份把这一帧绑定到
  源码摘要和应答页面的回执。Agent 能自己发现"天空糊成橙褐色了"并改掉,不需要人盯着看。
- **真机上踩过的坑变成编译错误。** 下面每一条都是先在真实硬件上踩到的,当时的症状是白页 + 日志什么都没有。
  现在每一条都在编译期点名节点和成员:用 `rayleighScattering` 给天空调色、`Lathe` 半径写 0、
  给没有切线的几何加 `normalMap`、`heights` 按格子数而不是角点数来数。

## 案例

| [SkylineBoulevard](examples/SkylineBoulevard) | [ShenzhenNorthStation](examples/ShenzhenNorthStation) | [DuskRange](examples/DuskRange) |
|---|---|---|
| [<img src="examples/SkylineBoulevard/preview.webp" width="280">](examples/SkylineBoulevard) | [<img src="examples/ShenzhenNorthStation/preview.webp" width="280">](examples/ShenzhenNorthStation) | [<img src="examples/DuskRange/preview.webp" width="280">](examples/DuskRange) |
| 程序化生成的都会大道。42 KB 确定性 Python 生成 306 KB SSDL。 | 按国铁公开尺度重建的真实车站,对照航拍参考逐轮打磨。 | 可玩的 75 秒移动靶射击:键盘输入、命中计分、HUD、碰撞。 |

三个案例都**只收手写源**——贴图和 `scene.ssdl` 由脚本重新生成——所以每个都不到 250 KB,
且不含任何第三方素材。详见 [`examples/`](examples)。用到第三方模型的场景放在 showcase 仓库,
并在那里附署名。

## 安装(一条命令)

```bash
npx -y ssworld-mcp install
```

这会全局安装本包、把 `ssworld` MCP 服务器注册进它能找到的每个 agent 应用
(用 `--client=claude,codex,hermes,cursor,dsh` 指定),并把钉死版本的引擎(约 54 MB)下载到 `~/.ssworld/engine/`。

环境要求:Node.js ≥ 22、npm,以及一个支持 WebGPU 的浏览器(Chrome/Edge)用来看预览。

### 也可以当原生插件装

Claude Code 和 Codex 都直接读本仓库里的插件清单,所以一条命令同时注册 MCP 服务器和 SSDL 写作技能,
不需要全局 npm 安装;钉死版本的引擎仍在第一次预览时下载。

```
# Claude Code
/plugin marketplace add DataArche/SSWorld
/plugin install ssworld@ssworld
```

```bash
# Codex
codex plugin marketplace add DataArche/SSWorld
codex plugin add ssworld --marketplace ssworld
```

Hermes、Cursor、DSH 没有能承载 MCP 服务器的插件包——它们各自在自己的配置里登记服务器——所以
`ssworld-mcp install` 就是这三家的原生路径,它写入的正是各家真正读的位置:`~/.hermes/config.yaml`
的 `mcp_servers:`、`~/.cursor/mcp.json` 的 `mcpServers`、以及 DSH 用户补丁层
`~/.dsh/cordis.patch.yml` 里的一条 `@deepseek-ai/dsh-mcp-client`。Hermes 和 DSH 还会把技能拷进
各自的 `skills/` 目录——那个文件本身就是注册。

```bash
npx -y ssworld-mcp install --client=hermes,dsh
```

手动注册到其他客户端:

```json
{ "mcpServers": { "ssworld": { "command": "node", "args": ["<npm root -g>/ssworld-mcp/bin/ssworld-mcp.mjs"] } } }
```

## 工具

十四个工具。下表是一句话版本;每个工具的完整行为(参数、分页、回执字段、诚实信号)见
[英文 README](README.md#tools)。

| 工具 | 作用 |
|------|------|
| `ssworld_catalog` | 组件索引 / 单个契约 / 批量契约;带 `catalog_digest` 做缓存命中,每个成员标注单位与旋转约定 |
| `ssworld_project_list` | 列出 `~/.ssworld/projects` 下的项目 |
| `ssworld_project_create` | 新建一个可运行项目(按经纬高锚定)并编译 |
| `ssworld_source_read` / `ssworld_source_write` | 有界读取(`max_chars`、偏移分页、`mode: metadata` 只要摘要和编译新鲜度、`node` 只要一个块)与整文件写入 |
| `ssworld_source_patch` | 精确跨度替换(`old_string` → `new_string`,查唯一性),带同一套摘要锁 |
| `ssworld_source_batch` | 原子多处编辑:文本补丁 + 节点级 `{node_id, set, unset}`;全部先在内存校验,`validate: compile` 失败时回滚 |
| `ssworld_scene_inspect` | 不渲染就拿到编译后场景的事实:预算占比、按体量排序的子树、每种类型的叶子、图元范围、请求的相机 |
| `ssworld_compile` | SSDL 0.3 编译器,真实诊断、节点数、预算 `usage` 和 `logic`;目录与运行时的不一致是编译错误 |
| `ssworld_preview` | 起本地预览服务器,返回页面地址、页面是否打开、`page.clients`(每个同步中的浏览器)和结构化的 `next` |
| `ssworld_capture_frame` | 经引擎截图 + 统计量 + 相机偏差 + 回执 + 页面实时逻辑;`await` 可等某个状态成立再拍;`detail: "brief"` 供迭代循环 |
| `ssworld_environment_read` | 问引擎它实际收到的环境:从原生太阳回读的方向、哪个 `DirectionalLight` 在驱动大气、各环境组件的实时原生值 |
| `ssworld_geo_read` | 问引擎它对地理图层的实际持有:地形有没有真的加载、`anchor_above_terrain_m`(锚点下方地面与场景本地 z=0 的高差——开地形动的是地面不是场景)、影像层的真实叠放次序,以及每个 `Tileset` / `GeoJsonLayer` 的就绪状态、范围和要素数 |
| `ssworld_logic_read` / `ssworld_logic_write` | 不截图就读页面的场景逻辑(含场景模块到底有没有挂载),或在一个事务里设置声明属性,把游戏摆到某个局面再截图 |
| `ssworld_engine_status` | 引擎配对装好了没(`install: true` 触发下载) |

## 规模:实测到哪里为止

预算是每个项目 `showcase.manifest.json` 里的值。默认值:4096 原生对象 / 4096 材质壳 / 32 张不同图片 /
4096 绑定 / 2048 处理器 / 256 计时器 / 256 时间线 / 1024 个 Group locator / 1024 个 Prefab /
524288 个实例行。其中四项是引擎自己的上限,manifest 抬不动——抬了会编译通过然后挂不上去。

**先用完的不是渲染,是截图。** 6401 个原生对象 + 200 个 prefab 上的 409600 个实例行:编译 1.2 s、
挂载 4.0 s、61 fps、零运行时错误。但离屏回读在 4001 个原生对象(能截)和 5001 个(不能)之间死于
wasm "memory access out of bounds"。所以大约 4000 节点以上的场景能跑但不能截图,这也是为什么
**实例化**(200 个原生对象承载 409600 行)才是做大场景的办法。

三条引擎上限没有预算维度,各自是独立的编译错误:`scene_depth_exceeded`(16 层嵌套)、
`model_budget`(64 个 `Model` 挂载——多处摆放要用 `Prefab` 而不是复制)、
`texture_budget`(64 MiB 不同图片,不论单个文件多小)。

完整的测量记录和"绑定 64 条墙"那段历史见[英文 README](README.md#how-big-a-scene-measured)。

## 写场景要知道的几件事

- **颜色按 sRGB 写。** `#rrggbb` 就是取色器给你的值,运行时转成线性再交给引擎。原生材质每通道只有
  8 bit *线性*光,所以很暗的颜色会量化:`#16260f` 回读是 `#16260d`,`#0a0a0a` 以下基本塌成黑。
- **列表值可以跨行**(`sections: [` 后换行、一行一个环、括号内可写注释),但属性仍然到换行或 `;` 结束,
  所以跨行只在 `[ ]` 内部成立。
- **程序化几何**有四个参数化生成器:`HeightField`(`columns`/`rows` 数格子,`heights` 数它们周围的
  `(columns+1)*(rows+1)` 个角点,行主序从 `-depth/2` 开始)、`Lathe`、`Tube`、`Loft`。
  任意网格走托管资产(`Model`)。
- **地理图层**:`Globe` / `ImageryLayer` / `Tileset` / `GeoJsonLayer` 四个组件只能是 `Scene` 的直接子节点、
  没有自己的变换——经纬度和场景本地 ENU 米是两个世界,SSDL 不假装它们是一个。影像叠放即声明顺序(至多 8 层),
  `Tileset` 的 `offset/rotation/scale` 变换的是数据集自己的根(至多 4 个,本引擎没有 `maximumScreenSpaceError`,
  LOD 旋钮是 `geometricErrorScale`),`GeoJsonLayer` 一层只画一种要素、样式创建时读一次(至多 8 层)。
  **开地形动的是地面不是场景**:本地 `z: 0` 还钉在锚点的椭球高上,`ssworld_geo_read` 回读 `anchor_above_terrain_m`。
  **本服务器不自带底图**——瓦片服务的条款和 key 不由我们替你接受,`"template": "geo"` 里的 `ImageryLayer` 是注释掉的。
- **时间与天空**:`Environment` 是场景时钟,也是真实天文求解器。给它 `dateTime`(ISO-8601 **必须带时区偏移**,
  不带会被拒——那等于悄悄用观看者自己的时区)和站点 `latitude`/`longitude`(两个都不写就跟随相机地面点),
  太阳、月亮、星空就落在那一刻真实的位置上(Simon 1994 星历 + IAU 2006 ICRF→固连旋转)。`timeScale` 是
  仿真秒/真实秒,`3600` 一秒走一小时,`0` 冻住。它**独占太阳方向**:同场景里再写
  `DirectionalLight.sunAzimuth` 或 `SunSky` 会被判 `multiple_writer`,要钉太阳用 `Environment` 自己的
  `sunAzimuthOverride` / `sunElevationOverride`;一个场景一个,且不能有父节点。星星按太阳仰角自行淡出
  (0° 以上全灭、−12° 以下全亮),`starsIntensity` 是上限不是开关。`sunIntensity` 是**绝对量级**
  (默认 4.65,即 UDS 的 `Sun.SunLightIntensity`),下游不做归一化,写 1.0 会让天空掉进色调映射的 toe 而发黑。
  它还**接管天光**:天空的环境光那一半是引擎捕获的一张立方图——卷成 SH 当漫反射环境光,同一张又当水面和
  金属里反出来的天空。声明了 `Environment` 就把这个捕获强制打开并一直跑,于是环境光和这些反射跟着时钟走,
  而不是停在某一刻;`SkyLight.realTimeCapture: false` 写在旁边会被判 `sky_light_capture_owned`,不做静默忽略。
  捕获按五帧一轮分片(天空面、云、两趟给反射 mip 做的 GGX 预卷积、漫反射 SH),
  所以天空突变时环境光和天空反射会慢约五帧跟上。引擎里这个捕获**默认开**,
  所以裸写一个 `SkyLight` 就已经跟着太阳走;`realTimeCapture: false` 是作者主动冻住环境光的写法,
  而这正是 `Environment` 拿走的那一个。
- **天气是 opt-in**:`cloudCoverage` 按 UDS 刻度(`0..3`,出厂 1.14),它同时加厚云层和高度雾
  (`fogDensityClear` → `fogDensityCloudy`,UDS 的那条曲线);`windDirection`(0 = 北,顺时针)和 `windSpeed`
  吹动云。三个都不写,云和雾就保持 `VolumetricCloud` / `ExponentialHeightFog` 上写的样子——值从 Unreal 搬过来时
  要的正是这个。`fogGetsColorFromAtmosphere`(默认 `true`)让高度雾从大气取内散射颜色,于是日落发红、入夜转暗,
  而不是一直保持白天那个蓝。云的**观感**则是 `VolumetricCloud` 其余成员,每一个都按 UE / Ultra Dynamic Sky
  的输入命名(`hightFrequencyNoiseAmount` 就是 UE 的拼法),在 Unreal 调好的云可以逐值搬过来。
- **体积云的单位是公里**:`VolumetricCloud` 的 `layerBottomAltitude` / `layerHeight` /
  `tracingStartMaxDistance` / `tracingMaxDistance` / `shadowTracingDistance` 全部以**公里**计——这是 UE
  给这个组件定的单位,和 SSDL 其余部分的米不一样。一层云是 `layerBottomAltitude: 1.8; layerHeight: 0.5`,
  不是 1800/500。按米写不只是把云放错位置:采样数是定值(`min(96 x viewSampleCountScale, 768)`),
  不随追踪距离增长,射线被拉长上千倍后云噪声沿射线混叠,天空会出现竖直白色拉丝。已在编译期拒绝
  (`cloud_kilometres_expected`)。
- **模型资产**:glb 和贴图放进 `<project>/assets/`,按项目相对路径引用。单个 glb 上限 32 MiB、
  单张贴图 8 MiB、每项目 64 个资产。Model 自带材质,只有它的位置/旋转/缩放/可见性可动画。
- **场景逻辑**:在 `Scene` 根上声明属性,处理器赋值(一个处理器一个事务),绑定读取。
  宿主 JavaScript 只能通过 `host_interfaces.json` 声明的调用进入,对不上就是编译错误。
- **绑定整批回滚**:任何一个被目标拒绝的值会让整批回滚、绑定转为无效,页面报 `binding_error`
  并映射到那个节点块里的成员行。

每一条的完整说明(包括编译器具体拒什么、为什么拒)见[英文 README](README.md#authoring-reference)。

## 命令行

```
ssworld-mcp                 # MCP stdio 服务器(agent 应用启动的就是它)
ssworld-mcp install [--client=claude,codex] [--no-engine]
ssworld-mcp engine          # 下载 / 校验钉死版本的引擎
ssworld-mcp preview [--port=8880]
ssworld-mcp doctor
```

环境变量:`SSWORLD_HOME`(默认 `~/.ssworld`)、`SSWORLD_PREVIEW_PORT`(8880)、
`SSWORLD_ENGINE_DIR`(用本地引擎配对,不走 release 下载)。

## 目录

`ssdl/compiler` 是逐字节一致的 SSDL 0.3 编译器闭包,`ssdl/runtime` 是浏览器运行时,
`ssdl/catalog` 是组件目录,`engine.lock.json` 钉住作为 GitHub Release 资产发布的
SSmap.js/SSmap.wasm 配对。本仓库由 SSEngine3 仓库里的 `src/ssdl/tools/pack_ssworld_mcp.py` 生成,
不要直接在这里改。

## 许可

刻意分成两轨。

MCP 服务器、SSDL 编译器、浏览器运行时、组件目录、项目模板和技能是 **Apache-2.0**(`LICENSE`)——
可以读、可以 fork、可以拿去发布。

渲染引擎(`engine/SSmap.js`、`engine/SSmap.wasm`,由安装器下载,从不入库)是**专有**的,
条款在 `ENGINE-LICENSE.txt`,授予免费使用和二进制形式的再分发,包括商业用途。
`NOTICE` 逐文件写清这个划分,以及第三方组件(`qtloader.js` 是 Qt 的,依它自己的条款)。
