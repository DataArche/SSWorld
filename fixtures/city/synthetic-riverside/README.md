# 虚构河畔城市开发数据包

这是一套完全合成的 1 km × 1 km 数据，用来直接开展城市编辑与仿真开发。不是海德堡或其他真实城市的测绘数据，没有混入下载失败的 OSM 内容。

## 如何开始

1. 读取 `dataset.json`，确定坐标与来源。
2. 导入 `terrain_grid.json`、`roads.geojson`、`parcels.geojson` 和 `buildings.geojson`。
3. 使用 `network.json` 的节点与边，接入 `portals.geojson`、`access_links.geojson`、`demand.csv`。
4. 按 `scenarios.json` 加载关门、涨水、滑坡、建筑替换和用途改变的输入。

`preview.html` 可直接双击打开，查看图层、对比关门路径和静态涨水范围；这是数据预览，不是已交付的城市仿真引擎。

重新生成：在上一级目录运行 `python generate_demo.py`。仅依赖 Python 标准库，固定规则与数据，不联网。

## 文件与用途

| 文件 | 用途 |
|---|---|
| site / roads / parcels / buildings.geojson | 场地、道路、地块与建筑体块输入 |
| portals / access_links / network_nodes.geojson、network.json | 建筑出口 → 地块入口 → 外部路网；每栋楼两个入口 |
| terrain_grid.json、terrain.asc | 10 m 单元的合成地面栅格，北到南排列 |
| water.geojson、water_levels.csv、hydraulic_structures.geojson | 河道、10 m 基线与 11 m 情景、两侧岸线 |
| surface_cover.geojson | 两个示例地表覆盖分区；不是全域无缝覆盖 |
| population.csv、demand.csv | 分时人口与固定步行 OD，共 888 人，无个人信息 |
| landslide.geojson、shelters.geojson | 给定滑坡影响范围、两个假设避难点，各容量 600 人 |
| modeling_survey.geojson、build_recipes.json | 合成尺寸约束与体块生成配方；未生成 GLB，没有照片 |
| scenarios.json | 基线、关闭入口、河水 +1 m、滑坡疏散、单栋替换、公园/混合用途改造 |
| sample_checks.json | 生成时实际计算的连通性、关门绕行、静态连通淹没检查结果 |

GeoJSON 按标准存经纬度；本地计算坐标为米，详见 manifest 的显式换算。地理显示锚点为虚构的 `(0°, 0°)`，不应叠加解释为当地真实城市。GeoJSON 为二维，计算高程在属性和 network 节点内；`terrain.asc` 为本地米制工程坐标，不能误指定 EPSG:4326。所有高度、水位采用同一个 `synthetic_local` 基准。

道路边为双向；桥面采用 13 m 标高，连接道路有线性高程剖面。所有入口位置、容量、速度、人口和用途系数都是开发假设。人口、OD 与避难人数单位为人，车辆容量单位为辆/秒；当前 OD 只覆盖步行，车辆仿真需添加 vehicle 单位的需求行。

## 可以直接验证的交互

- 关闭 `portal-01-a`：01 号楼改走 B 门，仍可到达西南节点。生成器保存了前后实际路径。
- 水位由 10 m 升至 11 m：连通水面从河槽扩展到低岸，桥面保持在水位以上，部分低位通道不能使用。预览不是动态洪水，没有流速或传播时间。
- 滑坡范围覆盖东侧部分建筑和道路，供暴露识别与疏散实现使用；没有进行滑坡预测。
- 01 号楼可按配方生成；01 号地块提供公园和商住改造候选。候选尚未应用到基线。

生成器检查 ID、节点引用、基线 OD 可达、关门后替代路径、连通淹没增量和桥面保留。不输出动态流量或疏散完成时间。测试中的 0.2 m 通行阈值仅为代码示例参数。

合成数据以 CC0-1.0 提供；生成脚本与预览代码沿用所在仓库许可。用于真实片区时逐项替换地形、基准水位、入口、需求和灾害输入即可。
