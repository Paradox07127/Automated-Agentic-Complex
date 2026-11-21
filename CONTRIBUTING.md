# 参与贡献 / Contributing

本项目是实验性质的非官方同人项目，仍在早期开发。欢迎提 issue 和 PR。

This is an experimental, unofficial fan project in early development. Issues and pull requests are welcome.

## 不接收的内容 / What this repository does not accept

- 游戏素材：模型、贴图、动作、音频、字体、界面图、文本，以及由它们转换或截取出来的文件。
- 游戏资源的提取、解包、解密工具，以及密钥、资源路径表和对象转储。
- 游戏角色的角色包、人设和声线。
- 密钥、token、证书和个人信息。

带这些内容的 issue 和 PR 会被关闭，内容会被删除。示例和测试请用仓库里的纯文字示例角色「助手」（`aide`，在 `characters/sample-library/`）或自己合成的数据。

- Game assets: models, textures, animations, audio, fonts, interface images and text, and files converted or captured from them.
- Tools that extract, unpack or decrypt game resources, and keys, resource path tables and object dumps.
- Character packages, personas and voices of game characters.
- Keys, tokens, certificates and personal information.

Issues and pull requests that contain these are closed and the content is removed. For examples and tests, use the text-only example character `aide` in `characters/sample-library/`, or data you made yourself.

## 渲染器 / The renderer

角色渲染器（macOS Metal 宿主和 Windows `efw.exe`）不在本仓库，只随发行版提供；从本仓库构建时角色只显示文字。渲染相关的问题请开 issue，附截图、日志和复现步骤。

The character renderer (the macOS Metal host and the Windows `efw.exe`) is not in this repository and ships only in releases; a build from this repository shows characters as text only. For rendering problems, open an issue with screenshots, logs and the steps to reproduce.

## 提交之前 / Before you open a pull request

环境准备见 [README](README.md) 和[开发与发行](docs/development.md)。然后在仓库根目录运行：

Set up the environment as the [README](README.en.md) and [Development and release](docs/development.en.md) describe, then run from the repository root:

```sh
python3 -I tools/qa/gate.py --profile public

# 改了 agent/ 时再跑 agentd 单测 / also run the agentd unit tests when you change agent/
cd agent/agentd/tests
AGENTD_DEV_CATALOG="$PWD/fixtures/characters/current.json" ../../.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```

- 一个 PR 只做一件事，写明改了什么、怎么验证的。
- 修 bug 请带一个改动前会失败的测试。
- 代码、标识符和提交信息用英文；提交信息一行标题，说明这次提交之后的行为。
- 会改变界面或行为的改动，请先开 issue 讨论。

- One change per pull request. Say what it changes and how you checked it.
- A bug fix comes with a test that fails before the change.
- Code, identifiers and commit messages are in English. A commit message is one title line that states the behaviour after the commit.
- Open an issue first for a change to the interface or to behaviour.

你提交的内容按本仓库的 [AGPL-3.0 许可证](LICENSE)发布。

Your contribution is released under this repository's [AGPL-3.0 License](LICENSE).
