# 外部动作导入

状态：v3，2026-11-25（`mmd-media` 只换音乐、id 不变，`mmd-sync` 加 `music`）；v2 2026-11-25（MMD 共享库 v2、`mmd-scan`、`mmd-media`、360 秒）。
参与方：写——`characters/agentic_complex_build/motion_import`（导入结果、包内报告、索引的结构和校验）、`agent/agentd/motion_tool.py`（导入、索引、进度行）、`agent/agentd/outfit_tool.py`（进度行）；读——`app/electron/src/common/imports.ts`（`importedMotion`）、`app/electron/src/common/import-state.ts`（进度行）、`characters/build.py import_motion`（离线导入）。

常量、结构和校验在 `motion_import/take.py`：`RESULT_SCHEMA`、`INDEX_SCHEMA`、`MMD_SCHEMA`、`FORMATS`、`REASONS`、`WARNINGS`、`MAX_SECONDS`、`check_result`、`check_index`、`check_mmd_index`。样例在 [fixtures/motion-import/](fixtures/motion-import/)。

## 1. 导入请求

`motion_tool.py import` 和 `build.py import_motion` 共用这些参数：

| 旗标 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `--source` | 路径 | 必填 | 动作源（单个），替换 `--vmd`；ZIP 也从这里传 |
| `--format` | `auto\|vmd\|bvh\|gltf\|vrma\|fbx` | `auto` | `auto` 时由 `formats.detect` 按内容认，认不出再看后缀 |
| `--take` | int ≥ 0 | 0 | glTF 多段动画、FBX 多个 AnimationStack 时选第几段；VMD、BVH、VRMA 只有 0 |
| `--title` | 1–64 字符 | 文件名去后缀 | |
| `--bgm` | 路径 | 无 | 背景音乐 |
| `--bgm-start` | 秒，有限数，可为负 | 不传 | 动作第 0 帧对应音源里的这一秒；负数表示音乐在 `-bgm_start` 秒静音之后才开始。只在有音乐时传给导入器（没有音乐时丢掉）；不传时 VMD 的 identity 和以前一样。非有限数报 `bad_source` |
| `--no-foot-lock` | 开关 | 锁脚 | VMD 映射到 `foot_ik=False` |
| `--bone-map` | 路径（JSON `{规范名: 源骨名}`） | 无 | 只对 bvh、gltf |
| `--extra` | 路径，可重复 | 无 | 附加文件；和 ZIP 里的文件一样按 §8 `mmd-scan` 分类，取它的 `suggested`（最长的身体、口型、最长的相机、第一个音频、`[fN]` 给的偏移），旗标给了的以旗标为准；没用上的文件记成告警 `ignored_file: <名>`。分类只在 Python 里做这一处，宿主拖入多个文件时不自己分类 |
| `--morph` | 路径 | 无 | 口型/表情 VMD（只有表情关键帧），只配 VMD 身体，传给 `import_motion(morph_vmd=)` |
| `--camera` | 路径 | 无 | 相机 VMD，只配 VMD 身体 |
| `--project` | 字符串 | 无 | 曲名，进共享库条目的 `project.title`；不传时 `project` 为 null |
| `--role` | 字符串 | 无 | 这支身体在曲中的角色（`mmd-scan` 的 `label`），进 `project.role`；只随 `--project` 记录 |

`--library`、`--character`、`--validate-with` 同 [C9](../C9-agentd-process/CONTRACT.md) `motion_tool.py` 节。不引入 `--input`。

ZIP：`formats.detect` 认得 `zip`，但 `formats.importer('zip')` 不实现（报 `unsupported_format: zip`）；ZIP 由 motion_tool 侧的 `agent/agentd/motion/zip_import.py` 展开。`--morph`、`--camera` 配非 VMD 身体时报 `bad_source`。

## 2. 导入结果 `endfield-motion-import/v1`

motion_tool 成功时 stdout 一行；`build.py import_motion` 的 `import-result.json` 每项。样例 `result-bvh.json`、`result-vmd.json`：

```json
{"schema": "endfield-motion-import/v1", "ok": true, "character": "aster", "version": "1.4.3", "format": "bvh",
 "action": {"id": "bvh_0123456789abcdef", "clip": "imported_bvh_0123456789abcdef", "title": "walk", "duration_s": 12.5, "frames": 376, "has_bgm": false},
 "source": {"name": "walk.bvh", "sha256": "<64hex>", "take": 0, "takes": 1, "frame_rate": 120.0, "frames": 1500, "zip": null, "expressions": []},
 "tracks": {"body": {"retarget": "humanoid-bone-direction", "unmapped": ["LHipJoint"], "fingers": "rest", "foot_lock": true},
            "face": null, "camera": null, "audio": null},
 "playback": {"speeds": [0.5, 1, 2], "loop": false},
 "warnings": ["fingers_rest"], "created_at": "2026-11-15T10:00:00+00:00"}
```

- 键顺序如上（`take.build_result`）。`action.{id,title,duration_s,has_bgm}` 的键名和语义不变。
- `tracks` 只有 `body`、`face`、`camera`、`audio` 四个键；`face`、`camera`、`audio` 没有时为 null。
- `tracks.body`：`retarget` 为 `mmd-vmd` 或 `humanoid-bone-direction`；VMD 另带 `coverage`（VMD 报告里的 `coverage` 原样），`unmapped` 为 `[]`，`fingers` 为 `retargeted`。
- `tracks.face`（VMD 导入写）：`{facial_animation, file, mapping: "package"|"default", mapped: [名], unmapped: [名], applied: bool}`；`file` 是包内 `animation/face/<clip>.json`；映射到的表情数就是 `len(mapped)`，不单列。
- `tracks.camera`（VMD 导入写）：`{file, source_sha256, frames, cuts: [帧号], perspective: bool, coordinate_boundary, applied: bool}`；`file` 是包内 `animation/camera/<clip>.json`。
- `tracks.audio`：`{file: "animation/music/<identity>.wav", source_sha256, offset_s, padded_frames, sample_rate: 48000, channels: 2, length_s, rate: 1.0}`，由 `take.audio_track` 从 `import_vmd.prepare_music` 的返回算出；`rate` 是导入时烘进去的音频/动作时间比，恒 1.0，运行时变速走 C3 `speed`。
- `playback.speeds`：不依赖 C3 `motion_media` 能力时允许的速度，有音频时 `[1]`，否则 `[0.5, 1, 2]`；`loop` 恒 false（无缝循环走 C3 `action_loop`）。
- id：`<format>_<sha256(canonical_json{format, source, take, foot_lock, bone_map, bgm, bgm_start})[:16]>`，片段 `imported_<format>_<同上>`；VMD 保持 `mmd_<identity>` / `imported_vmd_<identity>`。trigger `导入 <BVH|glTF|VRMA|FBX> · 手动播放`。动作 id 与包版本无关，改名不变。
- 失败：stderr 最后一行 `{"ok": false, "reason", "detail"}`。`reason` 全集（`take.REASONS`）：`validate_failed`、`too_many_actions`、`too_many_media`、`bad_vmd`、`too_long`、`missing_bones`、`busy`、`internal`、`unsupported_format`、`bad_source`（非 VMD 的解析失败；VMD 仍报 `bad_vmd`）、`no_animation`、`unmapped_skeleton`、`already_imported`、`unknown_action`、`not_imported`、`bad_title`、`bad_zip`（ZIP 不安全、损坏或超限）、`linked_motion`（别的动作衔接到要删的动作，或别的动作行用到它）、`outside_package`（包内 JSON 指向清单外的文件）。
- 告警码（`take.WARNINGS`）：`fingers_rest`、`toe_synthesized`、`hand_tip_synthesized`、`shoulder_synthesized`、`scale_ignored`、`translation_ignored`、`expression_clamped`、`expressions_not_applied`、`look_at_ignored`、`unmapped_bones`、`synthesized_bones`（后接逗号连接的规范名）。
- 校验：`take.check_result(doc)` 逐键核类型，`ok` 必须为 true，`character`、`version`、`created_at` 为字符串；不符抛 `ValueError('invalid_result: <键路径>')`。

## 3. 包内报告

- 新格式：`provenance/<format>-<identity>.json`，内容 = 导入结果去掉 `ok`、`version`、`created_at`（schema 不变，`take.report_document` 生成，`take.check_result(doc, report=True)` 校验）。样例 `report-bvh.json`。同输入重复导入字节一致。
- 报告里的 `face`、`camera` 形状同 `tracks.face`、`tracks.camera`，另可带诊断键 `controls`、`keys`、`tolerance`（都可省）；导入结果里不带这几个键。
- VMD：`provenance/vmd-<identity>.json`（`endfield-vmd-import/v1`）不变；VMD 导入往里加可选 `face`、`camera`（形状同上），VMD 适配器原样搬进结果。
- 不新增别的包文件；`provenance/` 由 inventory 整个收进包。

## 4. 库索引 `<库根>/motion-imports/<角色>/imports.json` → `endfield-motion-imports/v2`

样例 `index-v2.json`：

```json
{"schema": "endfield-motion-imports/v2", "imports": [
 {"action": "bvh_…", "clip": "imported_bvh_…", "format": "bvh", "title": "walk",
  "source": {"file": "<sha>.bvh", "sha256": "<sha>", "name": "walk.bvh"},
  "bgm": {"file": "<sha>.wav", "sha256": "<sha>", "offset_s": 0.0},
  "camera": null, "zip": null, "morphs_mapped": [], "morphs_unmapped": [],
  "created_at": "2026-11-15T10:00:00+00:00", "removed_at": null}]}
```

- `bgm` 没有时为 null；`camera`、`zip` 都是 `{file, sha256, name}` 或 null。`take.check_index` 校验，不符抛 `ValueError('invalid_index: <键路径>')`。
- 改名更新 `title`；删除写 `removed_at`，然后删掉 `motion-imports/<角色>/` 下没有被任何 `removed_at == null` 条目（`source`、`bgm`、`camera` 的 `file`）引用的文件；`action` 为 null 的旧条目一律当作仍在引用。

## 5. motion_tool 其他子命令

stdout 一行，失败同 §2。

| 子命令 | 参数 | 成功行 |
|---|---|---|
| `probe` | `--source [--format] [--take]` | `{ok:true, format, takes:[{index,name,duration_s,frames,frame_rate}], has_face, has_camera, warnings}`；VMD 的 `has_face` 是有表情关键帧，`has_camera` 是有相机关键帧 |
| `list` | `--library --character` | `{ok:true, character, version, motions:[{id, clip, title, format, duration_s, has_bgm, created_at, warnings}]}` |
| `rename` | `--library --character --action --title --validate-with` | `{ok:true, character, version, id, title}` |
| `remove` | `--library --character --action --validate-with` | `{ok:true, character, version, id}` |

- `list`：读当前包 `provenance/` 里 schema 为 `endfield-vmd-import/v1` 或 `endfield-motion-import/v1` 的报告，`action` 还在 `animation/actions.json` 里的才算；标题取 `actions.json` 那行的 `name`，时长取 `duration`，`has_bgm` 看报告（VMD `bgm` 非空 / 新格式 `tracks.audio` 非空），`created_at` 取 `imports.json` 同 `action` 的条目（没有就 null），`warnings` 取报告（VMD 为 `[]`）；顺序同 `actions.json`。
- `rename` 只改 `actions.json` 那行 `name`，报告不动；`remove` 撤掉导入为这条 clip 写的每一处（片段、archive 条目、palette、intent map、`actions.json`、起止站姿和 blend-times、`motion-media.json` 轨和 WAV、它的报告）。
- 两者都走"克隆 → 改 → 版本 +1 → `provenance/edit-<16hex>.json` → inventory → 包校验 → `--validate-pack` → `Library.upgrade`"，和导入同一把锁。

## 6. 跨线约定

- 本合同定：CLI（`--source` 单个 + `--bgm` + 可重复的 `--extra`）；导入结果外壳和 `tracks.face`、`tracks.camera`、`tracks.audio`、`playback` 的形状；`endfield-vmd-import/v1` 报告新增的可选 `face`、`camera`；`imports.json` v2 的字段全集。
- 本合同不定，由各自的格式和代码定：`motion-media.json` v2、`facial-animations.json` 条目、包内 `animation/face/<clip>.json` 和 `animation/camera/<clip>.json` 的文件格式、C3 `motion_media` / `action_loop`、BGM 变速、ZIP 展开（`agent/agentd/motion/zip_import.py`）。
- VRMA 表情：解析成内存里的 `Expression` 曲线，结果里只报 `source.expressions` 和告警 `expressions_not_applied`。

## 7. 限制

- 单段动作、音乐、表情片段最长 360 秒（`take.MAX_SECONDS`、`motion_tool.MAX_SECONDS`）。
- ZIP 文件 ≤ 512 MiB；一个 ZIP 或一个文件夹里最多 256 个文件、合计 1 GiB（ZIP 的条目数含目录和跳过的条目）。超限：ZIP 报 `bad_zip`，文件夹报 `bad_source`。
- 不收 glTF sparse accessor；`formats.importer` 不导入 ZIP（ZIP 由 `agent/agentd/motion/zip_import.py` 展开，见 §1）；忽略 VRMA LookAt。
- 表情只解析，不进包。
- 非 VMD 格式的手指骨映射不到时保持 rest（`tracks.body.fingers: "rest"`、告警 `fingers_rest`）。
- 导入的动作在角色包里；导出角色包会带上导入的动作。

## 8. MMD 共享库 `<库根>/mmd-library/index.json` → `endfield-mmd-library/v2`

VMD（含装着 VMD 的 ZIP）导入后进库里所有角色共用的一张表；每个角色各烘一份进自己的包，动作 id 相同（`mmd_<identity>`，identity 不含角色）。BVH、glTF、VRMA、FBX 不进这张表，照旧走 §4。样例 `fixtures/motion-import/mmd-library-v2.json`，`take.check_mmd_index` 校验。

```json
{"schema": "endfield-mmd-library/v2", "entries": [
 {"id": "mmd_0123456789abcdef", "title": "愛包ダンスホール · HimeTanaka", "duration_s": 223.3,
  "created_at": "2026-11-25T10:00:00+00:00", "removed_at": null,
  "source": {"file": "<sha>.vmd", "sha256": "<sha>", "name": "a.vmd"},
  "morph": null, "camera": {"file": "…", "sha256": "…", "name": "cam.vmd"},
  "bgm": {"file": "<sha>.wav", "sha256": "<sha>", "name": "inst.wav", "offset_s": -0.633},
  "foot_lock": true, "has_face": true,
  "project": {"title": "愛包ダンスホール", "role": "HimeTanaka", "place_frame": -19},
  "failures": {"aster": {"reason": "missing_bones", "detail": "…", "package_sha256": "<sha>"}}}]}
```

- 源文件按内容寻址放 `<库根>/mmd-library/sources/`；`source`、`morph`、`camera` 是 `{file, sha256, name}`（后两个可为 null），`bgm` 是 `{file, sha256, name, offset_s}` 或 null。ZIP 本身不保留，只留烘焙用到的文件。未删条目不再引用的源文件随写索引删掉。
- `bgm.offset_s`：没传 `--bgm-start` 时为 null。`foot_lock`：导入时的锁脚。`has_face`：第一次烘焙是否写出了表情片段。`project`：没传 `--project` 时为 null；`place_frame` 取身体文件名末尾的 `[fN]`，没有为 null。
- v1 文件或没有文件读作空的 v2 库，不迁移（App 随新版本发布）。
- 某角色「已烘」不记录：它的包里有 `provenance/vmd-<identity>.json` 且 `animation/actions.json` 有这一行就算。
- `failures` 只记烘失败的角色；该角色包的 sha256 变了才重试。
- VMD 导入不写 `motion-imports/<角色>/imports.json`。

子命令（stdout 最后一行是结果，失败同 §2）：

| 子命令 | 参数 | 成功行 |
|---|---|---|
| `import` | 同 §1 | 同 §2；VMD 另在共享库加条目，同 id 已在且未删时不重复加 |
| `mmd-scan` | `--source <路径> [--extra <路径>]... --unpack-to <目录>` | `{ok:true, title, root, bodies:[{path, name, label, model, duration_s, place_frame, has_morph}], faces:[{path, name, duration_s, morphs}], cameras:[{path, name, duration_s, place_frame}], audio:[{path, name}], ignored:[{name, reason}], suggested:{body, face, camera, audio, bgm_start_s}}` |
| `mmd-media` | `--library --character --action <mmd_ id> (--bgm <音频> \| --no-bgm) [--bgm-start] --validate-with` | `{ok:true, character, version, action:{id, title, duration_s, has_bgm}}` |
| `mmd-sync` | `--library --character --validate-with` | `{ok:true, character, version, baked:[id], renamed:[id], music:[id], removed:[id], failed:[{id, reason, detail}]}` |
| `mmd-list` | `--library` | `{ok:true, entries:[{id, title, duration_s, has_bgm, has_camera, has_face, project, role, created_at, characters:[{id, state, reason}]}]}` |
| `rename` / `remove` | 同 §5 | 同 §5 |

- `mmd-scan`：路径是文件夹、`.zip`、`.vmd` 或音频（`zip_import.AUDIO`）。文件夹递归走，跳过隐藏项和 `__MACOSX`；ZIP 展开到 `--unpack-to/<序号>/`（工具创建 `--unpack-to`，它事先不能存在，否则 `bad_source`）。每个 `.vmd` 都读：有骨骼关键帧 → `bodies`；否则有相机关键帧 → `cameras`；否则有表情关键帧 → `faces`；否则 `ignored`（`no_keys`）；读不了的 `ignored`（`bad_vmd`）。音频按后缀；别的 `ignored`（`not_motion`）。没有身体报 `bad_vmd`（`detail` `no body motion`）。
- 各列表按 `name` 排序；`path` 是绝对路径；`duration_s` = 最后一帧 / 30（相机按相机关键帧）；`model` 是 VMD 头里的模型名；`morphs` 是不同表情名的个数；`title` 是文件夹名、ZIP 或单个文件的主名；`root` 是文件夹、`--unpack-to` 或单个文件所在目录。
- `label`：身体文件主名（去掉 `[fN]`）去掉所有身体共有的前缀和后缀后剩下的部分（前缀截到最后一个分隔符 `_ -.` 之后，后缀从第一个分隔符起，结果再去两端分隔符）；只有一支身体或没有差别时是整个主名。`place_frame`：主名末尾 `[fN]` / `[f-N]` 的 N，没有为 null。
- `suggested`：`body` 最长的身体（同长取名字靠前的）；`face` 只有一个口型时取它，否则取主名含建议身体 `label` 的，没有为 null；`camera` 最长的相机或 null；`audio` 第一个音频或 null；`bgm_start_s` 建议身体的 `place_frame / 30` 四舍五入到 3 位，没有为 null。都是对应列表里的下标。
- `mmd-media` 只换条目的音乐和偏移，不重定向、不重新烘焙：id、`created_at`、`failures` 不变，条目的 `bgm` 换成新音乐（`--no-bgm` 为 null），不再用的音源被回收。当前角色包里有这一行时只换包里的音乐（`animation/music/<identity>.wav`、`motion-media.json` 这条 track 的 `audio`、`blend-times.json` 的 `blend_in_s`、报告的 `bgm`；track 没有音乐、口型和相机了就删掉），一次包校验、一次 `Library.upgrade`；没有这一行时只改共享库，`version` 是原版本。`--action` 不是未删条目时报 `unknown_action`。
- `mmd-sync` 把共享库对齐到这个角色：未删条目缺的按条目存的选项（身体、口型、相机、音乐、偏移、锁脚、标题）烘进去，用条目的 id；标题和库里不同的改名；包里这一行的音乐（报告 `bgm` 的 `source_sha256`、`source_start_seconds`）和条目的（`bgm.sha256`、`bgm.offset_s`，null 为 0）不同的只换音乐，同 `mmd-media`，不重新烘焙，记进 `music`；标题和音乐都不同时先改名再换音乐；库里已删而包里还有的删掉；包里有、库里没有任何条目叫这个 id 的导入 `mmd_` 行也删掉。所有改动链在同一串 stage 上，最后一次包校验、一次 `Library.upgrade`；没有改动就不发布，`version` 是原版本。单条失败写进 `failures` 并跳过。
- `mmd-sync` 在结果行之前写 §9 的进度行，每行另带 `total`（条目数加要删的无主行数）和 `done`（已处理条数）；每处理完一条写一行，开始时先写 `stage: "read"`、`fraction: 0`、`done: 0`。
- `mmd-sync` 收到 SIGTERM：删掉 stage、不发布、不改共享库，退出码 143。
- `mmd-list` 的 `characters` 列目录里每个角色：`state` 为 `baked`、`pending` 或 `failed`；包里有这一行但音乐和条目不同（同上）为 `pending`；`reason` 只在 `failed` 时非 null。`project`、`role` 取条目的 `project.title`、`project.role`，没有为 null。条目按 `created_at` 升序，已删的不列。
- `rename`、`remove` 的 `--action` 是 `mmd_` id 时同时改共享库（`title` / `removed_at`）。当前角色包里没有这一行（还没烘或烘失败）时只改共享库，成功行的 `version` 是原版本。其他角色由下一次 `mmd-sync` 跟上。
- 和导入同一把锁（`.vmd-stage/.lock`）；被占时报 `busy`。`mmd-scan` 不拿锁。

## 9. 进度行

`motion_tool.py import`、`mmd-media`、`mmd-sync` 和 `outfit_tool.py import` 在结果行之前往 stdout 写进度行，每行一个：

```json
{"event": "progress", "stage": "retarget", "fraction": 0.42}
```

- `stage`：`read`、`sample`、`retarget`、`compose`、`write`、`validate`、`publish` 之一。
- `fraction`：整条子命令的总进度，0–1，单调不减；第一行是 0，成功时最后一个进度行是 1。
- 各阶段在条上的份额写在 `motion_tool.py` 的 `VMD_STAGES`、`TAKE_STAGES`、`MEDIA_STAGES`、`SYNC_ENTRIES` 和 `outfit_tool.py` 的 `STAGES`。
- 失败时 stdout 只有已经写出的进度行，失败行仍在 stderr 最后一行。
- 读方：`app/electron/src/common/import-state.ts`（`parseProgress`）。

## 怎么改

改这份合同要升版本号，同一个提交里改 `motion_import/take.py` 和 `fixtures/motion-import/` 的样例。
