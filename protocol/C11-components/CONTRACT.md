# C11 组件清单与组合锁 v1
状态：v1，2026-11-06

构建工具写组件清单和组合锁，构建端与宿主按同一规则读取。本文定义文件格式、树哈希和拆分版的导入。构建端的实现在 `tools/release/build_components.py`、`package_app.py`；宿主的实现在 `app/electron/src/main/components.ts`（解析 `resolveComponents`、导入 `installComponents`，`prepareComponents` 调用两者，打包启动时由 `packaged.ts` 调用）。两种版本的用法见 [docs/components.md](../../docs/components.md)。

组件包括 `runtime.python`、`agentd`、`harness.pi`、`characters.<id>`、`browser`，以及留在 app 内的 `host`、`renderer`、`web-ui`。`browser` 是预留的 ID，当前构建不产出它。同一组件在 `portable` 和 `split` 中必须有相同的版本与 `tree_sha256`，不能因安装位置重新改写组件内容。

## 1. 清单与载荷的位置

构建暂存时，每个组件用独立的父目录存放清单与载荷：

```text
<组件目录>/
  component.json
  payload/
    <组件的文件与软链接>
```

`write_component(root, id, version, entrypoints, provides, requires, placed=None)` 的 `root` 是载荷目录。工具把 `root` 解析为绝对路径后，写到 `root.parent / "component.json"`，并返回清单对象。这里的 `payload` 是暂存目录名示例，哈希不包含根目录名。每个暂存载荷应有独立父目录，避免不同组件覆盖同一清单。构建清单写在暂存载荷旁边，不写进载荷。

`component.json` 自身不属于它描述的树。为避免自引用，哈希也排除载荷根目录中的 `component.json`；更深层同名文件是载荷的一部分，照常参与哈希。

`host` 和 `renderer` 是固定位置组件：两种形态的清单都放在 `Contents/Resources/components/<id>/component.json`，app 内这两个组件目录没有 `payload/`。暂存载荷通过第 2 节的 `placed` 映射放到 `Contents` 下的固定位置，主程序和渲染器留在 `MacOS/`，预览 XPC 留在 `XPCServices/`。

除此之外，`placement: bundle` 的组件位于 `Contents/Resources/components/<id>/`，包含 `component.json` 和 `payload/`。portable 的组合锁位于 `Contents/Resources/composition.lock.json`。

`windows-x64` 只有 portable：便携目录 `Agentic Complex\` 代替 `Contents`，`Agentic Complex.exe`、`ac-helper.exe`、`efw.exe` 在它下面，`resources\` 代替 `Contents/Resources`；`placed` 的目标相对便携目录，其余位置同上。

## 2. `component.json`

UTF-8 JSON 对象，下表字段全部必填，空映射写 `{}`。

| 字段 | 类型与取值 | 含义 |
|---|---|---|
| `schema` | 字符串，固定 `endfield-component/v1` | 格式版本 |
| `id` | 字符串，匹配 `^[a-z][a-z0-9._-]{0,63}$` | 组件标识，例如 `agentd`、`characters.aster` |
| `version` | 字符串，匹配 `^[0-9]+(?:\.[0-9]+)*$` | 精确版本，例如 `1`、`1.0.0`、`3.13.9`；不接受范围、前缀或预发布后缀 |
| `tree_sha256` | 字符串，64 位小写十六进制 | 第 4 节的树哈希 |
| `files` | 非负整数，不能是布尔值 | 参与哈希的普通文件和软链接条数；不计目录 |
| `bytes` | 非负整数，不能是布尔值 | 参与哈希的普通文件内容字节数之和；不计软链接目标文本 |
| `entrypoints` | 对象：非空名称 → 相对路径字符串 | 例如 `python` → `bin/python3`、`launcher` → `launcher.py`、`hook_forwarder` → `hook_forwarder.py`、`character_tool` → `character_tool.py` |
| `provides` | 对象：接口 ID → 版本字符串 | 例如 `{"C8": "1"}` |
| `requires` | 对象：接口 ID 或组件 ID → 版本字符串 | 例如 `{"C8": "1", "runtime.python": "3.13.9"}` |
| `platform` | 字符串，`macos-arm64` 或 `windows-x64` | 组件所属平台 |

入口路径相对于载荷根目录，使用 POSIX `/`，不得为空、绝对路径、带反斜杠或 NUL，也不得有空段、`.`、`..` 段。清单校验只检查路径格式；文件是否存在由拿到载荷的读取方核对。

`placed` 是仅供 `host` 和 `renderer` 使用的可选字段；其他 ID 不得携带该字段，即使值为 `{}`。其值必须是对象，键是暂存载荷内的相对路径，值是相对 app 的 `Contents` 的目标路径；键和值都遵循上述入口路径规则。

接口 ID 匹配 `^[A-Z][A-Za-z0-9.-]{0,63}$`，与小写开头的组件 ID 区分；接口版本也使用上述数字点分版本格式。`requires` 表示精确版本相等，不做范围解析，`1` 与 `1.0` 不等价。`provides` 只声明接口，不能用它代替组件身份。

## 3. `composition.lock.json`

UTF-8 JSON 对象，下表字段全部必填。

| 字段 | 类型与取值 | 含义 |
|---|---|---|
| `schema` | 字符串，固定 `endfield-composition/v1` | 格式版本 |
| `edition` | 字符串，`portable` 或 `split` | 产品形态 |
| `platform` | 字符串，`macos-arm64` 或 `windows-x64` | 所有组件的平台；宿主只接受与所在系统相同的平台 |
| `created_at` | 字符串，UTC `YYYY-MM-DDTHH:MM:SSZ`，必须是有效日期时间 | 锁文件生成时间 |
| `host` | 对象，必填 `id`、`version`、`tree_sha256` | 宿主组件引用，隐含 `bundle` 位置 |
| `components` | 数组，每项必填 `id`、`version`、`tree_sha256`、`placement` | 除宿主外的组件引用 |

引用中的 `id`、`version`、`tree_sha256` 与组件清单同类型、同格式。`host.id` 与所有 `components[].id` 组成一个集合，不允许重复，也不能用不同版本重复同一个 ID。

`placement` 只能是 `bundle` 或 `support`：

| edition | host | renderer、web-ui | 其他组件 |
|---|---|---|---|
| `portable` | `bundle`（隐含） | `bundle` | `bundle` |
| `split` | `bundle`（隐含） | `bundle` | `support` |

`split` 从本地目录（第 7 节）导入外置组件到 `<发行身份的支持目录>/components/<id>/<version>-<sha8>/`，其中支持目录由 app 的 `distribution.json` 中的 `id` 确定，`sha8` 是 `tree_sha256` 的前 8 个字符。目录缩写不能代替完整哈希校验。

`write_lock(path, edition, host, components)` 在指定路径写锁文件，平台由 `platform` 参数给出（默认 `macos-arm64`），`created_at` 为当前 UTC 秒。调用方传入宿主引用和带 `placement` 的组件引用；工具不选择组件、不修改载荷。

## 4. 树哈希

有 `payload/` 的组件，其 Mach-O 只在组件构建时签名一次，随后计算树哈希；`portable` 与 `split` 拷贝同一份已签名字节。app 签名不得重签 `Contents/Resources/components/` 下的任何内容。

`host` 和 `renderer` 的 `tree_sha256` 覆盖未签名的暂存载荷；该载荷不包含组合锁、`Resources/components/` 或签名产物。app 内已签名的副本通过 `codesign --verify --strict --deep` 校验，不用其字节重算树哈希。

1. 遍历载荷根目录，不跟随软链接，包含隐藏文件。任意层级的 `.DS_Store`、`__pycache__` 条目都排除；若是目录则排除整个子树。另按第 1 节排除根目录中的自身清单。
2. 使用 POSIX 相对路径，不包含根目录名；不做 Unicode 归一化。所有条目按相对路径的 **UTF-8 字节** 升序排列。
3. 每个普通文件写一条记录，字段之间恰好一个 ASCII 空格：

   ```text
   F <path> <mode-exec-bit 0|1> <size> <sha256 of content>
   ```

   任意执行位被设置（`st_mode & 0o111 != 0`）则 `mode-exec-bit` 为 `1`，否则为 `0`；`size` 为十进制内容字节数，内容哈希为 64 位小写十六进制。
4. 每个软链接写一条记录；即使目标不存在或指向目录，也只记录原样的目标文本：

   ```text
   L <path> <link target>
   ```

   不解析目标、不读取目标内容。目录不写记录，也不参与哈希；载荷不得含其他文件类型。
5. 用 `\n` 连接这些记录，末尾不额外加换行，对连接结果的 UTF-8 字节求 SHA-256，得到小写十六进制 `tree_sha256`。空树是空字节串的 SHA-256。路径与链接目标直接放入记录，不增加 JSON 转义。

mtime、所有者、扩展属性、非执行权限、目录权限、文件创建顺序和根目录位置都不参与哈希。APFS clone 与保留内容、执行位、链接目标的普通复制得到相同哈希；改变一个内容字节、从无执行位变成有执行位、改变软链接目标文本都会改变哈希。

## 5. 读取方校验规则

1. 先检查对象、全部必填字段、字段类型、schema、平台与格式。布尔值不能冒充整数；ID、版本和 SHA-256 必须完整匹配，不能只匹配前缀。沿用协议目录约定，忽略未知字段。
2. 检查锁文件没有重复 ID，组件位置符合 edition。
3. 调用方为锁中 `host` 和 `components` 的每个引用提供恰好一份同 ID 的组件清单（宿主也有自己的 `component.json`），不得缺少、重复或多出清单。逐个核对清单的 `version`、`tree_sha256` 与锁引用相同，`platform` 与锁相同。有 `payload/` 的组件按第 4 节重算载荷哈希、`files` 和 `bytes`；`host` 和 `renderer` 的这三项在未签名暂存载荷上重算，app 内的副本按第 4 节校验签名。入口存在性在实际安装位置核对，固定位置组件按 `placed` 定位。只验证 JSON 不等于已经验证磁盘内容。
4. 每个清单的 `requires` 中，组件依赖必须出现在同一锁的 `host` 或 `components` 中，且版本字符串完全相等。缺少组件或版本不等均拒绝。
5. 接口依赖必须由同一组合中至少一个清单的 `provides` 提供相同版本；多个 harness 可以同时提供 `C8`，这不属于重复组件 ID。
6. 宿主每次启动只做第 1、2 条，第 3 条的清单对应关系、引用字段和入口存在性检查（有 `payload/` 的入口还须在载荷根目录内，不经软链接跳出），以及第 4、5 条，不重算树哈希。有 `payload/` 的组件在构建（portable 的回执）和导入（split 装进支持目录）时完整重算；固定位置组件在构建时对未签名暂存载荷重算。
7. 宿主启动时，锁读不了或 `host` 没通过就报配置错误，不启动任何子进程。其他组件没通过时不中断：宿主把它和原因写进支持目录 `config.json` 的 `missing_components`，不启动它的子进程。依赖一个没通过的组件的组件也判为没通过，原因是 `requirementUnmet`；按此反复剔除，直到剩下的组件依赖都满足。`host` 依赖的组件或接口的提供方没通过时，`host` 照常运行；那个提供方已经记为缺。

## 6. 参照工具与样例

- `validate.py <file>`：按 schema 选择 `check_component(doc)`、`check_lock(doc)` 或 `check_index(doc)`（第 7 节），合法返回 `None` 并退出 0，否则返回错误字符串、打印错误并退出 1。
- `check_lock(doc)` 仍只检查锁文件自身的字段和位置。`check_composition(lock, manifests)` 接收已通过 `check_lock` 的锁和已逐个通过 `check_component` 的清单列表（包含宿主），检查第 5 节第 3 条的清单对应关系、`version`、`tree_sha256`、`platform`，以及第 4、5 条的依赖。合法返回 `None`，否则返回一个包含清单 ID 与缺少或不匹配项的错误字符串。
- `validate.py <lock.json> <component.json>...`：依次运行 `check_lock`、每份清单的 `check_component`、`check_composition`，全部通过才退出 0，否则打印首个错误并退出 1。清单路径由调用方显式提供，不从锁文件旁查找。
- `examples/ok-*.json` 是字段格式样例，SHA、文件数与字节数是占位值，不是发行产物凭据。两份锁示例引用相同组件，仅改变 edition 与外置组件的 placement；`ok-index.json` 列出 split 锁中 `support` 的组件。`bad-*.json` 是非法样例，`test_validate.py` 核对具体错误。
- `python3 -I tools/release/component_manifest.py hash <dir>` 只输出一行树哈希。`tools/release/tests/test_component_manifest.py` 使用临时载荷验证记录格式、APFS clone、顺序无关性、内容/执行位/链接变更及清单输出。

## 7. 拆分版导入索引 `components/index.json`

拆分版 app 旁边的 `components/` 目录放外置组件和索引：

```text
<app 所在目录>/
  Agentic Complex.app/
  components/
    index.json
    <dir>/
      component.json
      payload/
```

`index.json` 是 UTF-8 JSON 对象，下表字段全部必填。

| 字段 | 类型与取值 | 含义 |
|---|---|---|
| `schema` | 字符串，固定 `endfield-components-index/v1` | 格式版本 |
| `components` | 数组，每项必填 `id`、`version`、`tree_sha256`、`manifest_sha256`、`dir` | 要装进支持目录的组件 |

`id`、`version`、`tree_sha256` 与组件清单同类型、同格式。`dir` 是相对 `components/` 的目录，遵循第 2 节的入口路径规则。ID 不得重复，也不得是留在 app 内的 `host`、`renderer`、`web-ui`。

打包时把索引写入签名覆盖的 `Contents/Resources/components-index.json`。每项的 `manifest_sha256` 是外置组件 `component.json` 文件的 SHA-256。启动时若 app 旁有索引，其字节必须与 app 内的索引完全相同。

外置载荷不能带有树哈希排除的 Python 字节码缓存目录 `__pycache__`。宿主以 app 内的索引校验每个外置组件的清单、载荷树哈希、文件数、字节数和入口。未安装的组件先复制到支持目录内的暂存目录，通过校验后改名为 `<id>/<version>-<sha8>/`。每次启动都重新校验已安装的组件，包括移走外置目录后的启动。失败的组件记为缺，原因写入宿主日志，其余组件照常解析。宿主把本次组合写入 `<支持目录>/components/composition.lock.json`。宿主清单或签名索引不可读、索引无效或内外索引不一致时，启动报配置错误。
