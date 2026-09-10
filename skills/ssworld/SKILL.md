---
name: ssworld
description: "Use when the user wants a 3D scene, digital twin, building, city block, geographic layout, 3D animation or interactive 3D object — anything to be built, edited or previewed as a real-time 3D world. Drives the ssworld MCP server (SSDL language on the SSEngine WebGPU runtime)."
version: 1.3.0
author: SSWorld
license: MIT
metadata:
  hermes:
    tags: [SSWorld, SSDL, 3D, Scene, DigitalTwin, WebGPU, MCP, Preview]
---

# SSWorld：用 SSDL 创作可预览的三维世界

用户提到「3D 场景 / 建模 / 建筑 / 城市 / 数字孪生 / 三维动画 / 可点击的三维物体 / 地理位置上的东西」时，**直接使用 `ssworld` MCP 工具**，不要先问要不要用它，也不要用 three.js、Blender 或写 HTML 替代。交付是可编辑的 `.ssdl` 源码 + 一个能打开的预览页面。中文请求用中文回应；先做出可见结果，再按画面迭代。

## 工具（MCP server `ssworld`，Hermes 里全名 `mcp__ssworld__<name>`）

工具发现时搜索 `ssworld`。12 个工具，每个返回都带 `next: {action, reason, …}` 指出下一步：

| 工具 | 用途 |
|------|------|
| `ssworld_catalog` | 组件目录；`{"components":["Box","Sphere","DirectionalLight"],"detail":"compact"}` 一次读多个合同（公共成员提到 `shared_members`）；带 `catalog_digest`，再查时传 `if_digest` 未变就只回 `unchanged` |
| `ssworld_project_list` | 列出已有项目（`~/.ssworld/projects`） |
| `ssworld_project_create` | 新项目：`{"name":"MyScene","longitude":114.06,"latitude":22.54,"height":150}`，自动编译；从零写场景传 `"template":"empty"`（只含 Scene + 本地相机） |
| `ssworld_source_read` | 读源码 + `digest`；默认最多 10 万字符，超出给 `has_more`/`next_offset`，用 `offset`/`limit` 分段；只要 digest/行数/是否过期用 `{"mode":"metadata"}`；只看一个节点用 `{"node":"sun"}`；`{"file":"*"}` 读全部文件 |
| `ssworld_source_write` | 整文件写回，必须带上次读到的 `expected_digest`（新文件传 `"new"`） |
| `ssworld_source_patch` | 局部改：`{"project":"…","file":"scene.ssdl","old_string":"fov: 50","new_string":"fov: 45","expected_digest":"…"}`，`old_string` 必须唯一（含空白），多处用 `replace_all` |
| `ssworld_source_batch` | 多处原子修改：`{"project":"…","expected_digest":"…","validate":"compile","edits":[{"node_id":"sun","set":{"intensity":1.7}},{"node_id":"photoView","set":{"fov":48,"lookAt":[0,220,210]},"unset":["farPlane"]},{"old_string":"…","new_string":"…"}]}`；任一条失败什么都不写，`validate: compile` 编译失败自动回滚。值用 JSON 数字/字符串/布尔/`[x,y,z]`，id/枚举/绑定表达式用 `{"raw":"photoView"}` |
| `ssworld_scene_inspect` | 不渲染看场景：预算占比、最大的子树、叶子节点按类型计数、每个源文件贡献的节点数、几何体包围盒（最低底面/最高顶面）、场景要求的相机（含由 lookAt 推出的 heading/pitch） |
| `ssworld_compile` | 编译，失败返回 `scene.ssdl:行:列: 代码: 信息`；成功带 `node_count` 与预算 `usage` |
| `ssworld_preview` | 启动本地预览并返回 `viewer_url`，`page.connected` 说明页面是否已打开 |
| `ssworld_capture_frame` | 对已打开的预览页截图（引擎按请求尺寸离屏渲染一帧，垂直 fov 不变、无拉伸），返回图片、像素统计、`receipt`（这一帧对应的源码/IR digest 与页面 generation，`in_sync: false` 时 `staleness` 说明为什么不是最新）、`framing`、运行时错误、相机 `effective`/`requested`/`deviation`；`{"project":"MyScene"}`，可选 `width`/`height`/`settle_ms` |
| `ssworld_engine_status` | 引擎是否已安装；`{"install":true}` 立即下载 |

## 标准流程

1. **建项目或选项目**：新需求 `ssworld_project_create`；用户说「改一下刚才的场景」先 `ssworld_project_list` 找到它。项目名只能字母开头、字母数字 `_-`。用户给了地点就把经纬度传进去（WGS84 度，高度米），没给用默认锚点。
2. **查目录再写**：`ssworld_catalog {}` 看 `supported` 为 true 的组件；要用的组件一次 `{"components":[…],"detail":"compact"}` 读齐属性名、类型、单位和必填项，看 `member_notes` 里的单位与约定。**不要凭记忆或 QML/three.js 经验猜属性**。
3. **读 → 改 → 写**：大场景先 `ssworld_source_read {"mode":"metadata"}` 拿 `digest`，不要整份读回；要改哪个节点用 `{"node":"id"}` 只读那一块。改多处（调灯、改相机、换颜色）用 `ssworld_source_batch` 按 `node_id` 直接 `set`，并加 `"validate":"compile"`，编译不过会自动回滚；单处用 `ssworld_source_patch`；整文件重写或新文件用 `ssworld_source_write`。都传 `expected_digest`，冲突就重读，不盲写。用宿主文件工具直接改项目目录里的 `.ssdl` 也可以（`ssworld_compile` 总是从磁盘重建），但不受 digest 锁保护。多文件组件用 PascalCase 文件名（如 `Tower.ssdl`），入口里 `Tower { id: t1 }` 使用。
4. **编译并修诊断**：`ssworld_compile`；按行列信息改源码，直到 `ok: true`。大场景接着 `ssworld_scene_inspect` 看预算占比、包围盒和 `requested_camera`：相机到目标的距离、heading/pitch 与包围盒对不上就先改相机，不必截图试错。
5. **预览并亲眼看**：`ssworld_preview` 返回 `viewer_url`；`next.action` 是 `open_webgpu_viewer` 就用 Hermes 的 `open_preview(url=viewer_url, label="SSWorld 场景")` 打开（工具未加载先发现它），是 `capture_frame` 就直接截图。页面会热重载：之后每次写源码 + 编译，同一页面自动更新，不要重复开新页。
6. **截图验证再汇报**：页面打开后调用 `ssworld_capture_frame {"project":"…"}`。看返回的图片判断构图、相机是否对准、物体是否在画面内；没有视觉能力就读 `stats`：`luma.p10/p50/p90` 与 `under_exposed_ratio`/`over_exposed_ratio` 判曝光，`coverage` 与 `regions.cells`（3×3，左上起）的 green/blue/white/neutral 占比判「下部有没有植被、上部是不是天空」，`colormap_top` 看主色。`runtime.errors` 非空就是运行时失败（编译通过不等于能跑），每条带 `source.file:line:column`，直接改那一行；此时 `camera.source` 是 `engine_default`，那一帧的相机位姿不是你的 CameraView，不要拿它判断构图；`render_verified: true` 只表示「状态 ready、无错误、画面不是黑的」，画得对不对要看图。先看 `receipt.in_sync`：为 false 时 `staleness` 会说明这帧对应的是旧编译或磁盘源码已变，按 `next` 重编再截，不要拿旧帧汇报。`camera.deviation` 里 `nearPlane/farPlane` 的差异是引擎按相机高度每帧重算裁剪面所致，不是参数失效；`heading_error_deg`/`position_error_m` 大才说明相机没按 CameraView 落位。`reference_match` 永远是 `not_evaluated`：工具不做参考图对比，构图像不像要自己看图判断，不要编造匹配分数。返回 `page_not_open` 就先用 `open_preview` 打开 `viewer_url`（窗口要可见，最小化不出帧），再截。动画截两个时刻（`settle_ms` 不同），改相机后重截。

首次使用若 `ssworld_preview` 报 `engine_not_installed`，调用 `ssworld_engine_status {"install":true}`（下载约 54 MB），然后重试。

## SSDL 语义要点

- **右手 Z-up，单位米**：X 东、Y 北、Z 上。Box 的 width/depth/height 对应 X/Y/Z，`position` 是中心点，底面贴地要 `z = height/2`。场景原点在项目锚点（经纬度）处，局部坐标以米偏移。
- **相机用局部坐标构图**：`CameraView { id: v; position: [60, -80, 40]; lookAt: [0, 0, 12]; fov: 50 }` + `Camera { initialView: v }`。`position`/`lookAt` 与节点同一坐标系（米），`lookAt` 自动推出 heading/pitch；也可显式 `heading`（0 = 北，顺时针）/ `pitch`（负 = 俯视）/ `roll`。`nearPlane`/`farPlane` 会被引擎按相机高度每帧重算，写了也不生效。`longitude/latitude/height` 只在需要飞到别处时用，与 `position` 二选一。低机位街景：z 取 1.5–3 米，`fov` 45–60。
- **几何体 rotation 是四元数 `[x, y, z, w]`**（w 在最后，单位四元数 `[0,0,0,1]`）；绕 Z 转 θ 度写 `[0, 0, sin(θ/2), cos(θ/2)]`。要转动就用 `RotationAnimation`。`DirectionalLight`/`SkyAtmosphere` 等环境组件的 `rotation` 是欧拉角度 `[x, y, z]`，太阳方向优先用 `sunAzimuth/sunElevation`。`intensity` 是无量纲倍率（默认 1），不是勒克斯。
- **重复结构先组件化**：立面格栅、树、路灯写成 `Tower.ssdl`/`Tree.ssdl` 这类组件文件，在入口里 `Tree { id: tree1; position: [...] }` 多次使用，id 用语义名（`civicRoof`、`eastTower`）而不是 `b123`；`ssworld_scene_inspect` 的 `by_file`/`largest_subtrees` 能看出哪部分吃掉预算。
- **每个节点给唯一 `id`**，尤其是自定义组件文件里的多个同类兄弟；匿名节点在组件内会报 `duplicate_id`。
- **DirectionalLight 两种模式**：`atmosphereSunLight: true` 接管天空太阳，只能改 `intensity/lightColor/castShadows/temperature/indirectLightingIntensity/volumetricScatteringIntensity` 和 `sunAzimuth/sunElevation`；`lightSourceAngle`/`lightSourceSoftAngle`/`cloudScatteredLuminanceScale` 只有 `atmosphereSunLight` 不为 true 的自有灯才能写，编译器会以 `runtime_unsupported` 拒绝错误组合。
- QML 风格：`id`、属性绑定表达式、`State { when }`、组件文件。事件处理器只能做受检的属性赋值，不是任意 JavaScript。
- 动画：`NumberAnimation` / `Vector3dAnimation` / `RotationAnimation` / `ColorAnimation` / `QuaternionAnimation`，`duration` 毫秒，循环 `loops: Animation.Infinite`，`running` 可绑定状态。目标属性必须在目录允许的注册表内，编译器会拒绝其它组合。
- 交互：`TapHandler { onTapped: { ... } }`、`HoverHandler`；灯光/材质/环境先查目录，`supported: false` 的不要用。
- 默认预算 2048 原生对象 / 256 绑定 / 128 处理器 / 32 计时器；大场景先用少量体块出画面，再加细节。

最小可交互动画示例（这也是 `ssworld_project_create` 生成的起始场景）：

```ssdl
Scene {
  id: main
  CameraView { id: startView; position: [60, -80, 40]; lookAt: [0, 0, 12]; fov: 50 }
  Camera { id: mainCamera; initialView: startView }
  State { id: selected; name: "selected"; when: false }
  Box {
    id: cube; width: 24; depth: 24; height: 24; position: [0, 0, 12]
    PrincipledMaterial { baseColor: selected.when ? "#ffb454" : "#4288db"; roughness: 0.3; metalness: 0.5 }
    TapHandler { onTapped: { selected.when = !selected.when; } }
  }
  RotationAnimation { target: cube; property: "rotation"; from: 0; to: 360;
    duration: 8000; running: !selected.when; loops: Animation.Infinite }
}
```

## 边界

- `ssworld_source_write` 只写项目内 `.ssdl`；页面排版、锚点、默认相机在项目目录的 `index.html` / `scene.mjs`（路径在 `ssworld_project_create` 返回的 `directory`），需要时用文件工具改。几何、材质、动画、事件一律留在 SSDL，不要搬进宿主 JS。
- `SkyAtmosphere.skyLuminanceFactor`、`rayleighScattering` 等散射项是三维向量 `[r, g, b]`，不是标量；写错编译期就会报 `type_mismatch`。`SunSky` 不可用，改用 `SkyAtmosphere` + `DirectionalLight { atmosphereSunLight: true; sunAzimuth; sunElevation }`。
- 不要删除或覆盖用户已有项目；`ssworld_project_create` 对重名会直接报错。
- 最终回复给出：项目名与源码路径、`viewer_url`、截图路径（`capture_path`）与从图上看到的内容、运行时错误（如有），以及没验证的部分。
