# Importing external motion

[简体中文](motion-import.md) · [Documentation index](../README.en.md)

## Overview

`characters/build.py import_motion` (`characters/agentic_complex_build/import_motion.py`) imports VMD, BVH, glTF/GLB, VRMA and FBX motion offline onto existing character packages and publishes a new offline character library. Each character goes through `motion_import.pipeline.import_file`; the app's `agent/agentd/motion_tool.py import` uses the same Python entry point, and the result is the same `endfield-motion-import/v1`. `build.py import_vmd` is the VMD-only offline entry point, with extra options such as a music excerpt and a source model skeleton; see "VMD import".

In the app, import motion from 角色 › 导入 (Character › Import), or drop a VMD or ZIP file directly onto the character.

## MMD project import in the app

The whole package of an MMD song (a folder, a ZIP or several selected files) can be imported into the shared dance library at once; it may hold several body motions, lip-sync VMDs, several cameras and several audio tracks:

- `motion_tool.py mmd-scan` sorts the files first: a VMD with bone keys is a body, one with only camera keys a camera, one with only morph keys a lip-sync (face) VMD; audio goes by suffix, and the rest is listed as ignored. A folder is walked recursively, skipping hidden entries and `__MACOSX`; a ZIP is extracted into a temporary folder.
- Each body is labelled by the part of its file name that differs from the other bodies' (`…_HimeTanaka_v1.1[f-19].vmd` and `…_HinaSuzuki_v1.1[f-19].vmd` become `HimeTanaka` and `HinaSuzuki`).
- A trailing `[fN]` on a body VMD's stem (such as `[f-19]` or `[f4930]`) places the motion at frame N of the song (30 fps), so the music offset defaults to N / 30 seconds. It may be negative: the music then starts after that many seconds of silence.
- By default the longest body, the longest camera, the first audio track and the lip-sync VMD whose name contains the chosen body's label (or the only one) are chosen; the page lets you change each.
- `motion_tool.py import` takes the lip-sync VMD as `--morph` and the camera VMD as `--camera`, both only with a VMD body; `--project` and `--role` record the song title and this body's role. Several dropped files or a ZIP are sorted the same way and take the same default choices; files left out become `ignored_file` warnings instead of failing for "more than one".
- `motion_tool.py mmd-media` gives a library song other music or another offset: it swaps only the music, without baking it again, and keeps its id; the current character's row gets it at once, the other characters on their next `mmd-sync`, which swaps only the music.
- Limits: a ZIP file is at most 512 MiB; one ZIP or folder holds at most 256 files and 1 GiB in all.

## Tool environment

Create the pipeline tool environment (Python 3.12) in the repository root and install NumPy from `requirements-mmd.txt`:

```sh
uv venv --python 3.12 .local/venvs/pipeline
uv pip install --python .local/venvs/pipeline/bin/python3 \
  -r characters/agentic_complex_build/requirements-mmd.txt
```

## Command and output

```sh
.local/venvs/pipeline/bin/python3 -I \
  characters/build.py import_motion \
  --library /absolute/path/to/existing-library \
  --character <id> --character <id> \
  --source /absolute/path/to/walk.bvh \
  --title '导入走路' --output .local/cache/my-motion-generation --export
```

The flags are defined in the [external motion import contract](../../protocol/character-library/MOTION-IMPORT.md). `--output` must be a new directory and may not be inside the input library.

Output:

- `packages-built/<id>/`: the character packages after import.
- `library/current.json`: the new library, with every original character; the selected characters' package versions get a patch increment and the default character is kept. Packages are copied as APFS clones; the input library is not changed.
- `import-result.json`: an array with one entry per character, each the result of `take.build_result(...)`, with `created_at` in UTC seconds; `take.check_result` validates it.
- With `--export`, also `<id>.endfield-character`.

On failure the whole output directory is removed. The offline entry point writes no library index `motion-imports/<character>/imports.json` and does not call the host's `--validate-pack`; only the app's `motion_tool.py import` does these two steps.

## Formats

With `--format auto` (the default), `detect` in `motion_import/formats.py` checks the content first and the suffix last:

1. A `Vocaloid Motion Data` header → `vmd`;
2. A GLB 2 with the `glTF` header → `vrma` when it uses the `VRMC_vrm_animation` extension, else `gltf`;
3. `PK\x03\x04` → `zip`; `Kaydara FBX Binary` → `fbx`;
4. Text starting with `HIERARCHY` → `bvh`; starting with `; FBX` → `fbx`;
5. JSON starting with `{` that has `asset` → `vrma` or `gltf` (as in 2);
6. Otherwise by suffix: `.vmd`, `.bvh`, `.glb`/`.gltf`, `.vrma`, `.fbx`, `.zip`.

- `vmd`, `bvh`, `gltf`, `vrma` and `fbx` can be imported.
- `fbx` is read by the `fbx-motion` tool named by `AAC_FBX_TOOL`; without it the import fails with `unsupported_format: fbx_tool_missing`. The app ships this tool; for offline use, build it with `characters/agentic_complex_build/motion_import/native/build.sh <output path>`.
- `zip` is recognized but not imported (`unsupported_format: zip`). On the app side, `agent/agentd/motion/zip_import.py` unpacks ZIP files.
- VMD is retargeted by `import_vmd.import_motion` (`retarget: "mmd-vmd"`). Other formats are first read into a `MotionTake` on the canonical joints, resampled to 30 fps, then baked by `motion_import/bake.py` onto the character's native skeleton by bone direction (`retarget: "humanoid-bone-direction"`).

## Retargeting

- Source bones are mapped to canonical joints by name (`take.CANONICAL`, including `HandTip`). Unrecognized bones go into `unmapped` with the warning `unmapped_bones`. A missing required bone, such as a leg, fails with `unmapped_skeleton: <canonical name>`; `--bone-map` can fill it in.
- Neutral pose: for BVH, the OFFSET hierarchy with all channels at 0 (identity global rotations); for glTF and VRMA, each node's default TRS (the VRMA extension requires it to be the VRM T-pose). Rotations are global rotations relative to the neutral pose.
- No unit guessing and no axis conversion: the source's length unit and up axis are kept as they are. Baking uses only bone directions and relative rotations, so the same motion in centimetres or metres, Y-up or Z-up, bakes to the same pose.
- Missing joints are synthesized from the neutral pose, independent of units: a missing `Shoulder` is the midpoint of `Chest` and `Arm` (`shoulder_synthesized`); a missing `HandTip` is `Hand + 0.4×(Hand − ForeArm)` (`hand_tip_synthesized`); a missing `ToeBase` extends 0.12 of the leg length forward along the facing direction (`toe_synthesized`). When `Neck1` is missing, VRM lacks `chest`, or Hips connects straight to the neck, the spine and neck are filled in on the Hips→Head line by `humanoid_map.SPINE_HEIGHTS`, taking the rotation of the real bone below (`synthesized_bones: <canonical names,…>`). Missing limbs, Hips or Head still fail with `unmapped_skeleton`.
- Ground contact is judged in the target skeleton's space (metres, Y up), then the feet are locked; `--no-foot-lock` turns this off.
- A mirrored node in glTF (negative determinant) fails with `bad_source: mirrored_node`.

## Limits and coverage

Limits:

- One motion, music track or face clip is at most 360 seconds (`take.MAX_SECONDS`, `motion_tool.MAX_SECONDS`); imports are 30 fps.
- A ZIP file is at most 512 MiB; one ZIP or folder holds at most 256 files and 1 GiB in all.
- File size: VMD and BVH 64 MiB, glTF/GLB/VRMA 256 MiB, background music 256 MiB.
- Samples: for BVH and glTF, frames × joints/nodes is at most 4,000,000; BVH has at most 512 joints.
- glTF sparse accessors are rejected (`bad_source: sparse_accessor`).

Coverage:

- Body and root motion: imported for every importable format.
- Fingers: VMD fingers are retargeted (`fingers: "retargeted"`). Other formats retarget fingers too when the finger bones map; otherwise they stay at rest (`fingers: "rest"`, warning `fingers_rest`).
- Expressions: VMD expressions (the body VMD's own, or a lip-sync VMD given as `--morph`) go into `tracks.face`. glTF morph weights and VRMA expressions are only parsed and listed in `source.expressions`, not written into the package (warning `expressions_not_applied`).
- Camera: a VMD camera goes into `tracks.camera`, through the app's import only; the offline entry point has no camera flag, and other formats import no camera.
- VRMA `lookAt` is ignored (warning `look_at_ignored`); VRMA translation channels other than hips, and all scale channels, are ignored (`translation_ignored`, `scale_ignored`).

## VMD import

`build.py import_vmd` (`characters/agentic_complex_build/import_vmd.py`) reads the real skeleton of existing character packages, generates native `ActorArchive` curves, action menu entries and the full package inventory, and publishes them to a new offline character library. It uses the pipeline environment from "Tool environment" and needs no SciPy; the app's VMD import uses the NumPy bundled with the app.

```sh
.local/venvs/pipeline/bin/python3 -I \
  characters/build.py import_vmd \
  --library /absolute/path/to/existing-library \
  --character <id> --character <id> \
  --vmd /absolute/path/to/motion.vmd \
  --bgm /absolute/path/to/music.wav \
  --title '导入舞蹈' --output .local/cache/my-vmd-generation --export
```

- The output is the same as for `import_motion`: `packages-built/<id>/`, `library/current.json`, `import-result.json`, and each character's `.endfield-character` with `--export`. The imported motion appears in the character's existing action menu.
- `--source-model original.pmd` calibrates with the PMD skeleton of the motion's original model; without it, the project's own standard MMD control skeleton is used. A different original model proportion affects the retargeting result. The character skeleton, rest scale, existing actions, meshes, shaders and lighting assets are kept.
- `--start 30 --duration 4` imports one excerpt, with start and end quantized to 30 fps. One excerpt is at most 360 seconds, and the input range and evaluation memory are bounded; import a long file in parts. `--no-foot-ik` turns off the target foot correction.
- Each output must be a new directory, not inside the input package or library. On failure the run's staging directory is cleaned up.

### Music sync

- `--bgm` is decoded to stereo 48 kHz PCM by the system's `/usr/bin/afconvert`. By default the music is cut from the motion's `--start` position; `--bgm-start` sets the track start separately (the second of the source audio that motion frame 0 plays with; a negative value pads that much silence first). The track is cut to the motion length, a shortfall is padded with silence, and the padded frame count is recorded in the report.
- The music starts once the first real Metal committed frame of that play is confirmed. Animation time follows the source sample position consumed by `AVAudioPlayerNode`; when the renderer is hidden or paused, both freeze and then resume. A looping play restarts the track from zero; when the motion is replaced or stopped, the old track stops.
- This clock is the render progress of the source audio; the display, the audio device and the speakers each add latency. `max_animation_clock_drift_s` in the receipt is not an acoustic or end-to-end sync accuracy.

### Library generations and rollback

Offline commands rewrite neither the input library nor the installed app. The output library uses its own APFS clone files, with no shared writable links. The new library contains every original character; the selected characters' package versions get a patch increment, and the default character is kept.

The character package installer refuses to replace an existing package with the same ID; the app's VMD import uses a separate upgrade flow. An offline output package can be imported into a fresh library; updating an existing ID belongs in an offline library switch or a release seed migration. To try the new library in the app, point `character_catalog` in config.json to the new `library/current.json`. To roll back, point it back to the original library.

### Coverage and limits

- Supported: VMD 0002 body, root motion, Bezier interpolation, fingers, twist and standard foot/toe IK. The source model must be PMD. Coverage of unknown control bones is written to each import report.
- Expressions: when the VMD has morphs and the character package has `original-face-controls.json` (`endfield-original-face-controls-v2`) and `emotion-lipsync.json`, `import_vmd.py` uses `mmd/morph.py` to write the mappable morphs to `animation/face/<clip>.json` and registers it in the expression library `facial-animations.json`; the host plays it with the motion. A `mmd-morph-map.json` in the package overrides the default mapping.
- Camera: when `motion_tool.py`'s import recognizes a camera VMD among the input files, `import_vmd.py` writes `animation/camera/<clip>.json`; the host frames by it in the stage box only in the fullscreen viewport with `set_render.camera.track` set to `stage`. The `build.py import_vmd` command line takes no camera VMD.
- Lights and PMX models are not imported, and there is no full MMD physics.
- Portrait framing keeps the character's original composition; large sideways moves or stretches can leave the frame.

## Relation to the contract

The import request flags, the import result `endfield-motion-import/v1`, the in-package report, the library index and the warning/failure codes are defined in the [external motion import contract](../../protocol/character-library/MOTION-IMPORT.md); structures and validation are in `motion_import/take.py`. This page covers only how to use the offline commands; where the two disagree, the contract wins.
