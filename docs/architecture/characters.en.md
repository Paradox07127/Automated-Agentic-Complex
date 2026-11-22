# Character package tools and motion generation

[简体中文](characters.md) · [Documentation index](../README.en.md)

For the format of character libraries and packages, see the [character library contract](../../protocol/character-library/CONTRACT.md).

## Build tools

`characters/build.py` is the single entry point for the character package build tools: `python3 -I characters/build.py <tool> [args...]` runs `characters/agentic_complex_build/<tool>.py`. For external motion import (`import_motion`, `import_vmd`), see [Importing external motion](../guides/motion-import.en.md).

## Sample character library

`characters/sample-library/` is the sample library made of the public text-only character `aide` (助手, Aide). agentd started without `--character-catalog` and without `AGENTD_DEV_CATALOG` reads its `current.json`. `packages/aide/<sha256>/` is a sample character package you can import in the app.

The source files are in `characters/sample-character/` (`character.json`, `persona/card.json`, `persona/lore.json`). Every file in `characters/sample-library/` is output of `agent/agentd/character_tool.py compose`; do not edit them by hand.

After changing the persona card or setting, first refresh the SHA-256 and byte counts in `character.json` from the repository root:

```sh
python3 -I -c 'import hashlib,json,pathlib;r=pathlib.Path("characters/sample-character");p=r/"character.json";d=json.loads(p.read_text());[x.update(sha256=hashlib.sha256((r/x["file"]).read_bytes()).hexdigest(),byte_count=(r/x["file"]).stat().st_size) for x in d["inventory"]+list(d["components"]["persona"].values())];p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+"\n")'
```

Then regenerate the sample library:

```sh
out=$(mktemp -d)/lib && agent/.venv/bin/python3 -I agent/agentd/character_tool.py compose --package characters/sample-character --default aide --output "$out" && find characters/sample-library -mindepth 1 -delete && cp -R "$out"/ characters/sample-library/
```

## Native bundle packing

`characters/packaging/native_bundle.py` builds a new directory from explicit SHA-bound inputs. It copies the C7, actor archive, draw manifests, programs and payloads unchanged. The generated lighting/HDRI descriptors get rebased paths, with cascaded SHA changes; their originals are kept under `provenance/`. Building and verifying start no Metal device, use no network and launch no host.

Run from the `characters/` directory:

```sh
python3 packaging/native_bundle.py build --recipe RECIPE.json --output NEW_DIRECTORY
python3 packaging/native_bundle.py verify NEW_DIRECTORY --deny-external-reads
python3 packaging/host_inputs.py NEW_DIRECTORY <id>
python3 packaging/host_inputs.py NEW_DIRECTORY <id> --shell-arguments
python3 -m unittest discover -s packaging -p 'test_*.py'
```

- `build` also writes each character's neutral package beside its frame graph: `neutral/scene.json`, `neutral/build-record.json` and `metal/product.json`. `neutral_package.py` splits the three from `graph/frame-graph.json`, and the entry fields `neutral_scene`, `neutral_build_record` and `metal_product` point at them. `build` refuses a graph whose split does not emit it back byte for byte. `verify` runs the same check on every entry that has the three fields, and accepts entries that have none of them. Tools that change a frame graph rewrite the graph and the three files together with `write_neutral`. Renderers do not read these three files.
- An entry may also have `vulkan_frame`: the Windows renderer's frame table `vulkan/frame.bin` (magic `EFWVKP01`, its programs the game's original SPIR-V) in the same character directory, with its format defined in `characters/packaging/package_format.py`. `bundle.json` lists it and `vulkan/blobs/`. `build` never writes it. Where an entry has it, `verify` requires: all three neutral fields; a frame table whose magic and version are `VK_MAGIC` and `VK_VERSION`; a frame table header whose `scene_sha256` is the SHA-256 of the `neutral_scene` file; and, for every blob record, a name that `blob_name_ok` accepts, naming a listed file of the character directory with the recorded SHA-256 and size. `write_neutral` drops `vulkan_frame`, because the table belongs to the old scene.
- `host_inputs.py` verifies the bundle, then prints the host's existing launch arguments; it launches nothing. The JSON `argv` can go straight into `subprocess.run([host, *argv, ...])`, without a shell. Character ids come from the bundle directory, not a built-in list; an unknown id fails.

## Motion generation service

`motion/` is the motion generation service. It keeps an NVIDIA Kimodo backend loaded and generates SOMA-30 motion from a text description. agentd's 模型生成 (Model-generated) motion source calls it.

| File | Contents |
|---|---|
| `server.py` | HTTP service: `GET /v1/health`, `GET /v1/skeleton`, `POST /v1/generate`; every request must carry `Authorization: Bearer <token>` |
| `backend_kimodo.py` | Loading and generation for Kimodo and the Qwen3-8B text encoder |
| `geometry-prompts.json` | Geometry prompts encoded at startup (`--warm-prompts`) |
| `bench.py`, `latency.py` | Acceptance benchmark and end-to-end latency measurement through agentd |
| `lora/train.py` | LoRA fine-tuning; `server.py --lora` merges the result |

Start the service:

```sh
python3 -I -u motion/server.py --token-file <token> --host 127.0.0.1 --port 48830 --device mps \
  --warm-prompts motion/geometry-prompts.json
```

The backend needs the environment variables `CHECKPOINT_DIR`, `CHECKPOINTS_DIR`, `MOTION_QWEN`, `MOTION_QWEN_PROJECTION` and `HF_HUB_OFFLINE=1`, described at the top of `motion/backend_kimodo.py`. The `server.py` arguments are in the usage text at the top of that file.

## Tests

The Python tests of `characters/` need NumPy; use the pipeline environment from [Importing external motion](../guides/motion-import.en.md#tool-environment):

```sh
cd characters/Tests/Python && ../../../.local/venvs/pipeline/bin/python3 -I -m unittest discover -s . -p 'test_*.py'
```

Tests of the motion generation service; `test_lora.py` needs PyTorch and reports an import error without it:

```sh
cd motion && python3 -I -m unittest discover -s tests
```
