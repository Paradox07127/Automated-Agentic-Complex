# 导入外部动作

[English](motion-import.en.md) · [文档索引](../README.md)

## 概述

`characters/build.py import_motion`（`characters/agentic_complex_build/import_motion.py`）把 VMD、BVH、glTF/GLB、VRMA、FBX 动作离线导入现有角色包，发布一个新的离线角色库。每个角色都走 `motion_import.pipeline.import_file`；App 里的 `agent/agentd/motion_tool.py import` 用同一个 Python 入口，结果是同一种 `endfield-motion-import/v1`。`build.py import_vmd` 是 VMD 专用的离线入口，多了音乐片段和源模型骨架等选项，见「VMD 导入」。

在 App 里，在「角色 › 导入」导入动作，或把 VMD、ZIP 文件直接拖到角色身上。

## App 里的 MMD 工程导入

一首 MMD 曲子的整包（文件夹、ZIP 或多选的文件）可以一次导入共享舞曲库，包里可以有多条身体动作、口型 VMD、多条镜头和多段音源：

- `motion_tool.py mmd-scan` 先把文件分好类：有骨骼关键帧的 VMD 是身体，只有相机关键帧的是镜头，只有表情关键帧的是口型（表情）VMD，音频按后缀，其余列为忽略。文件夹递归走，跳过隐藏项和 `__MACOSX`；ZIP 展开到临时目录。
- 每条身体按文件名里和别的身体不同的那段起名（如 `…_SampleDancerA_v1.1[f-19].vmd` 和 `…_SampleDancerB_v1.1[f-19].vmd` 分别是 `SampleDancerA`、`SampleDancerB`）。
- 身体 VMD 主名末尾的 `[fN]`（如 `[f-19]`、`[f4930]`）表示动作放在歌曲的第 N 帧（30 fps），音乐偏移缺省取 N / 30 秒，可以是负数：负数表示音乐在这么多秒静音之后才开始。
- 缺省选最长的身体、最长的镜头、第一段音源，以及文件名含所选身体名字的口型 VMD（只有一个口型时就用它）。页面上可以逐项改选。
- `motion_tool.py import` 的 `--morph` 给口型 VMD、`--camera` 给镜头 VMD，两者只配 VMD 身体；`--project`、`--role` 记下曲名和这支身体的角色。直接拖进来的多个文件或 ZIP 也按同样的分类取缺省选择，没用上的文件记成告警 `ignored_file`，不再因为「多于一个」失败。
- `motion_tool.py mmd-media` 给库里的一首换音乐或偏移：只换音乐，不重新烘焙，id 不变；当前角色的那一行马上换，别的角色在下一次 `mmd-sync` 只换音乐。
- 上限：ZIP 文件 512 MiB；一个 ZIP 或文件夹最多 256 个文件、合计 1 GiB。

## 工具环境

在仓库根目录创建 pipeline 工具环境（Python 3.12），按 `requirements-mmd.txt` 安装 NumPy：

```sh
uv venv --python 3.12 .local/venvs/pipeline
uv pip install --python .local/venvs/pipeline/bin/python3 \
  -r characters/agentic_complex_build/requirements-mmd.txt
```

## 命令与输出

```sh
.local/venvs/pipeline/bin/python3 -I \
  characters/build.py import_motion \
  --library /absolute/path/to/existing-library \
  --character <id> --character <id> \
  --source /absolute/path/to/walk.bvh \
  --title '导入走路' --output .local/cache/my-motion-generation --export
```

旗标的定义见[外部动作导入合同](../../protocol/character-library/MOTION-IMPORT.md)。`--output` 必须是新目录，不能在输入库里面。

输出：

- `packages-built/<id>/`：导入后的角色包。
- `library/current.json`：新库，含全部原角色；选中角色的包版本补丁号加 1，默认角色保留。包用 APFS 克隆复制，不改输入库。
- `import-result.json`：数组，每个角色一项，每项是 `take.build_result(...)` 的结果，`created_at` 为 UTC 秒；可用 `take.check_result` 校验。
- 加 `--export` 后还有 `<id>.endfield-character`。

失败时删掉整个输出目录。离线入口不写库索引 `motion-imports/<角色>/imports.json`，也不调宿主 `--validate-pack`；这两步只在 App 的 `motion_tool.py import` 里做。

## 格式

`--format auto`（缺省）时，`motion_import/formats.py` 的 `detect` 先看内容、最后看后缀：

1. `Vocaloid Motion Data` 文件头 → `vmd`；
2. `glTF` 文件头的 GLB 2 → 用了 `VRMC_vrm_animation` 扩展为 `vrma`，否则 `gltf`；
3. `PK\x03\x04` → `zip`；`Kaydara FBX Binary` → `fbx`；
4. 文本以 `HIERARCHY` 开头 → `bvh`；以 `; FBX` 开头 → `fbx`；
5. 以 `{` 开头且是带 `asset` 的 JSON → `vrma` 或 `gltf`（同 2）；
6. 都不是时按后缀：`.vmd`、`.bvh`、`.glb`/`.gltf`、`.vrma`、`.fbx`、`.zip`。

- 能导入的是 `vmd`、`bvh`、`gltf`、`vrma`、`fbx`。
- `fbx` 由 `AAC_FBX_TOOL` 指的 `fbx-motion` 工具读，没有时报 `unsupported_format: fbx_tool_missing`。App 自带这个工具；离线用时可用 `characters/agentic_complex_build/motion_import/native/build.sh <输出路径>` 编出来。
- `zip` 只认出、不导入（报 `unsupported_format: zip`）。App 侧由 `agent/agentd/motion/zip_import.py` 展开 ZIP。
- VMD 由 `import_vmd.import_motion` 重定向（`retarget: "mmd-vmd"`）。其他格式先读成规范关节上的 `MotionTake`，重采样到 30 fps，再由 `motion_import/bake.py` 按骨骼方向烘到角色原生骨架（`retarget: "humanoid-bone-direction"`）。

## 重定向

- 源动作按骨名映射到规范关节（`take.CANONICAL`，含 `HandTip`）。认不出的骨记进 `unmapped`，告警 `unmapped_bones`；缺腿等必需骨报 `unmapped_skeleton: <规范名>`，可用 `--bone-map` 补。
- 中性姿势：BVH 是全部通道为 0 时的 OFFSET 层级（全局旋转为单位阵）；glTF、VRMA 是每个节点的缺省 TRS（VRMA 扩展要求它是 VRM T-pose）。旋转都取相对中性姿势的全局旋转。
- 不猜单位、不转轴：源文件的长度单位和上方向原样保留。烘焙只用骨骼方向和相对旋转，所以厘米/米、Y 上/Z 上的同一段动作烘出同样的姿势。
- 缺的关节按中性姿势合成，与单位无关：缺 `Shoulder` 取 `Chest` 与 `Arm` 的中点（`shoulder_synthesized`）；缺 `HandTip` 取 `Hand + 0.4×(Hand − ForeArm)`（`hand_tip_synthesized`）；缺 `ToeBase` 沿面朝方向前伸腿长的 0.12（`toe_synthesized`）。缺 `Neck1`、VRM 缺 `chest`、Hips 直连脖子时，按 `humanoid_map.SPINE_HEIGHTS` 在 Hips→Head 的连线上补出脊柱和脖子，旋转取下方那根真实骨（`synthesized_bones: <规范名,…>`）。缺四肢、Hips 或 Head 仍报 `unmapped_skeleton`。
- 触地在目标骨架空间（米、Y 上）判定，再锁脚；`--no-foot-lock` 关闭。
- glTF 里的镜像节点（行列式小于 0）报 `bad_source: mirrored_node`。

## 上限与覆盖

上限：

- 动作、音乐和表情片段单段最长 360 秒（`take.MAX_SECONDS`、`motion_tool.MAX_SECONDS`），导入后统一 30 fps。
- ZIP 文件 512 MiB；一个 ZIP 或一个文件夹最多 256 个文件、合计 1 GiB。
- 文件大小：VMD、BVH 64 MiB，glTF/GLB/VRMA 256 MiB，背景音乐 256 MiB。
- 采样数：BVH、glTF 的帧数 × 关节/节点数不超过 4,000,000；BVH 最多 512 个关节。
- glTF 不收 sparse accessor（`bad_source: sparse_accessor`）。

覆盖：

- 身体和根位移：所有能导入的格式都导入。
- 手指：VMD 照常重定向（`fingers: "retargeted"`）。其他格式的手指骨能映射时也重定向；映射不到时保持 rest（`fingers: "rest"`，告警 `fingers_rest`）。
- 表情：VMD 的表情（身体 VMD 自带的，或 `--morph` 给的口型 VMD）进 `tracks.face`。glTF morph 权重和 VRMA 表情只解析，列在 `source.expressions`，不进包（告警 `expressions_not_applied`）。
- 相机：VMD 相机进 `tracks.camera`，只能经 App 导入；离线入口没有相机旗标，其他格式不导入相机。
- VRMA 的 `lookAt` 忽略（告警 `look_at_ignored`）；VRMA 非 hips 的平移和所有缩放通道忽略（`translation_ignored`、`scale_ignored`）。

## VMD 导入

`build.py import_vmd`（`characters/agentic_complex_build/import_vmd.py`）读取现有角色包的真实骨架，生成原生 `ActorArchive` 曲线、动作菜单项和完整包库存，再发布到一个新的离线角色库。它用「工具环境」里的 pipeline 环境，不需要 SciPy；App 的 VMD 导入用 App 内置的 NumPy。

```sh
.local/venvs/pipeline/bin/python3 -I \
  characters/build.py import_vmd \
  --library /absolute/path/to/existing-library \
  --character <id> --character <id> \
  --vmd /absolute/path/to/motion.vmd \
  --bgm /absolute/path/to/music.wav \
  --title '导入舞蹈' --output .local/cache/my-vmd-generation --export
```

- 输出同 `import_motion`：`packages-built/<id>/`、`library/current.json`、`import-result.json`，加 `--export` 后还有各角色的 `.endfield-character`。导入的动作出现在角色现有的动作菜单里。
- `--source-model original.pmd` 用动作原模型的 PMD 骨架校准；省略时用项目自行编写的标准 MMD 控制骨架。原模型比例不同会影响重定向效果。角色骨架、rest scale、原有动作、网格、shader 和光照资产保留。
- `--start 30 --duration 4` 只导入一段，起止量化到 30 fps。单段最多 360 秒，输入范围和求值内存都有上限；长文件可以分段导入。`--no-foot-ik` 关闭目标脚部修正。
- 每次输出必须是新目录，不能在输入包或输入库里面。失败时清理本次的暂存目录。

### 音乐同步

- `--bgm` 经系统的 `/usr/bin/afconvert` 解码为双声道 48 kHz PCM。默认从动作的 `--start` 位置截取音乐；`--bgm-start` 单独指定音轨起点（动作第 0 帧对应源音频的这一秒；负数时音乐先补这么多秒静音）。音轨截到动作长度，不够的部分补静音，补齐的帧数记进报告。
- 音乐在这次动作的第一个真实 Metal 提交帧确认后开始。动画时间跟随 `AVAudioPlayerNode` 消费的源采样位置；渲染器隐藏或暂停时两者一起冻结，恢复后继续。循环播放时音轨从零开始；动作被替换或停止时旧音轨停下。
- 这个时钟表示源音频的渲染进度；显示器呈现、音频设备和扬声器各有延迟。回执里的 `max_animation_clock_drift_s` 不是声学或端到端的同步精度。

### 库代际与回滚

离线命令不改写输入库，也不改安装版。输出库用独立的 APFS 克隆文件，没有共享的可写链接。新库包含所有原角色，选中角色的包版本补丁号加 1，默认角色保留。

角色包安装器拒绝替换同 ID 的已有包；App 的 VMD 导入走单独的升级流程。离线输出包可以导入一个全新的库；已有 ID 的更新要在离线库切换或发行种子迁移中完成。在 App 里试新库时，把 config.json 的 `character_catalog` 指向新库的 `library/current.json`。回滚时把它改回原库。

### 覆盖与限制

- 支持 VMD 0002 的身体、根位移、Bezier 插值、手指、扭转和标准足/趾 IK。源模型只接受 PMD。未知控制骨骼的覆盖情况写进每次的导入报告。
- 表情：VMD 带 morph，且角色包有 `original-face-controls.json`（`endfield-original-face-controls-v2`）和 `emotion-lipsync.json` 时，`import_vmd.py` 用 `mmd/morph.py` 把能映射的 morph 写成 `animation/face/<clip>.json`，登记进表情库 `facial-animations.json`，宿主随动作播放。包里的 `mmd-morph-map.json` 覆盖默认映射。
- 相机：`motion_tool.py` 的导入从输入文件里认出相机 VMD 时，`import_vmd.py` 写出 `animation/camera/<clip>.json`；宿主只在 `set_render.camera.track` 为 `stage` 的全屏视口下按它在舞台框里取景。`build.py import_vmd` 命令行不收相机 VMD。
- 不导入灯光和 PMX 模型，不做完整的 MMD 物理。
- 竖版取景沿用角色原来的构图，大幅横移或伸展可能超出画框。

## 和合同的关系

导入请求旗标、导入结果 `endfield-motion-import/v1`、包内报告、库索引和告警/失败码定义在[外部动作导入合同](../../protocol/character-library/MOTION-IMPORT.md)，结构和校验在 `motion_import/take.py`。本页只讲离线命令怎么用；两者不一致时以合同为准。
