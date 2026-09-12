# SkylineBoulevard

SSDL 0.3 程序化生成的现代都会大道场景（对照参考图：中央林荫大道 + 两侧密集玻璃幕墙天际线 + 正午强日照 + 蓝天积云）。

## 怎么重建

```bash
python gen_tex.py     # 1. 生成 24 张程序化贴图到 assets/
python gen_city.py    # 2. 生成 scene.ssdl（约 300 KB）
# 3. 用 ssworld_compile / ssworld_preview 编译预览
```

两个脚本是唯一的手写源；`scene.ssdl` 是产物，不要手改（改了下次重跑就没了）。

## 结构

```
scene.ssdl
├── CameraView heroView          26m 高视点，沿大道向北，pitch -4.2°，fov 58
├── SkyAtmosphere / DirectionalLight / SkyLight / ExponentialHeightFog / PostProcessVolume
├── 地面：草地基底 + 大道（双向 5 车道 + 中央隔离带）+ 人行道 + 路缘 + 护栏
├── 建筑 Prefab 源 ×44（Loft 程序化几何，visible:false）
├── Prefab ×60 + Instances ×63 批（explicit 坐标，整批 = 1 个原生对象）
└── 配景：行道树（Lathe）/ 路灯（Tube 杆挑臂 + Box 灯头）/ 车辆（Loft 厢体 + Box 驾驶室）/ 行人 / 车道虚线 / 隔离带灌木 / 西侧山体（HeightField）
```

## 核心手法

**1. 建筑 = Loft 环形序列（`Bld.spec()`）**

一栋楼是一个 Loft 节点，环形序列把立面细节直接烘进网格：

| 风格 | 每个楼层带的环 | 环序含义 |
|------|----------------|----------|
| `band` | 4 环 | 玻璃竖面 → 楼板下沿 → 楼板出挑竖面 → 楼板上沿 |
| `strip` | 3 环 | 外倾玻璃面 → 内凹玻璃面 → 层线水平板 |

在此之上叠 `taper`（收分）、`twist`（逐层扭转）、`setbacks`（退台）、`ch`（切角），
一个变体表就覆盖了裙楼 / 中层 / 高层 / 地标四档 44 种楼型。

**硬约束**：`Loft.sections` 上限 **128 环**，所以用「楼层带」（1 带 ≈ 2 层，带高 4~8m）而不是逐层。

**2. 立面贴图与 UV 严格对齐（`gen_tex.py`）**

`uvScale.v = 楼层带数`，于是**每个楼层带正好落在贴图的一个纵向周期上**，贴图按上述环序分区：

- `facade_band_*.png`：v 四等分 —— 窗格玻璃 / 楼板底面 / 楼板竖面 / 屋面板
- 配套 `*_mr.png`（G=粗糙度、B=金属度，线性空间），材质上 `metalness: 1.0; roughness: 1.0`，
  于是**同一张立面里玻璃是镜面低粗糙、楼板是哑光粗糙**。
- `baseColor` 当作染色（与贴图相乘），一种贴图 + 不同 tint 就能派生出多种配色。

**3. 实例化摆放**

Prefab 源节点一律 `position: [0,0,0]` + `visible: false`，实例坐标即最终世界坐标
（Loft/Lathe 的环坐标里 z 已含离地高度，Box 源要自己补 h/2）。
`Instances.positions` 上限 **256 个/批**，超出自动分块。

## 踩过的坑（都是真机复现的）

1. **列表值不能跨行**：`sections: [` 后紧跟换行直接 `syntax_error`。
   整个列表必须在同一行 —— 生成器输出的是几 KB 的长行，属正常。
2. **天空变橙褐**：`DirectionalLight` 上一旦写 `useTemperature` / `temperature`，
   以及 `SkyAtmosphere` 上写 `rayleighScatteringScale` / `mieScatteringScale` / `skyLuminanceFactor`，
   都会把整片天空染成橙褐（太阳颜色会喂给大气）。
   **结论：`SkyAtmosphere { id: sky }` 保持全默认，太阳用 `lightColor` 调色。**
3. **`GeometryFacade.createMesh: triangle is degenerate`**：Lathe 端点半径 0、Tube 首段完全竖直
   都会让网格退化并让**整个场景模块加载失败**。端点留 0.08 半径、立杆带 6cm 微倾即可。
4. **hex 颜色按线性解释**，不按 sRGB。写 `#16260f` 渲染出来仍是浅绿，
   想要深绿得写到 `#0a1408` 量级。贴图 PNG 则按 sRGB 正常处理。
5. `Loft.sections` ≤ 128 环；`HeightField.heights` 要 `(columns+1)*(rows+1)` 个值。

## 预算水位（最后一次编译）

原生对象 139/2048 · 材质 74/2048 · 贴图 24/32 · Prefab 60/64 · 实例 1689/2048 · 时间线 0/256
网格合计 11,011 顶点 / 21,646 三角形（不含 Box/Sphere 等图元）。

## 内容规模

371 栋建筑（44 种楼型）· 556 棵树 · 88 盏路灯 · 61 辆车 · 108 丛隔离带灌木 · 304 段车道虚线 · 1 座程序化山体。
