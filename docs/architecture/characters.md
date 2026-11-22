# 角色包工具与动作生成

[English](characters.en.md) · [文档索引](../README.md)

角色库和角色包的格式见[角色库规范](../../protocol/character-library/CONTRACT.md)。

## 构建工具

`characters/build.py` 是角色包构建工具的统一入口：`python3 -I characters/build.py <tool> [args...]` 运行 `characters/agentic_complex_build/<tool>.py`。外部动作导入（`import_motion`、`import_vmd`）见[导入外部动作](../guides/motion-import.md)。

## 样例角色库

`characters/sample-library/` 是公开版的纯文字角色 `aide`（助手）组成的样例库。不带 `--character-catalog` 启动、也没设 `AGENTD_DEV_CATALOG` 的 agentd 读它的 `current.json`。`packages/aide/<sha256>/` 是可以在 app 里导入的样例角色包。

源文件在 `characters/sample-character/`（`character.json`、`persona/card.json`、`persona/lore.json`）。`characters/sample-library/` 里的文件都是 `agent/agentd/character_tool.py compose` 的产物，不要手改。

改了人设卡或设定后，在仓库根先刷新 `character.json` 里的 SHA-256 和字节数：

```sh
python3 -I -c 'import hashlib,json,pathlib;r=pathlib.Path("characters/sample-character");p=r/"character.json";d=json.loads(p.read_text());[x.update(sha256=hashlib.sha256((r/x["file"]).read_bytes()).hexdigest(),byte_count=(r/x["file"]).stat().st_size) for x in d["inventory"]+list(d["components"]["persona"].values())];p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+"\n")'
```

再重新生成样例库：

```sh
out=$(mktemp -d)/lib && agent/.venv/bin/python3 -I agent/agentd/character_tool.py compose --package characters/sample-character --default aide --output "$out" && find characters/sample-library -mindepth 1 -delete && cp -R "$out"/ characters/sample-library/
```

## 原生包打包

`characters/packaging/native_bundle.py` 按显式绑定 SHA 的输入新建一个目录。它原样复制 C7、actor archive、draw 清单、programs 和 payload。生成的光照/HDRI 描述文件会改写路径，SHA 随之级联变化；原件保留在 `provenance/` 下。打包和校验不启动 Metal、不联网、不启动宿主。

在 `characters/` 目录下运行：

```sh
python3 packaging/native_bundle.py build --recipe RECIPE.json --output NEW_DIRECTORY
python3 packaging/native_bundle.py verify NEW_DIRECTORY --deny-external-reads
python3 packaging/host_inputs.py NEW_DIRECTORY <id>
python3 packaging/host_inputs.py NEW_DIRECTORY <id> --shell-arguments
python3 -m unittest discover -s packaging -p 'test_*.py'
```

- `build` 还在每个角色的 frame graph 旁写出它的中性包：`neutral/scene.json`、`neutral/build-record.json` 和 `metal/product.json`。三者由 `neutral_package.py` 从 `graph/frame-graph.json` 拆出，条目字段 `neutral_scene`、`neutral_build_record`、`metal_product` 指向它们。拆出的三份不能逐字节还原 graph 时，`build` 拒绝。`verify` 对每个带这三个字段的条目做同样的检查，三个字段都没有的条目也接受。改 frame graph 的工具用 `write_neutral` 一起重写 graph 和这三个文件。渲染器不读这三个文件。
- 条目还可以有 `vulkan_frame`：Windows 渲染器的帧表 `vulkan/frame.bin`（magic `EFWVKP01`，程序是游戏原版 SPIR-V），放在同一个角色目录里，格式定义在 `characters/packaging/package_format.py`。`bundle.json` 列出它和 `vulkan/blobs/`。`build` 不写它。条目有它时，`verify` 要求：三个中性字段齐全；帧表的 magic 和版本是 `VK_MAGIC`、`VK_VERSION`；帧表头的 `scene_sha256` 等于 `neutral_scene` 文件的 SHA-256；每条 blob 记录的名字通过 `blob_name_ok`，指向角色目录里一个列出的文件，且 SHA-256 和大小与记录相符。`write_neutral` 会去掉 `vulkan_frame`，因为帧表属于旧的 scene。
- `host_inputs.py` 校验包，然后打印宿主现有的启动参数，不启动任何东西。JSON 里的 `argv` 可直接用于 `subprocess.run([host, *argv, ...])`，不经 shell。角色 id 取自包目录，没有内置角色列表；未知 id 报错。

## 动作生成服务

`motion/` 是动作生成服务：常驻一个 NVIDIA Kimodo 后端，按文字描述生成 SOMA-30 动作。agentd 的「模型生成」动作来源调用它。

| 文件 | 内容 |
|---|---|
| `server.py` | HTTP 服务：`GET /v1/health`、`GET /v1/skeleton`、`POST /v1/generate`，每个请求都要带 `Authorization: Bearer <token>` |
| `backend_kimodo.py` | Kimodo 与 Qwen3-8B 文本编码的加载和生成 |
| `geometry-prompts.json` | 启动时预编码的几何提示词（`--warm-prompts`） |
| `bench.py`、`latency.py` | 验收基准和经 agentd 的端到端延迟测量 |
| `lora/train.py` | LoRA 微调，结果由 `server.py --lora` 合入 |

起服务：

```sh
python3 -I -u motion/server.py --token-file <token> --host 127.0.0.1 --port 48830 --device mps \
  --warm-prompts motion/geometry-prompts.json
```

后端需要环境变量 `CHECKPOINT_DIR`、`CHECKPOINTS_DIR`、`MOTION_QWEN`、`MOTION_QWEN_PROJECTION` 和 `HF_HUB_OFFLINE=1`，含义见 `motion/backend_kimodo.py` 开头；`server.py` 的参数见它开头的 usage。

## 测试

`characters/` 的 Python 测试需要 NumPy，用[导入外部动作](../guides/motion-import.md#工具环境)里建的 pipeline 环境：

```sh
cd characters/Tests/Python && ../../../.local/venvs/pipeline/bin/python3 -I -m unittest discover -s . -p 'test_*.py'
```

动作生成服务的测试；`test_lora.py` 需要 PyTorch，缺时这一项报导入错误：

```sh
cd motion && python3 -I -m unittest discover -s tests
```
