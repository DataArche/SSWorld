# SSWorld real-site street template

From OpenStreetMap base data to an interactive WebGPU street scene: roads, blocks and parcels, ground, water, green space, planting, buildings, street furniture, lighting and cameras. The pipeline is fixed — **a new site needs only a new config**. All dimensions are metres, and the same config plus the same data produce byte-identical output.

Verified sites:
- Guanlan: `configs/guanlan.json`, 3.28 km².
- A test site: 113.930–113.942 E / 22.740–22.752 N, about 1.6 km², no water. Runs from scratch with one command; all 11 geometry checks report 0.

## 1. A new site: one command

```powershell
# from the example root (the directory that contains tools/)
copy tools\road_template\configs\template.json tools\road_template\configs\mysite.json   # fill it in per section 2
./tools/road_template/new_site.ps1 -Config tools/road_template/configs/mysite.json
```

Requirements:

| Dependency | Notes |
|---|---|
| Python + Shapely/NumPy | Loaded from `.deps/guanlan-gis` when present: `python -m pip install --target .deps/guanlan-gis shapely==2.1.2 numpy`. Pass `-Python` or set `ROAD_TEMPLATE_PYTHON` to pick the interpreter. |
| Windows node + SSWorld | Reads `~/.codex/plugins/cache/ssworld/ssworld/local` by default; set `SSWORLD_PACKAGE` to use another install. |
| SSWorld preview service | Listening on `127.0.0.1:8880`, started by `ssworld_preview` or the plugin. |
| Chrome + Playwright (optional) | For the automatic coordinate conversion and screenshots. Set `ROAD_TEMPLATE_BROWSER_PYTHON` to a Python that has Playwright. Without it the script asks you to press the button yourself. Headless browsers have no WebGPU, so it must be a headed Chrome. |
| Street-lamp model | `lamp_asset` points at `../SkylineGarden0919/assets/lamp.glb`, which the SkylineGarden0919 example writes (`python generate.py --detail`). Generate that example first, or point `lamp_asset` at any lamp glb. |

The script runs, in order:

1. `fetch_osm.py`: downloads six layers. `-SkipFetch` reuses data already downloaded.
2. `create_preview.mjs`: creates an empty SSWorld project at the config's anchor; skipped if the project exists.
3. Without a valid projection cache, `compile.mjs` first writes a bootstrap page (a placeholder scene and a convert button) and syncs it to the preview project; then `--serve-projection` starts in the background and `browser.py project` presses "Re-project coordinates with SSEngine" on the page.
4. `rebuild.ps1 -SyncPreview`: generate, compile, and copy into `~/.ssworld/projects/<name>`.
5. `browser.py shots`: captures views 0–3 into `.cache/road_template/captures/<name>/`.

The script can be re-run: an existing preview project, a valid projection cache and downloaded data are all reused. A 1.6 km² site takes about two minutes, excluding the download.

When only the config or the code changed: `./tools/road_template/rebuild.ps1 -Config <cfg> -SyncPreview`. For style-only iterations also set `ROAD_TEMPLATE_DEV_CACHE=1`, which skips the road network and parcel computation (see section 4).

## 2. Config reference (`configs/template.json`)

| Key | Must change for a new site | Meaning |
|---|---|---|
| `name` | ✔ | SSWorld project name, `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
| `site` | ✔ | Page text: `title`, `label` (corner badge), `page_title` (browser title) |
| `bbox` | ✔ | `[west, south, east, north]`, WGS84 degrees. Keep it within about 2 × 2 km: Guanlan's 3.3 km² is about 1.07 M static triangles and 25 k instances |
| `anchor` | ✔ | `[longitude, latitude, nominal height]`, the bbox centre. It is both the local origin and the point the sun is solved for |
| `input_dir` / `source_prefix` / `output_dir` | ✔ | Data directory and file prefix, output directory. Do not share them between sites |
| `views` | optional | Two lon/lat points, `detail_geo` and `crossing_geo`. Each snaps to the nearest junction whose line of sight is not blocked by a building; the bbox centre is fine |
| `seed` | | Seed for every random placement (species, house types, woodland) |
| `road_defaults` | data-dependent | Default lane count and width per road class. **A class missing from this table gets no pavement** and is listed under `excluded_roads` in `report.json` — check that first on a new site |
| `overrides` | | Per-OSM-ID overrides, e.g. `{"way/280446296": {"width": 7.0, "lanes": 2}}` |
| `lane_width` `shoulder` `sidewalk_width` `curb_width` `curb_height` `corner_radius` | | Road cross-section |
| `tree_spacing` `lamp_spacing` `tree_scale_range` `lamp_asset` | | Street trees and lamps |
| `parcel_frontage` `parcel_depth` `min_parcel_area` | | Indicative parcel size |
| `infill` | | `build_share` share of parcels that get a house, `setbacks` candidate setbacks, `front_hedge_share` share of front-yard hedges |
| `vegetation` | | `woodland_spacing` woodland grid, `forest_belt` width of the belt outside the site, `max_woodland_trees` woodland cap |
| `lighting` | | `date_time` local time with offset, `sun_intensity`, `white_temperature` white balance, `fog_density` |
| `infer_local_crossings` | | Whether to add regular crossings on minor roads |

## 3. The fixed pipeline (13 stages)

| # | Stage | Input → output | Rules | Module |
|---|---|---|---|---|
| 1 | Base data | Overpass → `{prefix}{roads,buildings,landuse,greenery,water_lines,water_polygons}.geojson`, plus `{prefix}osm_raw.json` and `{prefix}source.json` | One bbox query returns every feature with all tags and `@id`; multipolygon relations are assembled from their members (inner rings subtracted). A feature may land in several layers (a reservoir is both land use and water). Clipped to the bbox. Building height is `height` → `building:levels × 3.2` → a per-type default, with the choice recorded in `height_source`. Green space is split into `vegetation_cover` (real vegetation) and `park_or_garden_boundary` (a management boundary, not lawn). `source.json` records the query, the OSM snapshot time, the sha256 of the raw response and the licence | `fetch_osm.py` |
| 2 | Projection | Six layers + anchor/bbox/views → `projection-cache.json` | **Only the engine's native API**: `Cartesian3.fromDegrees`, `eastNorthUpToFixedFrame`, `Matrix4.inverted`/`map`, with no fallback formula. Anchor and round-trip errors must stay under 1 mm. The cache is bound to an input digest and invalidated when the data, anchor, bbox or views change. Only XY is kept; the native Z is not treated as terrain | `projection.py`, `engine_project.mjs` |
| 3 | Roads | Centre lines → carriageway, sidewalks, curbs, ramps, markings, crossings | Split into carriageways, sidewalks, bridges, crossings and exclusions. Tunnels, steps, construction roads and classes missing from `road_defaults` get no pavement. Width priority: override → OSM `width` → lanes × `lane_width` + shoulder → class default. Junctions are classified by degree. Corner radius is `corner_radius`, 24 segments per quarter circle; narrow traffic islands shrink the radius automatically while keeping at least 90 % of their area. Sidewalks are unioned. Markings are clipped to the carriageway. Bridges are drawn only as optional orange guides, never as junctions | `geometry.road_network` |
| 4 | Blocks and parcels | Pavement, water, buildings → blocks, indicative parcels, setback verges | Block = AOI − carriageway − sidewalks − water, inset 2 m as a green verge. Cut into `frontage × depth` cells along the long side of the minimum bounding rectangle. A parcel needs ≥ 5 m of street frontage, ≥ `min_parcel_area`, and no existing building. Interiors that do not fit stay undivided — **no parcel without access is generated** | `geometry.block_parcels` |
| 5 | Ground | All surfaces → layered planes | No DEM; a flat design reference. Layer heights are in the table below and are changed only there | `generator.py` |
| 6 | Water | Water polygons → channel, bed, surface, banks | Channel = water − carriageway and sidewalks, cut out of the base slab, with a bed 1.8 m below. Every water body of at least 20 m² gets a `Plane` + `WaterMaterial` over its minimum rotated rectangle grown by 2 m; the part outside the channel is hidden by the ground. Flow follows the long axis. **`uvScale` follows the aspect ratio**, or the ripples stretch along the long side. With no water the count is 0 and the page hides the "riverside" view | `generator.py` |
| 7 | Green space | Vegetation, verges, land use → lawn and land-use tint | Lawn = OSM vegetation ∪ setback verges ∪ (open land − hard land use). Hard land use (industrial, construction, brownfield, retail) keeps its own tint. A 3 km grass skirt surrounds the data so the scene never floats. The grass texture repeats about every 24 m and tiles seamlessly | `generator.py`, `mesh.textures` |
| 8 | Planting | Road network, parcels, open land → instance rows | Street trees: 1.65 m outside the carriageway at `tree_spacing`; the tree pit must lie fully on the sidewalk, away from crossings, buildings (4 m) and ramps/motorways/service roads; 78 % of each street's trees share one species. Yards: 1–3 trees behind the house, shrubs in front. Woodland: undivided open land plus the outer belt, a jittered grid with noise clustering and species patches; on hard land use the grid spacing grows 1.7× and density drops; the total is capped by `max_woodland_trees`. Species and colours are in `props.PALETTES` and `neighborhood.SPECIES` | `neighborhood.py`, `props.py` |
| 9 | Buildings | Footprints + indicative parcels → building meshes, indicative houses | Existing buildings: extruded footprints, height clamped to 3–100 m, with a parapet and a window band per storey. Indicative houses: parcels drawn by `build_share`, workshops on industrial land; tried in order scale (1, .88, .78) → house type (full size first, cottage last) → setback → sideways shift, and the first option fully inside the parcel and clear of buildings and water wins; it faces the street and gets a driveway, a path to the door and side/back hedges or fences | `neighborhood.plan`, `props.py` |
| 10 | Street furniture | Road network → lamps, tree pits, drains, curb joints, tactile paving | Lamps at `lamp_spacing`, no closer than 18 m, away from crossings; tactile paving only at both ends of real crossings; all indicative | `generator.py` |
| 11 | Scene assembly | The meshes above → component SSDL + instances | Components: Context, Water, RoadSurfaces, StreetDetails, Buildings, Neighborhood, Blocks, Constraints, StreetFurniture. Trees, houses and lamps use empty `Instances` batches that `logic.mjs` fills from `furniture-rows.json`. Native static instances do not follow a parent group's visibility, so layer toggles go through `api.instances.set`, in two groups: furniture and infill. Limits: 512 instances per batch and 1 M triangles per Prefab; `furniture.py` splits by glb face count automatically | `furniture.py`, `generator.py` |
| 12 | Lighting and cameras | date_time, anchor → sky, fog, post-process, six views | The sun azimuth uses the NOAA approximation. The default "block aerial" view is chosen among all junctions and headings within ±36° of the sun's back-right as the one with the most indicative houses in frame (side back-light, avoiding haze when facing the sun). Close-up and crossing views pick junctions with an unobstructed line of sight. The full-extent and north-up plan views are computed from the AOI. The riverside view takes the channel point nearest the centre | `generator.py` |
| 13 | Checks and page | → `report.json`, `entities.json`, `plan.svg`, `index.html` | The run fails if any of 11 checks exceeds 1e-5: overlaps between carriageway/sidewalk/building/parcel, markings outside the carriageway, invalid polygons, parcels without frontage, indicative houses over roads/buildings/outside parcels, water not covering its channel. Page text and the default time are filled into `viewer.html` from the config by `compile.mjs` | `generator.py`, `compile.mjs`, `viewer.*` |

Layer heights (metres):

| River bed | Water | Skirt | Base slab | Land use | Lawn | Driveway / path | Carriageway | Sidewalk | Hedge |
|---|---|---|---|---|---|---|---|---|---|
| -1.8 | -0.35 | -0.07 | -0.065 | -0.015 | 0.005 | 0.035 / 0.04 | 0.08 | 0.23 | 1.25 (front-yard hedge 0.85) |

## 4. Tuning the style

- **In the config**: `infill`, `vegetation`, `lighting`, the road cross-section and spacings (section 2).
- **Code constants**:
  - Ground, road and building colours: the colour arguments of each `save(...)` in `generator.py`.
  - Water colour: `baseColor` / `deepColor` of the `WaterMaterial`.
  - Textures: `mesh.textures`.
  - Tree colours: `props.PALETTES`.
  - House types and colours: `props.HOUSES`, `WORKSHOPS`.
  - Species weights: `neighborhood.SPECIES`.
  - Fog colour and post-processing: the scene template in `generator.py`.
- **Fast iteration**: `ROAD_TEMPLATE_DEV_CACHE=1` caches the road network and parcels in `.cache/road_template/`, keyed only on the config items that affect them. The cache stores Shapely's precision grid with the geometry — pickle drops it, which produced 0.06 m² false positives in the overlap check. The cached path emits mesh vertices in a different order (same vertex set), so **build release output without the cache**.
- **Visual acceptance**: `browser.py shots --config <cfg> --views 0,1,2,3,4,5`. A clean compile does not mean a correct picture; look at the screenshots after every style change.

## 5. Known limits and traps

- **Overpass**: public instances often return 504/429; the script rotates three endpoints with back-off. Mirrors can lag (one snapshot stopped at 2026-05-31 during testing); the endpoint actually used and `osm_base_timestamp` are recorded in `source.json`.
- **Encoding**: configs may contain non-ASCII text. PowerShell 5 must read them with `-Encoding UTF8`, and Python must open JSON with `encoding='utf-8'`, or they break on a GBK system.
- **Several preview pages**: with several browser pages open on one project, preview commands reach only one of them. Take screenshots with `browser.py`, which opens its own page.
- **View avoidance**: only the central line of sight is checked, so a building can still intrude at the frame edge. Move the point in `views` if you do not like it.
- **Extent**: face count grows roughly with bbox area; woodland beyond the cap is thinned.
- **Quality bounds**: aimed at ordinary roads in a flat city. Bridges, tunnels, steps and construction roads are never presented as ground roads; junction corners are local fill geometry with no turning-lane or signal-phase model; there is no longitudinal or cross slope, deck or clearance. Road widths and sections, parcels, houses, yards, trees and lamps are indicative design, marked as such under `limitations` in the report and switchable on the page. This is not a calibrated road-engineering model or a traffic simulation.

## 6. Files

| File | Role |
|---|---|
| `configs/template.json` / `guanlan.json` | Starting point for a new site / the Guanlan instance |
| `new_site.ps1` / `rebuild.ps1` | Full new-site run / generate, compile, sync |
| `fetch_osm.py` | Stage 1 |
| `projection.py`, `engine_project.mjs` | Stage 2 (bridge service and in-page conversion) |
| `geometry.py` | Stages 3–4 |
| `mesh.py` | Indexed deterministic glb, UVs, procedural textures, vertical side walls |
| `props.py` | Procedural trees, shrubs, houses, workshops (facing -Y, origin at the footprint centre, footprint read back from the vertices) |
| `neighborhood.py` | Indicative house placement, yard paving, hedges, woodland |
| `furniture.py` | Instance batch splitting, `StreetFurniture.ssdl`, `furniture-rows.json` |
| `generator.py` | Orchestration, checks and report for stages 5–13 |
| `compile.mjs`, `viewer.*`, `create_preview.mjs`, `browser.py` | Page, compile, preview project, browser automation |
| `test_template.py`, `test_dynamic.mjs` | Regression tests (need a generated Guanlan build first) |

```powershell
python tools/road_template/test_template.py
node tools/road_template/test_dynamic.mjs
```

Source geographic data © OpenStreetMap contributors, ODbL, https://www.openstreetmap.org/copyright. The street-lamp model is the SkylineGarden0919 asset; every other tree, house and texture is generated by these scripts.
