# 角色库文件

状态：v2.3，2026-11-22（v2.2 2026-11-20，v2.1 2026-11-20，v2 2026-11-19，v1.7 2026-11-19，v1.6 2026-11-17，v1.5 2026-11-17，v1.4 2026-11-16，v1.3 2026-11-16，v1.2 2026-11-16，v1.1 2026-11-15，v1 2026-11-01）。只描述现行实现，不改行为。
参与方：角色构建（`characters`，生产方）→ agentd 角色库（`agent/agentd/character_library.py`，安装、发布）→ Companion、Metal 宿主（读）。

## 共享常量

[constants.json](constants.json) 是 ID、版本、SHA-256 正则，基础能力，禁止的可执行后缀，原生条目的 blob 字段和各文件 schema 的受检来源。运行时不读它（`protocol/` 不进 Agentic Complex.app）：两边各自保留常量，测试比对。

- Python：`agent/agentd/character_library.py:21-28`，`agent/agentd/tests/test_character_library_contract.py`
- Swift：`CharacterPackage` 的 `idPattern` 等（`private/renderer/character-assets/Sources/CharacterAssets/CharacterCatalog.swift:154-159`），`CharacterLibraryContractTests`
- 原生字段：`ActorNativeBundleCharacter`（`private/renderer/runtime/Sources/MetalActorRuntime/ActorNativeBundle.swift:4-9`），`ActorNativeBundleContractTests`

## 库里的文件

| 文件 | schema | 谁写 | 谁读 |
|---|---|---|---|
| `current.json`（同内容另存 `catalog-<revision>.json`） | `endfield-character-library/v1` | `character_library.py:556`（`Library.publish`）；`materialize_library` 复制到 app 种子（`:599`） | `character_library.py:440`（`Library.snapshot`）；`CharacterCatalog.swift:195` |
| `packages/<id>/<sha>/character.json`，`<sha>` 是它自身的 SHA-256 | `endfield-character-definition`，`schema_version` 1 | 本机构建工具 `assemble.py:72`（不在公开仓库）生成；`character_library.py:494`（`Library.install`）安装 | `character_library.py:228`（`Package`）；`CharacterCatalog.swift:67` |
| `packages/<id>/<sha>/runtime/bundle.json`（单角色原生包） | `metal-native-character-bundle/v1` | `characters/packaging/native_bundle.py:272`（`build`），由 `assemble.py:47` 调用 | `character_library.py:304`；`CharacterCatalog.swift:106`（核 SHA）、`:116`（解码，只在有武器显隐时） |
| `packages/<id>/<sha>/runtime/characters/<id>/neutral/scene.json`、`neutral/build-record.json`、`metal/product.json`（中立包，三份同有同无；`bundle.json` 角色条目的可选引用 `neutral_scene`、`neutral_build_record`、`metal_product` 指向它们，形状和 `graph` 一样是 `{file, sha256, byte_count}`，路径相对 `bundle.json` 所在目录，也列在 `files[]`；旧包没有） | `endfield-neutral-scene/v1`、`endfield-neutral-build-record/v1`、`endfield-metal-product/v1`；不变量见下面「中立包」一段 | `characters/packaging/native_bundle.py` 的 `build`（`neutral_documents` 拆 `graph/frame-graph.json`）；改帧图的工具用 `write_neutral` 重写帧图和这三份：外观导入 `import_outfit.py`、外观删除和导出 `agent/agentd/outfit_tool.py` 的 `finish` | `native_bundle.py` 的 `verify`（核不变量）；`character_library.py` 的 `Package`（只核三份同有同无、在 `files[]` 里、SHA-256）；Mac 运行时不读 |
| `packages/<id>/<sha>/runtime/characters/<id>/vulkan/frame.bin`、`vulkan/blobs/<sha256>`（Vulkan 段，可选；`bundle.json` 角色条目的可选引用 `vulkan_frame` 指向 `frame.bin`，形状和 `graph` 一样是 `{file, sha256, byte_count}`，路径相对 `bundle.json` 所在目录；`frame.bin` 和 `vulkan/blobs/` 下的文件都列在 `files[]`；有它必有三个中立引用；旧包和 Mac 上用的包没有） | 帧表格式只由 `characters/packaging/package_format.py` 定义（magic `VK_MAGIC` 即 `EFWVKP01`，`VK_VERSION`；程序是游戏原版 SPIR-V）；不变量见下面「Vulkan 段」一段 | 本机构建工具 `build_vulkan_candidate.py`（不在公开仓库），帧表由它调的 `windows_package.py --api vulkan` 生成 | Windows 渲染器 efw（`--package <角色目录>`）；`native_bundle.py` 的 `verify`（核不变量）；`character_library.py` 的 `Package`（只核有它时三个中立引用齐全、在 `files[]` 里、SHA-256，缺中立引用报 `vulkan_frame_without_neutral_package`）；Mac 运行时不读 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/bone-physics.json`（可选；只有做过物理移植的包才有，pack.json 的 interaction.data 里列出） | `metal-actor-bone-physics/v1`；绑 rig sha，`source_files` 每项带 sha256；每队 `params` 原样保留源参数，求解器读其中约 30 个，外加可选的 `maxMoveSpeed`、`maxRotationSpeed` | 本机构建工具 `restore_bone_physics.py`（不在公开仓库）的 `restore()`、`graft()` | `private/renderer/runtime/Sources/MetalActorRuntime/ActorBonePhysics.swift:59-74`；只在渲染器收到 `--agentic-complex-secondary-motion 1` 时加载 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/stage.json`（可选；只有建过 3D 展示台的包才有，pack.json 的 interaction.data 里列出） | `endfield-character-stage/v1`；字段见下节「3D 展示台」 | 本机构建工具 `build_effect_entity.py`（不在公开仓库）的 `build_stage()`（`:836`），内容由 `stage_document()`（`:830-833`）生成 | `character_library.py:385-398`（安装时校验，失败为 `invalid_stage`）；`private/renderer/host/Sources/MetalAvatarHost/Placement/HostStage.swift` 的 `HostStage.display(packURL:id:)`（`:39`；只在宿主收到 `--agentic-complex-scene-stage <id>` 时读） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/mod-settings.json`（可选；只有导入过带开关或换色的 mod 的包才有，pack.json 的 interaction.data 里列出） | `endfield-mod-settings/v1`；字段见下节「mod 设置」 | `characters/agentic_complex_build/import_outfit.py` 的 `import_outfit()`（`:927-932`，导入带开关的 mod 时加本外观的表）；`characters/agentic_complex_build/outfit_compose.py` 的 `graft_appearance()`（`:370-375`，搬外观时带上它的表）、`remove_appearance()`（`:301-304`，删外观时去掉它的表，表空了从 interaction.data 去掉） | `character_library.py:399-409`、`check_mod_settings()`（`:145`）（安装时校验，失败为 `invalid_mod_settings:<原因>`）；agentd `GET /characters/{id}/mod-settings`（`agent/agentd/character/mod_settings_routes.py:21-30`）；宿主 `private/renderer/host/Sources/MetalAvatarHost/Actor/HostModSettings.swift` 的 `HostModSettingsTable.load`（`:160-168`），由 `ActorSession.swift:538-546` 调用 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/motion-media.json`（可选；导入过带 BGM、表情或相机的动作才有，pack.json 的 animation.data 里列出） | `endfield-motion-media/v1` 或 `endfield-motion-media/v2`；`tracks[]` 每项 `action`、`clip`、`length`；v1 每轨必有 `audio`（blob 引用，另带 `sample_rate`、`channels`）；v2 的轨可无 `audio`，可带 `face`（`{facial_animation:<表情库条目 id>}`）和 `camera`（相机轨文件的 blob 引用）；任一轨有 face 或 camera 时整份写成 v2 | `characters/agentic_complex_build/import_vmd.py` 的 `install_clips()`（`:349-362`）；`motion_import/edit.py` 删动作时去掉对应轨 | `private/renderer/host/Sources/MetalAvatarHost/Actor/HostMotionMusic.swift` 的 `HostMotionMusic.load`（`:27-37`；face 随动作播放；camera 读成相机轨，见 camera 行）；`native_bundle.py` 的 `motion_media_faces()`（`:257-270`，核 face 指向的条目在表情库里）；`agent/agentd/motion_tool.py` 的 `precheck`（`:104-111`，只数轨） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/motion-graph.json`（可选；旧包没有，pack.json 的 animation.data 里列出） | `endfield-motion-graph/v1`；`clips[]`、`edges[]`、`chains`（每个起点的 `ActorMotionPolicy.chain`）、`poses`、`runtime`（原生运行时的常量）、`counts`；写出后不超过 4 MiB | `characters/agentic_complex_build/motion_graph.py`：`pack_graph()`（`:964`）由 `build_original_agent_motion.py` 的 `make_plan()`（`:583`）写进每份计划；`graft()`、`graft_library()`（`:989`、`:1018`，`build.py motion_graph` 不带 `--character` 时）给整库每个包重写；`motion_import/edit.py`（`:114`）改名、删动作后重生 | agentd `GET /characters/{id}/motion-graph`（`agent/agentd/character/motion_graph_routes.py:17-24`） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/face/<clip>.json`（可选；VMD 里有能映射的表情时才有） | `endfield-original-named-facial-animation/v1`；`name`、`duration`、`additive`（false）、`override`（false）、`pause_auto_blink`、`curves[]`（每项 `control` 加 `curve.m_curve` 关键帧） | `import_vmd.py` 的 `install_clips()`（`:339`），内容由 `mmd/morph.py` 的 `clip_document()` 生成 | 经表情库条目的 `animation` 引用，由 `ActorFacialAnimation.swift` 的 `ActorFacialAnimation.init(data:supportedControls:irisCarriers:)`（`:26`）读 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/camera/<clip>.json`（可选；VMD 带相机轨时才有，由 motion-media 轨的 `camera` 引用） | `endfield-motion-camera/v1`；`clip`、`frame_rate`（30）、`frames`、`space`（`mmd-source`）、`center`、`euler`（弧度）、`distance`、`fov_deg`、`perspective`、`cuts`、`to_rig` | `import_vmd.py` 的 `install_clips()`（`:346-348`），内容由 `mmd/camera.py` 的 `document()` 生成；相机 VMD 由 `agent/agentd/motion_tool.py` 的导入从输入文件里认出后传入，`build.py import_vmd` 命令行不收相机 VMD | `HostMotionMusic` 的 `init`（`HostMotionMusic.swift:55-62`）解码成 `HostMotionCameraTrack`；`ActorSession.swift:1074-1080`、`:1126-1128` 在舞台模式下按它取景（`HostStagePlayback.active`：`set_render.camera.track` 为 `stage`、全屏、动作已开始、没开 3D 展示台） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/facial-animations.json`（表情库；pack.json 的 animation.data 里列出） | `endfield-runtime-facial-library/v1`；`character`、`controls_sha256`、`clips[]`（`id`、`name`、`duration`、`animation` blob 引用）；导入的条目另带 `motion_only: true`，表示只跟着动作播 | `import_vmd.py` 的 `install_clips()`（`:340-345`，没有时新建，再追加条目） | `ActorFacialAnimation.swift` 的 `ActorFacialAnimationLibrary`（`:68-99`），由 `private/renderer/host/Sources/MetalAvatarHost/Render/HostPresentationEffects.swift:42-45` 加载（包里同时有 `original-face-controls.json` 时）；`native_bundle.py` 的 `motion_media_faces()` |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/mmd-morph-map.json`（可选；手写的 MMD 表情映射，覆盖默认映射） | 不核 schema；`morphs` 是 `{<MMD 表情名>: [{pose 或 control, weight?}]}` | 手写 | `import_vmd.py` 的 `package_face()`（`:282-290`）交给 `mmd/morph.py` 的 `resolve()`（`:18-35`）；只在导入时读，运行时不读 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/humanoid.json`（有 `render` 的包必有；pack.json 的 animation.data 里列出） | `endfield-humanoid-map/v1`；`bones` 是 `{<VRM 1.0 人形骨名>: <rig 节点完整路径>}`，必有 `hips`、`spine`、`head`、`leftUpperLeg`、`leftLowerLeg`、`leftFoot`、`rightUpperLeg`、`rightLowerLeg`、`rightFoot`、`leftUpperArm`、`leftLowerArm`、`leftHand`、`rightUpperArm`、`rightLowerArm`、`rightHand`，其余人形骨（`chest`、`upperChest`、`neck`、肩、脚趾、手指、`leftEye`、`rightEye`）可选；可选 `extras.twist` 是 `{<扭转骨名>: <rig 节点完整路径>}`，键为 `{left,right}{UpperArm,LowerArm,UpperLeg,LowerLeg}Twist` 和同名加 `1` | 本机构建工具 `native_pack.py` 的 `build`（`:56-59`，不在公开仓库），按同文件的终末地骨名对照表 `AAC_BONES`、`AAC_TWISTS`（`:20-24`）生成，缺必需骨时报错 | 渲染器 `private/renderer/runtime/Sources/MetalActorRuntime/ActorProcedural.swift` 的 `ActorHumanoidMap`（`:38-59`，只读 `bones`），宿主加载时经 `ActorSession.swift:325-330`、`:425-426` 读；用它的有 `private/renderer/host/Sources/MetalAvatarHost/Placement/HitCapsules.swift:102-105`（公共胶囊）、`private/renderer/host/Sources/MetalAvatarHost/Actor/RigProfile.swift:30-52`（rig-profile 缺槽时）、`private/renderer/host/Sources/MetalAvatarHost/Agent/HostPerform.swift:14-18`、`:110-114`（`keyHumanoid`）、`ActorProcedural.swift:25-35`（没有 procedural-binding.json 时）；Python `characters/agentic_complex_build/mmd/rig_math.py` 的 `pack_humanoid`（`:29-36`）、`humanoid_ids`（`:17-28`，读 `bones` 和 `extras.twist`），`mmd/native_rig.py` 的 `package_humanoid`（`:7-9`），重定向、动作导入和姿态分类经它们取骨 |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/motion-bindings.json`（有 `render` 的包必有；pack.json 的 animation.data 里列出） | `endfield-motion-bindings/v1`；`overview`、`relax`、`from_overview` 是片段名，必有；可选 `idle_bases`（待机底座片段名数组，须含 `overview`，每个都是循环片段）；可选 `roles`：`lift_start`、`lift_end` 是拎起开始和放下时播的片段名，两个都有才生效 | 本机构建工具 `native_pack.py` 的 `build`（`:61`，写 `overview`、`relax`、`from_overview`）；`build_original_agent_motion.py` 的 `make_plan()`（`:503-510`，合入计划的 `motion_bindings` 行）（都不在公开仓库）；`roles` 没有工具写，包里有就原样带着 | `private/renderer/runtime/Sources/MetalActorRuntime/ActorMotionPolicy.swift:140-148`（前三项和 `idle_bases`）；`private/renderer/host/Sources/MetalAvatarHost/Walk/HostHeldController.swift` 的 `HostLiftRoles.init?(pack:)`（`:28-37`，`roles`）；`characters/agentic_complex_build/motion_graph.py:109` |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/locomotion.json`（可选；pack.json 的 interaction.data 里列出，同时要列 `motion-metadata.json`） | `endfield-locomotion-v1`；`walk_loop_speed_mps`、`stride_scale`、`full_walk_min_m`、`short_walk_min_m`；`start`：`{<用途>: {cut_s, blend_s, distance_to_cut_m, start_foot}}`，必有 `walk_start_l_0_r`；`stop`：`{<用途>: {distance_m, settle_s, planted_foot, exit_s?}}`，必有 `walk_stop_l`，`exit_s` 是停步最早退出的时刻（秒）；`clips`：`{<用途>: <片段名>}`，用途是 `start`、`stop` 的每个键、`walk_loop` 和可选的 `idle_turn_{l,r}_{0,90,180}` | 本机构建工具 `universal_interactions.py`（`:195-203`，不在公开仓库；包里没有时从模板包抄一份，距离按腿长比例缩放）；`clips`、`stop.*.exit_s` 没有工具单独写，包里有就原样带着 | `private/renderer/host/Sources/MetalAvatarHost/Walk/HostLocomotion.swift` 的 `HostLocomotion.init?(pack:archive:legs:)`（`:129-174`）；`private/renderer/host/Sources/MetalAvatarHost/Walk/HostWalkController.swift:441-444`（`exit_s`）；`motion_graph.py:507-508`（`clips`） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/affordance-uses.json`（可选；pack.json 的 interaction.data 里列出） | `endfield-affordance-uses-v1`；`uses[]` 每项 `surface`（`seat`、`window_top` 等）和片段名 `enter`、`loop`、`exit`，可选 `variants[]`（`{clip}`）、`headroom`、`min_segment` | 本机构建工具 `build_original_agent_motion.py` 的 `make_plan()`（`:391-407`、`:540-553`）、`universal_interactions.py`（`:148-150`）（都不在公开仓库） | `private/renderer/host/Sources/MetalAvatarHost/Seat/HostSeat.swift:177-182`（`seat` 用途）；`private/renderer/host/Sources/MetalAvatarHost/Seat/HostWindowSeat.swift:46-62`（`window_top` 用途；起身片段取它的 `exit`，没有取 `seat` 用途的 `exit`）；`characters/agentic_complex_build/live_motion.py:33-36`；`motion_graph.py:113` |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/animation/actions.json`（有 `render` 的包必有；`c7/interaction/actions.json` 同 schema，也必有） | `endfield-character-actions-v1`；`actions[]` 每行 `id`、`name`、`section`、`clips`、`trigger`、`duration` 等；可选 `gestures`：`[<group>]`，`group` 取 `agent/agentd/motion/phrases.json` 的 `group` 值（如 `wave`、`nod`）；可选 `tags` 是中文显示标签，和 `gestures` 无关 | 本机构建工具 `native_pack.py` 的 `build`（`:86-87`）、`build_original_agent_motion.py`（不在公开仓库）；`import_vmd.py` 的 `install_clips()`（`:334`，追加的行不带 `gestures`）；`gestures` 没有工具写，包里有就原样带着 | `ActorMotionPolicy.swift:214`（两份都读）；`agent/agentd/motion/catalog.py` 的 `load`（`:14-33`，收每行的 `gestures`）、`members`（`:36-38`，按 `group` 取行） |
| `packages/<id>/<sha>/runtime/characters/<id>/c7/interaction/efmi-slot-hints.json`、`efmi-lod1-bones.json`（可选；外观模组表，pack.json 的 interaction.data 里列出） | `endfield-efmi-slot-hints/v1`、`endfield-efmi-lod1-bones/v1`；`characters` 里只放本角色一个分区；槽位提示是 `{<程序或 shader 家族名>: {<槽>: <资源名>}}`，LOD1 骨序是 `{<LOD1 子网格区域 hash>: {lod1_mesh, lod0_mesh, index_count, bones}}` | 没有工具写进包，包里有就原样带着 | 外观导入器 `characters/agentic_complex_build/import_outfit.py` 的 `config_table`（`:433-442`，按 interaction.data 记的 sha256 核），经 `slot_hints`、`lod1_bones`（`:445-453`）在 `import_outfit()`（`:775-780`）里用；只在导入时读，运行时不读 |
| `packages/<id>/<sha>/persona/card.json`（角色卡，`character.json` 的 `components.persona.card` 指向它）的 `user_title`、`pronoun`（都可选） | 角色卡的可选键：`user_title` 是角色对用户的称呼，也是示例和对话记录里用户一方的标签，缺省「用户」；`pronoun` 是提示词里称角色用的第三人称代词，缺省「TA」；出现时须是非空字符串 | 角色卡作者手写；本机构建工具 `assemble.py:56` 原样封进包 | `agent/agentd/brain/persona.py` 的 `user_title`、`pronoun`、`addressed`（`:25-37`），`render_persona` 校验（`:46-48`） |
| `persona/card.json` 的 `lines`（可选） | 事件名映射到台词数组，例如 `{"tap":[{"zh-Hans":"我在。","en":"I'm here.","ja":"ここにいるよ。"}]}`。每条至少有一种回复语言（`zh-Hans`、`en`、`ja`），译文为非空字符串。可写 `tap`、`head_pat`、`gift`、`greeting_morning`、`greeting_back`、`idle`、`dragged` 等事件 | 角色卡作者手写 | agentd 加载角色卡时由 `Repository.load_card` 校验。无可用模型时，点击、礼物和问候按当前回复语言选词，有多条时避免连续重复。事件或对应译文缺失时跳过 |
| `native-<sha>.json`（全库原生包，路径相对库根） | `metal-native-character-bundle/v1` | `character_library.py:576-579`（`Library.publish`） | `CharacterCatalog.swift:206-210`（核 SHA）；宿主启动时 `private/renderer/host/Sources/MetalAvatarHost/App/HostMain.swift:74`、切换角色时 `private/renderer/host/Sources/MetalAvatarHost/App/Host.swift:237` 经 `ActorNativeBundle.swift:27-31` 加载 |
| `motion-imports/<id>/imports.json`（导入动作的索引，[MOTION-IMPORT.md](MOTION-IMPORT.md) §4） | `endfield-motion-imports/v2` | `agent/agentd/motion_tool.py` | `motion_tool.py list/rename/remove` |

C7 包 `c7/pack.json` 用 `endfield-character-pack/v1`（本机构建工具 `native_pack.py` 的 `build`（`:100-103`，不在公开仓库）写，`ActorMotionPolicy.swift:99-103` 读）。app 的 `Resources/distribution.json` 用 `endfield-distribution/v3`，记 app 里各角色组件合成的 `current.json` 的 SHA-256（`catalogSHA256`）和默认角色（`tools/release/package_app.py:132-133` 写，`app/electron/src/main/packaged.ts` 读）。`c7/pack.json` 里可选的外观字段和分层见下节「外观和分层」。

中立包：`characters/packaging/neutral_package.py` 把帧图拆成中立段（`scene`）、Metal 产品段（`metal/product.json`）和构建记录，`emit_metal(scene, metal, record)` 拼回。不变量：有这三个引用时，`neutral_package.dumps(emit_metal(...))` 的字节等于 `graph` 引用的文件，逐字节；不等时 `build` 不出包、`verify` 报 `neutral package does not emit the frame graph byte for byte`，只有其中一两个引用时报 `neutral package is incomplete`（`character_library.py` 报 `incomplete_neutral_package`）。改帧图的工具改完后用 `write_neutral` 按 `emit_metal` 的形式重写 `graph/frame-graph.json` 并重写三份，旧包导入外观后也带上它们。运行时仍只读 `graph`。

Vulkan 段：`vulkan/frame.bin` 是 Windows 渲染器读的帧表，由 `neutral/scene.json` 生成。不变量：帧表头的 magic 等于 `package_format.VK_MAGIC`、`version` 等于 `package_format.VK_VERSION`；头里的 `scene_sha256` 等于 `neutral_scene` 引用的文件的 SHA-256；帧表里每条 blob 记录的名字是相对角色目录（放 `vulkan/` 的那个目录）的路径，规则见 [C3 合同附录「Windows」的 `--package`](../C3-host-ipc/CONTRACT.md#启动)，指到的文件在 `files[]` 里，那一项的 SHA-256 和大小等于记录，或那个文件是池压缩容器、头里的原始身份等于记录（见下段）。名字优先指角色目录里已有的文件（`source/` 下的那份优先），没有的才放 `vulkan/blobs/<sha256>`。`verify` 按序报 `vulkan_frame needs the neutral package`、`vulkan frame table is not EFWVKP01`、`vulkan frame table is version <n>, not <当前>`、`vulkan frame table is bound to neutral scene <sha>, not <sha>`、`vulkan blob name leaves the character directory: <名字>`、`vulkan blob is not in the bundle: <路径>`、`vulkan blob does not match its sha256/size: <路径>`。`write_neutral` 重写中立段时去掉条目里的 `vulkan_frame`（帧表属于旧 scene）；`vulkan/` 的文件按调用方重列 `files[]` 的做法留在包里，不再被引用。

池文件压缩：源清单所在目录下的 `Files/<sha256>.bytes` 可以存成压缩容器，格式由 `agent/agentd/pool_codec.py` 定义：小端，52 字节头（`struct` 格式 `<8sIQ32s`）依次是魔数 `EFPOOL01`、codec u32（只有 1，LZFSE）、原始字节数 u64、原始字节的 SHA-256（32 字节二进制）；头之后到文件末尾是一个 LZFSE 流，解出恰好原始字节数。只有 52 加流长度小于原始长度的文件写成容器，其余原样存。文件名和 `source/manifest.json`、`graph/frame-graph.json`、`vulkan/frame.bin` 里的引用（sha256、byte_count）记原始字节；`character.json` 的 `inventory` 和 `bundle.json` 的 `files[]` 记磁盘上存的字节。读取方一律这样认：存的文件大小等于引用的 byte_count 时是原始字节，SHA-256 也须等于引用；否则必须是容器，头里的原始字节数和 SHA-256 等于引用，解码后长度和 SHA-256 再等于头里的。容器由发布打包写：`tools/release/build_components.py` 的 `compress_pool`，macOS 组件由 `stage_character` 调；Windows 用的库由 `tools/release/compress_library.py` 在 macOS 上生成。库本身和构建工具不写容器。

`c7/pack.json` 的 `interaction.data[]` 可带可选文件 `presentation-look.json`（`{file:"presentation-look.json", sha256}`，文件在 `c7/interaction/` 下），schema `endfield-presentation-look/v1`：`grounding` 的 `opacity`（0–1，缺省 0.5）、`softness`（0–3，缺省 1）、`foot_radius_m`（0.02–0.2，缺省 0.08）、`min_aspect`（0.05–1，缺省 0.25），`ambient_response` 的 `max_chroma`（0–0.5，缺省 0.25）、`max_ev`（0–1，缺省 0.4）、`wrap_width_px`（0–6，缺省 6）、`wrap_strength`（0–0.5，缺省 0.12）。缺的字段和缺文件都取缺省；越界或 sha256 不符时加载失败。写入方暂无；读取方 `private/renderer/host/Sources/MetalAvatarHost/Render/HostPresentationLook.swift` 的 `HostPresentationLook.load`。读取端按文件名找，忽略 `interaction.data` 里不认识的文件。

## 必需与可选

下表只列有 `render` 的包里的部件和角色卡的可选键；纯文字包见「纯文字角色包」一节。「加载失败」指宿主加载这个角色时抛错：安装时 `--validate-pack` 拒绝这个包，运行时切不到这个角色。

| 部件 | 必需/可选 | 缺了时的行为 | 代码位置 |
|---|---|---|---|
| `animation/humanoid.json` | 必需 | pack.json 没列它：加载失败，报 `Actor pack lacks animation/humanoid.json`。缺必需骨：报 `Humanoid map lacks <骨>`；路径不是 rig 节点：报 `Humanoid bone path <路径> is not a rig node`。公共命中胶囊另要 `neck`，缺了报 `Humanoid map lacks <骨> or <骨> for common hit capsule <名>`。没有 `procedural-binding.json` 时程序化骨另要 `neck`、`upperChest` 或 `chest`、`leftEye`、`rightEye`，缺了报 `Humanoid map lacks <骨> for procedural role <槽>`。Python 侧（重定向、动作导入）没有它：报 `humanoid_map_missing`；缺必需骨：报 `humanoid_map_lacks:<骨>` | `ActorSession.swift:325-330`、`:425-426`；`ActorProcedural.swift:27-35`、`:43-55`；`HitCapsules.swift:102-105`；`rig_math.py:17-36` |
| `animation/procedural-binding.json` | 可选 | 没有：程序化骨（看向、拖动摆动）从 humanoid.json 取 | `ActorSession.swift:499-502` |
| `animation/motion-bindings.json` | 必需 | pack.json 没列它：加载失败，报 `Actor pack lacks animation/motion-bindings.json`。`overview`、`relax`、`from_overview` 不是动作库里的片段：报 `Invalid semantic motion bindings`；`idle_bases` 不合格：报 `Invalid idle base bindings`；没有 `idle_bases`：待机底座只有 `overview` | `ActorMotionPolicy.swift:140-148` |
| `motion-bindings.json` 的 `roles` | 可选 | 缺 `lift_start` 或 `lift_end`：拎起时从 `intent-motion-map.json` 的 `drag.lift` 事件池抽片段；池也没有就不播拎起反应，不报错。两个都有时不抽 `drag.lift` | `HostHeldController.swift:28-37`、`:97-108` |
| `animation/actions.json`、`interaction/actions.json` | 必需 | 任一份没列或重复：加载失败，报 `Missing/duplicate policy input actions.json` | `ActorMotionPolicy.swift:105`、`:214` |
| `actions.json` 的 `gestures` | 可选 | 没有任何行带 `gestures`：agentd 的动作短语表为空，`[motion:]` 不对到游戏动作；动作驱动为 generated 时 `[motion:]` 全部现场生成，为 game 时提示词不加动作规则 | `catalog.py:14-55`；`persona.py:50-53` |
| `interaction/locomotion.json` | 可选 | 没列：不走路、不原地转身（`walkAvailable` 为 false）。列了但没列 `motion-metadata.json`：报 `Locomotion without motion-metadata.json`。`clips` 缺 `start`、`stop` 的某个键或 `walk_loop`：报 `Locomotion role <用途> has no clip in locomotion.json clips`；片段不在动作库里：报 `Locomotion clip <名> is not in the actor`；缺 `walk_start_l_0_r` 或 `walk_stop_l`：报错。`idle_turn_*` 没有对应片段：不用那个转身 | `HostLocomotion.swift:129-165`；`ActorSession.swift:447`、`:766-768` |
| `locomotion.json` 的 `stop.*.exit_s` | 可选 | 缺：停步退出时刻不设这个下限，只按落定帧（和有脚步轨时的着地时刻）算 | `HostWalkController.swift:441-444` |
| `interaction/affordance-uses.json` | 可选 | 没列，或没有 `seat` 用途，或没列 `seat-anchors.json`：不坐凳子。`seat` 用途缺 `enter`、`loop`、`exit` 任一：报 `Seat use without its chain`。没有 `window_top` 用途，或没列 `seat-anchors.json`、`rig-profile.json`：不坐窗顶。`window_top` 缺 `loop`、`headroom`、`min_segment`：报 `Window top use without its loop, headroom or min_segment`。窗顶起身：`window_top` 和 `seat` 都没有 `exit` 时不播片段，直接站起 | `HostSeat.swift:164-182`；`HostWindowSeat.swift:36-62` |
| `interaction/hit-capsules.json` | 可选 | 没有：只有 12 根公共胶囊 | `ActorSession.swift:439-442`；`HitCapsules.swift:78-89` |
| `interaction/rig-profile.json` | 可选 | 没有：走路不做步幅修正和脚锁，不坐窗顶。有它但缺腿、臂、根槽：用 humanoid.json 的对应骨补，还没有报 `Rig profile lacks <槽>` | `ActorSession.swift:443-449`；`RigProfile.swift:48-52` |
| `animation/vowel-profile.json` | 可选 | agent 语音会话没有它：没有 cue 覆盖的地方嘴只按音量开合，开口取元音 a，语音状态的 `profile_sha256` 为 null。语音夹具（`--speech-fixture`）没有它：报 `Speech fixture needs this pack's original vowel profile` | `ActorSession.swift:480-492`；`private/renderer/host/Sources/MetalAvatarHost/Speech/SpeechPlayback.swift:79-82`、`:109`、`:170`；`private/renderer/runtime/Sources/MetalActorRuntime/ActorSpeechController.swift:31-32`、`:157` |
| 声线 | 可选 | 只出文字的两种情况：一是没有 TTS 地址（Companion config.json 的 `services.tts.mode` 为 `off`）：Companion 不给 agentd 传 `--tts-url`，agentd 的声线是 `NoVoice("not_configured")`；语音服务起不来时是 `NoVoice("start_failed")`。二是 `character.json` 没有 `components.voice`：agentd 每句只出文字，宿主不建语音会话。`components.voice` 出现时 `character`、`language` 都要是非空字符串，否则安装报 `invalid_voice_profile` | `app/electron/src/common/config.ts`（`services`）；`app/electron/src/common/agentd.ts`（`--tts-url`）；`agent/agentd/voice/voice_provider.py:176-179`；`agent/agentd/daemon/main.py:387-396`；`character_library.py:298-301`；`agent/agentd/daemon/rituals_glue.py:215-220`；`ActorSession.swift:480-496` |
| 外观模组表 `interaction/efmi-slot-hints.json`、`efmi-lod1-bones.json` | 可选 | 没列：导入器按空表做，贴图槽只按 mod 自己的表和格式、尺寸配，LOD1 部件不取骨序。列了但 sha256 不符：报 `file_sha_mismatch`；schema 不对：报 `invalid_slot_hints` 或 `invalid_lod1_bones` | `import_outfit.py:433-453`、`:456-462`、`:603-613` |
| 角色卡的 `user_title`、`pronoun` | 可选 | 缺：称呼取「用户」，代词取「TA」。出现但不是非空字符串：`render_persona` 抛错，安装报 `invalid_persona_or_lore` | `persona.py:6`、`:25-37`、`:46-48`；`character_library.py:285-291` |
| `interaction/bone-physics.json` | 可选 | 没有：不做次级动作。只在宿主收到 `--agentic-complex-secondary-motion 1` 时读 | `ActorBonePhysics.swift:59-74`；`ActorSession.swift:437` |
| `interaction/stage.json` | 可选 | 没有，或 id 不等于 `--agentic-complex-scene-stage <id>`，或读不了：没有 3D 展示台。安装时字段不合格：报 `invalid_stage` | `HostStage.swift:37-48`；`character_library.py:385-398` |
| `interaction/mod-settings.json` | 可选 | 没有：没有 mod 开关，按导入时的绘制画。安装时不合格：报 `invalid_mod_settings:<原因>`。宿主读不了：stderr 记 `AAC_MOD_SETTINGS_REJECTED`，按没有表画 | `character_library.py:399-409`；`HostModSettings.swift:160-168`；`ActorSession.swift:538-546` |
| `animation/motion-media.json` | 可选 | 没有：动作不带 BGM、表情和相机。轨的 `face` 不在表情库里：报 `Motion media face clip is not in the facial library` | `HostMotionMusic.swift:27-31`、`:50-52` |
| `animation/camera/<clip>.json` | 可选 | 读不了：stderr 记 `AAC_MOTION_CAMERA unreadable`，动作照常播、不带相机 | `HostMotionMusic.swift:55-62` |
| `animation/facial-animations.json` | 可选 | 没有，或没列 `original-face-controls.json`：没有表情库，带 `face` 的 motion-media 轨按上一行报错 | `HostPresentationEffects.swift:42-45` |
| `animation/mmd-morph-map.json` | 可选 | 没有：VMD 导入只按默认映射（元音槽）对 morph | `import_vmd.py:282-290`；`morph.py:18-35` |
| `animation/motion-graph.json` | 可选 | 没有：`GET /characters/{id}/motion-graph` 回 404 `motion_graph_missing`；动作策略的 `chainStarts` 为 nil | `motion_graph_routes.py:17-24`；`ActorMotionPolicy.swift:74-75` |
| `interaction/presentation-look.json` | 可选 | 没有：各字段取缺省 | `HostPresentationLook.swift:54-57` |
| `components.game_data`、`components.ui.head` | 可选 | 见「纯文字角色包」一节最后一段 | `character_library.py:265-278` |
| `components.ui.portrait`（立绘）、`components.ui.background`（角色页背景水印） | 可选；有它必有同名 capability `ui.portrait`、`ui.background`，反之亦然 | 缺立绘时引导页画占位，缺背景时角色页不画水印；capability 不符报 `portrait_capability_mismatch`、`background_capability_mismatch` | `character_library.py:281-284`；Electron `app/electron/src/main/ops/character.ts` 的 `characterArt` 读出，`ui-scheme.ts` 以 `characters/<id>/<kind>.png` 提供 |
| `character.json` 的 `base_package_version` | 可选 | 见「派生包的窗口包络」一节 | `HostFixedWindow.swift` |

## 衣片的横向约束（bone-physics.json）

每个物理队可给出 `sheet_links` 数组，按文件顺序参与现有布面距离约束求解。每项形如 `{"a":2,"b":5,"stiffness_scale":0.35}`，两端是本队 `particles` 的零起始索引。`stiffness_scale` 缩放该深度的弯曲刚度，取值为大于 0、小于或等于 1 的有限数。绑定间距从骨架静止姿势计算，模拟中的目标间距取自动画姿势。

缺少这个字段时，运行时沿用原有的三角弯曲开关和空间邻近推断。显式空数组关闭该队的横向连接。有边时只求解列出的连接，调用方的全局布面开关仍然有效。

每队上限为 2,048 条显式连接，两端须属于根粒子不同的链，至少一端可动，静止间距须有限且大于 0.0001 个角色空间单位。反向重复、与已有结构约束相同的连接、无效索引或非法数值都会导致物理文档加载失败。

## 外观和分层（c7/pack.json）

schema 仍是 `endfield-character-pack/v1`，只加可选字段；包里没有 `layers` 时行为不变。

- 谁写：本机构建工具 `appearance_layers.py`（不在公开仓库，读计划文件 `endfield-appearance-layer-plan/v1`，`{schema, character, protected_meshes[], layers[]}`）、`characters/agentic_complex_build/outfit_compose.py`。
- 谁读：`agent/agentd/character_library.py:351-378`（安装时校验，失败为 `invalid_layers` 或 `invalid_appearances`）、`private/renderer/host/Sources/MetalAvatarHost/Actor/ActorSession.swift`。

**`appearances[i]`**

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| id | string | 是 | 现有 |
| name | string | 是 | 现有 |
| desc | string，≤ 200 字节 | 否 | 菜单和角色页里的说明 |
| kind | `"original"` \| `"imported"` | 否，缺省为 original | 导入的外观标 imported |
| source | `{format:"efmi"\|"eff"\|"clone", fingerprint:<64 位十六进制>, mod_name?:string, imported_at:<ISO8601>}` | kind=imported 时必有 | 只存指纹和名字 |

**`layers`**（顶层，可选数组，≤ 16 项）

| 字段 | 类型 | 规则 |
|---|---|---|
| id | string，`^[a-z][a-z0-9_]{0,31}$` | 唯一；不能是 `weapon`（保留给武器显隐） |
| name | string，1–64 字节 | 菜单里的显示名（外套、饰品、尾部装饰……） |
| meshes | string[]，非空 | <ul><li>都在**主 palette** 合同里</li><li>不能带 `visible_with_clips` 或 `particle_palette`</li><li>层与层之间不相交</li><li>宿主加载时另查：不能是 composites 或武器展示的网格</li></ul> |
| appearances | string[]，可省 | 这层在哪些外观里起作用；省略表示全部外观；每个 id 都要在 `appearances` 里 |

主 palette 合同按 `animation.palette_contract.file` 相对 `c7/animation/` 读。计划文件里的 `protected_meshes`（身体、脸、头发、眼睛等）只在构建时检查，不进包。

## 3D 展示台

只加可选字段和可选文件；没有展示台的包行为不变。

- 谁写：本机构建工具 `build_effect_entity.py`（不在公开仓库）的 `build_stage()`，读计划文件 `endfield-effect-stage-plan/v1`；palette 行由 `stage_palette_mesh()`（`:823-827`）生成。
- 谁读：`agent/agentd/character_library.py:379-398`（安装时校验，失败为 `invalid_palette_scene` 或 `invalid_stage`）；palette 的 `scene` 由 `private/renderer/runtime/Sources/MetalActorRuntime/ActorPalette.swift` 的 `ActorPaletteMesh`（`:11-12`）读，可见性在 `:133`、`:160` 判断。

**主 palette 的 `meshes[i]`**

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| scene | string，非空 | 否 | 缺省：总是参与可见性计算（行为同 v1.1）；有值：只在宿主当前场景等于它时可见。值是展示台 id，即 stage.json 的 `id`。展示台网格同时写 `contributes_to_visual_bounds: false` |

**`interaction/stage.json`**（`endfield-character-stage/v1`；在 pack.json 的 `interaction.data[]` 里列为 `{file:"stage.json", sha256, byte_count}`，文件在 `c7/interaction/` 下）。除 `meshes` 和 `source_identity` 外，各字段由构建器从计划文件原样抄入。

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| schema | `"endfield-character-stage/v1"` | 是 | |
| id | string，非空 | 是 | 展示台 id（现在只有 `charinfo`）；本展示台 palette 行的 `scene` 等于它 |
| display.name | string，非空 | 是 | 显示名 |
| box | `{aspect, height_fraction, floor_v}`，都是数 | 是 | 盒子：`aspect` 宽/高（一个数，不是场景包的 `[w, h]`）；`height_fraction`、`floor_v` 同场景包 v1 |
| meshes | string[]，非空 | 是 | 本展示台的 palette 网格名（构建器写成 `stage:<id>/<prefab 内节点路径>`） |
| camera_hint | `{position:[x,y,z], look_at:[x,y,z]}`，都是数 | 是 | 默认机位，给镜头线做预设 |
| limits | `{min_camera_height_m, max_camera_distance_m}`，都是数 | 是 | 镜头限位：最低高度、最远距离（米） |
| excluded | `[{node:string, reason:string}]`，可为空 | 是 | 没画的节点和原因 |
| source_identity | object | 是 | 来源 prefab：`prefab`、`cab`、`path_id`、`archive`、`member`、`entry_id`、`raw_sha256`、`source_manifest_sha256`（数组）；校验只要求是对象 |

读取端按文件名找 `stage.json`，忽略 `interaction.data` 里不认识的文件。安装时不核 `meshes` 是否都在 palette 里。

## mod 设置

只加可选文件和绘制清单的可选键；没有 `mod-settings.json` 的包行为不变。表只描述开关和它们管的段、贴图；用户选的值不进包，存在 Companion 的 config.json（键 `mod_settings`）。

- 谁写：外观导入器 `characters/agentic_complex_build/import_outfit.py` 的 `import_outfit()`；`characters/agentic_complex_build/outfit_compose.py` 的 `graft_appearance()`、`remove_appearance()`。
- 谁读：`agent/agentd/character_library.py` 的 `check_mod_settings()`（安装时校验，失败为 `invalid_mod_settings:<原因>`）；agentd `GET /characters/{id}/mod-settings`（只回每个外观的 `settings`）；宿主 `HostModSettingsTable.load`（读不了时 stderr 记 `AAC_MOD_SETTINGS_REJECTED reason=<原因>`，按没有表画）。用户选的值由 Companion 经 `--agentic-complex-mod-settings` 传给宿主（`app/electron/src/main/renderer/supervisor.ts`）。

**`interaction/mod-settings.json`**（`endfield-mod-settings/v1`；在 pack.json 的 `interaction.data[]` 里列为 `{file:"mod-settings.json", sha256, byte_count}`，文件在 `c7/interaction/` 下）

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| schema | `"endfield-mod-settings/v1"` | 是 | |
| appearances | `{<外观 id>: 外观表}` | 是 | 键都在 pack.json 的 `appearances` 里；只有带表的外观才有 mod 设置 |

外观表 `{settings[], segments[], textures[]}`，三项都必有（可为空数组）。上限按每个外观算：开关 ≤ 64，每个开关取值 ≤ 16，段 ≤ 1024，`textures[].variants` 合计 ≤ 64。

**`settings[i]`**

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| id | string，`^[a-z][a-z0-9_]{0,31}$` | 是 | 同一外观里唯一 |
| name | string，1–64 字节 | 是 | 显示名：开关节的注释，没有时用 mod 游戏内面板给它的图标名（去掉数字前缀、下划线换空格），再没有用变量名；原文照抄不翻译 |
| category | `"clothing"`、`"accessory"`、`"hair"`、`"color"`、`"other"` 之一 | 否 | 界面分组用：不画自己的段（只换贴图）为 color；段全在 hair 网格上为 hair；否则按名字、图标、变量里的词（导入器 `mod_settings.CATEGORY_WORDS`）定 accessory、clothing、color，都不是为 other。没有这个键按 other |
| values | `[{value:0–255 的整数, name:1–64 字节}]`，1–16 项 | 是 | `value` 不重复。`name`：这个取值换上的贴图资源名的末段（`Resource_Texture_Hair_Red` 为 `Red`）；两个取值且其中一个不画该开关的任何段时为「显示」「隐藏」；否则「选项 N」（N = value + 1） |
| default | 整数 | 是 | 必须是 `values` 里的某个 `value`；即 mod 的初值，也就是导入时代入的那组 |
| origin | object | 否 | 来源（节名、变量、按键、类型），不参与校验 |

**条件**（段的 `visible_when`、变体的 `when`）：`{<开关 id>: [取值…]}`。每个开关 id 都在本外观的 `settings` 里，每个取值都在该开关的 `values` 里，列表非空、不重复；各项之间是「且」，一项内是「或」。空对象 `{}` 表示总成立。求值只判断「当前值在不在列表里」，不执行 mod 里的任何东西。

**`segments[i]`**

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| mesh | string | 是 | 源清单 `draws[]` 里某条绘制的 `mesh` |
| indices_sha256 | string | 是 | 同一 mesh 某条绘制的 `indices.sha256`；段键是 (mesh, indices_sha256)，同一网格的多个材质子网格各自成键 |
| first、count | 整数 | 是 | 单位是索引个数；都是 3 的倍数，`first ≥ 0`、`count > 0`、`first + count ≤ index_count`。同一个键下的所有绘制（各 pass）`index_count` 必须相同 |
| visible_when | 条件 | 是 | 成立时画这一段，否则主绘制、深度预通道、描边、自阴影都不画 |
| origin | object | 否 | 来源（override 节、条件原文），不参与校验 |

同一个键下的段互不重叠；不在任何段里的三角形总是画。写入方保证：所有开关取 `default` 时画出来的就是导入时的原绘制（安装时只核 `default` 在 `values` 里，不核画面）。

**`textures[i]`**

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| mesh | string | 是 | 源清单里某条绘制的 `mesh` |
| indices_sha256 | string | 否 | 同一 mesh 某条绘制的 `indices.sha256`：只换这个索引块的各条绘制（各 pass）的贴图。没有时换这个网格所有绘制的贴图。一条绘制同时有本块的项和整网格的项时，取本块的项 |
| resource | string | 是 | 这个网格（有 `indices_sha256` 时为这个索引块）某条绘制里 `category` 为 `separate_images`、带 `texture` 的资源的 `names` 之一（运行时 target 槽如 `_CameraDepthTexture` 不算）；(mesh, indices_sha256, resource) 在本外观里唯一 |
| variants | `[{variant:<texture_variants[].id>, when:条件}]`，非空 | 是 | 按顺序取第一个 `when` 成立的变体；都不成立用默认贴图。同一项里 `variant` 不重复 |

导入器把 mod 里只换一个部件的部分绘制段的贴图（同一组件分几次 `drawindexed`、只在其中几次之前绑另一张图）写成按块的项：这几段在克隆网格里单独成一个索引块。

**绘制清单的 `texture_variants[]`**（`source/manifest.json` 的可选顶层键，schema 名不变）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 清单内唯一，由 `textures[].variants[].variant` 引用 |
| mesh | string | 等于引用它的 `textures[i].mesh` |
| indices_sha256 | string，可选 | 等于引用它的 `textures[i].indices_sha256`（都没有也算相等） |
| resource_names | string[]，非空 | 含引用它的 `textures[i].resource`；渲染器把它绑到这个网格（有 `indices_sha256` 时为这个索引块的绘制）所有名字有交集的贴图槽 |
| file、sha256、byte_count | blob 引用 | 和绘制 `resources[]` 一样相对清单所在目录（`Files/<sha>.bytes`），必须在原生包 `files[]` 里，且那一项的 sha256、byte_count 与它相同，或那个文件是池压缩容器、头里的原始身份与它相同（见「Vulkan 段」后的「池文件压缩」） |
| texture | TextureSpec，写法同绘制资源的 `texture` | 对这个网格（有 `indices_sha256` 时为这个索引块的绘制）每个名字有交集的贴图槽：`dimension`、`rd_format_name`、`storage_color_space_raw` 相同（格式和是否 sRGB），`width`、`height`、`depth`、`mip_count`、`face_count`、`array_length` 相同（尺寸） |

安装时只核被 `textures[]` 引用的变体；没有 mod-settings.json 时不读 `texture_variants`。`native_bundle.py` 的 `verify` 不核清单的键，也不把 `texture_variants` 的文件当作引用。

**`invalid_mod_settings` 的原因**

| 原因 | 什么时候 |
|---|---|
| schema | schema 不对 |
| shape | 字段缺失或类型不对；开关 id 格式不对或重复；`category` 不是上面五个之一；取值越界或重复；`texture_variants` 的 id 重复；变体的文件不在原生包里 |
| limit | 超过上面的上限 |
| unknown_appearance | 外观 id 不在 pack.json 里 |
| default_not_in_values | `default` 不在 `values` 里 |
| unknown_setting、unknown_value | 条件里的开关 id 或取值不存在 |
| unknown_mesh | 段或贴图的 mesh 不在源清单里 |
| unknown_indices | 段或贴图的 indices_sha256 不是这个 mesh 任何绘制的索引块 |
| index_count_mismatch | 同一个段键下的绘制 `index_count` 不同 |
| segment_out_of_range | 段不是 3 的倍数、为空或越过 `index_count` |
| segment_overlap | 同一个段键下的段重叠 |
| unknown_resource | 贴图的 resource 不是这个网格带 `texture` 的 `separate_images` 资源名 |
| unknown_variant | 变体 id 不在 `texture_variants` 里 |
| variant_mesh_mismatch | 变体的 mesh、indices_sha256 或 resource_names 对不上引用它的贴图项 |
| variant_format_mismatch、variant_size_mismatch | 变体的格式或尺寸和目标槽不同 |

## 纯文字角色包

`character.json` 的 `components` 里没有 `render` 键的包是纯文字包（只有人设，不渲染）。它只要求：
- `components.persona.card` 和 `components.persona.lore`，且分别通过 `render_persona` 和 `Lorebook` 的校验；
- `capabilities` 含 `text_only_base_capabilities`（`persona.dialogue`），不要求 `base_capabilities` 的其余项；
- schema、`id`、`version`、`inventory`、`display.name`、`aliases`、`source_identity` 的通用校验照旧；`game` 字段可省。

`game_data`、`ui.head`、`ui.portrait`、`ui.background` 可省，出现时照旧校验。纯文字包不往全库原生包写条目和文件，安装时也不调宿主的 `--validate-pack`；库里全是纯文字包时 `native-<sha>.json` 的 `characters` 为空。有 `render` 的包仍要求 `base_capabilities` 全部（`render.default`、`motion.idle`、`motion.preview`、`persona.dialogue`）和 `game` 字段（字符串，标来源，值不限）。

不论有没有 `render`，`game_data`、`ui`、`ui.head` 都可省，出现时照旧校验；缺 `ui.head` 时头像用占位（Companion 的条纹方块，网页各处的缺省图），缺 `game_data` 时角色资料为空。

## 派生包的窗口包络

`character.json` 只加一个可选顶层字段；没有它的包行为不变。

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| base_package_version | string，格式同 `version` | 否 | 这个包派生自的包版本，即 app 带的 `window-envelopes.json`（renderer 组件的 `Resources/window-envelopes.json`）里该角色条目的 `package_version`。导入外观或动作（含 MMD 同步烘焙）时写入：基础包没有这个字段就写基础包的 `version`，有就原样抄下；之后每次导入、删除导入外观或动作都一直传下去。种子迁移把旧包的导入重新套到新种子包上时，强制写新种子包的 `version` |

- 谁写：外观导入器 `import_outfit.py`、动作导入的 `import_vmd.py` 的 `install_clips`、`agent/agentd/motion_tool.py` 的 `mmd-sync`、`agent/agentd/distribution_seed.py` 的种子迁移。
- 谁读：宿主 `private/renderer/host/Sources/MetalAvatarHost/App/Host.swift` 的 `makeFixedWindow`（经 `basePackageVersion`，只在包版本和包络条目不等时读）。`character_library.py` 的 `Package` 和 `CharacterCatalog.swift` 不读也不拒绝它，安装时不核格式。
- 宿主规则（`HostFixedWindow.swift` 的 `HostWindowEnvelopes.lookup`、`HostEnvelopeGrowth`）：
  - 包版本等于条目的 `package_version`：用条目的 `extents_pt`。
  - 不等，但 `base_package_version` 等于它：用条目的 `extents_pt`，每边加增长边距。边距由宿主加载时算：当前外观和默认外观各自的 bind 空间盒（按骨，即 palette 骨的 `source_transform_id`；不含展示台网格和 `contributes_to_visual_bounds: false` 的网格），每根骨取各轴超出默认外观同骨盒的量（默认外观没有的骨按默认外观整体盒算），取最大的超出向量长度（米），乘以「条目 `left+right` 与 `top+bottom` 中较大者 ÷ 默认外观整体盒最长边」换成点数，四边相同；不超出为 0。日志 `AAC_WINDOW envelope=<source> derived_from=<基础版本> margin_pt=[l,r,t,b]`，窗口报告 `window_envelope` 带同名字段 `derived_from`、`margin_pt`，`extents_pt` 是加过边距的值。
  - 边距算不出来（包文件读不到）：`envelope=missing reason=margin_unavailable`，窗口是整个桌面。
  - 都对不上：照旧 `version_mismatch`，窗口是整个桌面。

## 怎么改

同一个提交里改 `constants.json`、Python、Swift 三处；任一处不同，对应测试失败。

## 版本记录

2026-11-15 v1.1：「库里的文件」表加了 `motion-imports/<id>/imports.json`（`endfield-motion-imports/v2`）这一行；新增「外观和分层（c7/pack.json）」一节（`appearances[]` 的 `desc`、`kind`、`source` 和顶层 `layers[]`，都可选）。

2026-11-16 v1.2：「库里的文件」表加了 `c7/interaction/stage.json`（`endfield-character-stage/v1`，可选）这一行；新增「3D 展示台」一节（palette 行的可选 `scene` 和 stage.json 的字段）；constants.json 的 `schemas` 加 `stage`。只加可选内容，v1.1 的读者不受影响。

2026-11-16 v1.3：「库里的文件」表加了 `c7/interaction/mod-settings.json`（`endfield-mod-settings/v1`，可选）这一行；新增「mod 设置」一节（表的字段、上限、条件写法、绘制清单可选的 `texture_variants[]` 和 `invalid_mod_settings` 的原因）。只加可选内容，v1.2 的读者不受影响。

2026-11-16 v1.4：新增「派生包的窗口包络」一节（`character.json` 可选的 `base_package_version` 和宿主按它查包络、加增长边距的规则）。只加可选内容，v1.3 的读者不受影响。

2026-11-17 v1.5：mod 设置的 `settings[i]` 加可选的 `category`（clothing、accessory、hair、color、other），写明 `name` 和取值 `name` 的来源。只加可选键，v1.4 的读者不受影响。

2026-11-17 v1.6：mod 设置的 `textures[i]` 和绘制清单的 `texture_variants[]` 加可选的 `indices_sha256`：贴图变体可以只换网格的一个索引块，用于只换部件一部分的贴图开关。v1.5 的读者不认这个键，会把按块的项当作整网格的项。

2026-11-19 v1.7：有 `render` 的包不再要求 `game` 等于 `arknights_endfield`（仍要求是字符串），`base_capabilities` 去掉 `game_data.basic`、`ui.assets`，`game_data`、`ui.head` 改为可省。只放宽校验，`schema_version` 不变；v1.6 的读者会拒绝缺这些的包。

2026-11-19 v2：角色包的骨骼、片段用途、外观模组表、称呼和代词改由包声明。
- 新增文件：`c7/animation/humanoid.json`（`endfield-humanoid-map/v1`，有 `render` 的包必有）；`c7/interaction/efmi-slot-hints.json`（`endfield-efmi-slot-hints/v1`）、`efmi-lod1-bones.json`（`endfield-efmi-lod1-bones/v1`），都可选，列在 pack.json 的 `interaction.data`。
- 新增字段：`motion-bindings.json` 的 `roles`（`lift_start`、`lift_end`）；`locomotion.json` 的 `stop.*.exit_s`；`actions.json` 每行的 `gestures`；角色卡的 `user_title`、`pronoun`。都可选。
- 从按名字推断改为必须由包声明：人形骨（原按 `Bip001_*` 骨名找）→ `humanoid.json`；待机片段（原按 Unity 状态名找）→ `motion-bindings.json`，改为必有；拎起片段（原按 `A_clip_<id>_…` 拼名）→ `roles`，没有时只用 `drag.lift` 事件；行走和转身片段（原按前缀拼名）→ `locomotion.json` 的 `clips`；停步退出时刻（原是宿主里的常数表）→ `exit_s`；窗顶起身片段（原按拼名）→ `affordance-uses.json` 的 `exit`；动作短语对到哪些游戏动作（原是 `phrases.json` 每组的 `actions` 列表）→ `gestures`；外观模组表（原是全局表）→ 包里的两张表；称呼和代词（原是提示词里的常量）→ 角色卡。
- 缺 `vowel-profile.json` 时 agent 语音只按音量开嘴，不再加载失败。声线只有外部 TTS 服务一种，没有地址或角色没有 `components.voice` 时只出文字。
- 新增「必需与可选」一节；「库里的文件」表补上述文件和字段的行，mod-settings 行写明现在的写入方和读者，camera 行写明宿主在舞台模式下按它取景；`distribution.json` 写为 `endfield-distribution/v3`；全文 `文件:行` 引用按现行代码改正。
- `schema_version` 和各 schema 名不变。v1.7 的包没有 `humanoid.json` 或 `motion-bindings.json` 时，v2 的宿主拒绝加载。

2026-11-20 v2.1：`bundle.json` 角色条目加三个可选引用 `neutral_scene`、`neutral_build_record`、`metal_product`（中立包，「库里的文件」表加一行、加「中立包」一段）；constants.json 加 `neutral_fields` 和三份文件的 schema。只加可选内容，v2 的读者不受影响；没有这三个引用的包照常安装和加载。

2026-11-22 v2.3：Windows 的帧表从 D3D11 段换成 Vulkan 段：`bundle.json` 角色条目的可选引用 `vulkan_frame` 指向 `vulkan/frame.bin`（`EFWVKP01`），文件列 `vulkan/blobs/`；constants.json 的 `d3d11_fields` 换成 `vulkan_fields`。没有 `d3d11_frame` 这个引用了，读者都不认它。

2026-11-24 v2.4：`components.ui` 加可选的 `background`（配 capability `ui.background`）。角色头像、立绘、背景图只随角色包走，web-ui 不再带 `art/characters/`。只加可选内容，`schema_version` 不变；v2.3 的读者不读 `background`。
