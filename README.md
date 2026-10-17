# dsh-auto-create-folder

【懒人插件】在开始项目前无需自己创建文件夹，会自动创建一个总文件，后面的项目都在这里面完成。
在 **设置 → 通用设置** 里有一个「自动创建文件夹」开关，默认开启，切换后立即生效、无需重启。
兼容性：DSH 0.2.1-rc.2（Cordis 4.0.5）；服务端 51 项 / 客户端 34 项断言全部通过。

## 行为规则

| 情况 | 结果 |
| --- | --- |
| 在工作区里写一个新文件，例如 `login.tsx` | 落到 `<工作区>/<任务名>/login.tsx` |
| 写 `src/ui/panel.tsx` | 落到 `<工作区>/<任务名>/src/ui/panel.tsx`（保留相对层级） |
| 要求里给了总文件夹地址，例如 `D:\DSH工作区\期末大作业` | 直接用这个文件夹：不存在就按该地址建，已存在就复用，不再另建任务名文件夹 |
| 口语点名了一个工作区里**已存在**的文件夹，例如「就在 车牌识别 文件夹里做」 | 用这个文件夹 |
| 给的就是工作区根目录本身 | 什么都不建，文件留在根目录 |
| 给的是某个**文件**的路径，例如 `需求.pdf` | 不当文件夹看，按任务名正常建夹 |
| 目标文件**已经存在** | 原地覆盖，不移动（只有“新建”才会归入文件夹） |
| 目标路径在工作区之外 | 完全不处理 |
| 路径已经在任务文件夹里 | 不重复嵌套 |
| 同一会话继续创建 | 复用同一个文件夹 |
| 同名文件夹**已经存在**（你自己建的，或记录丢失） | 直接**复用**它，不再新建 |
| 名字被**别的会话**占了，或同名位置被文件占住 | 才加 `-2`、`-3` 后缀 |
| 文件夹名含 `<>:"/\|?*`、控制字符、超长 | 非法字符替换为 `_`，长度截断到 40 字符 |

状态记录在工作区根目录的 `.dsh-auto-create-folder.json`（会话 id → 文件夹名），用于重启/重载后继续复用同一个文件夹。

## 设置开关

- 位置：设置 → 通用设置 → 自动创建文件夹（Switch）。
- 由插件导出的 `Config = z.object({ enabled: z.boolean().default(true).volatile() })` 提供；`volatile()` 字段是可热更新的，
  DSH 设置服务把它注册成 profile patch 里的 `auto-folder` 条目，客户端通过 `configForms.get("auto-folder")` 读写。
- 关闭后所有重定向立即停止（当前已在文件夹里的会话记录仍然保留）。

## 文件结构

```
插件/
  package.json        包名 dsh-auto-create-folder；dsh.client 声明浏览器端
  cordis.patch.yml    bundle 安装方式用的 patch 层（id: auto-folder）
  lib/auto-folder.js  服务端插件（拦截 + 重定向 + Config）
  lib/client.js       浏览器端插件（通用设置里的开关行）
  test/smoke.mjs      服务端 51 项断言
  test/client.mjs     客户端 34 项断言
```

## 它怎么工作的（实现要点）

1. 工具参数在 DSH 工具管线里是**深冻结**的，`fs/write-intent` / `fs/edit-intent` 这两个 waterfall 又只在预设作用域内派发，
   插件监听不到。因此改为包裹 `fs` **服务实例**：
2. `ctx.on("tools/execute", ...)` 在每次 `write` / `edit` / `str_replace_editor` 调用前记录当前会话（cwd + session）；
3. 被包裹的 `service.resolve()` 在解析路径时“武装”返回的 target 对象；
4. 被包裹的 `service.writeText()` 在真正写盘前，把“武装”过的 target 的 `displayPath` / `targetKey` 改到任务文件夹里，
   所以不仅文件落点变了，模型看到并回报的路径也是新路径；
5. `editText()` 只解除武装（编辑已有文件不搬运）；
6. profile 重载会**替换** `fs` 服务实例，所以每次工具调用都会调用 `ensurePatched()`（WeakSet + `Symbol.for("dsh-auto-create-folder.patched")`）重新包裹新实例。

## 安装与启用

### 方式 A（patch 插入行：免安装、热生效）

在 profile 的 patch 层 `C:\Users\HP\.dsh\profiles\desktop\cordis.patch.yml` 的 `- insert:` 列表里加一行：

```yaml
- insert:
    - id: auto-folder
      name: 'D:\DSH工作区\插件\lib\auto-folder.js'
```

`id` 同时是设置项的名字空间（客户端读的是 `configForms.get("auto-folder")`），必须保持一致。
本条目的 package.json 就在模块文件的上一级目录，DSH 客户端模块扫描会自动找到它并加载 `lib/client.js`，所以设置页开关也会出现。

### 方式 B（bundle 方式：**当前机器使用的方式**，也是分发给别人的方式）

```powershell
# 在 profile 目录（C:\Users\HP\.dsh\profiles\desktop）里执行：
pnpm add "D:\DSH工作区\插件"
# 然后把 "dsh-auto-create-folder" 追加到该目录 package.json 的 dsh.profile.bundles 列表
```

### 方式 C（从 GitHub 安装）

```powershell
# 在 profile 目录（C:\Users\HP\.dsh\profiles\desktop）里执行：
pnpm add "github:1fufu1/dsh-auto-create-folder"
# 或者：pnpm add "git+https://github.com/1fufu1/dsh-auto-create-folder.git"
# 然后把 "dsh-auto-create-folder" 追加到该目录 package.json 的 dsh.profile.bundles 列表
```

仓库：<https://github.com/1fufu1/dsh-auto-create-folder>（仓库名与包名一致）。

两种方式**只用一种**，否则会出现两个条目、两个开关。

## 已知限制

只有经由 `write` / `edit` / `str_replace_editor` 这类文件工具创建的文件会被归入文件夹。
通过 `bash` / `pwsh` / `run_code` 里的脚本直接写出来的文件，插件看不到（这些工具的落点不由 `fs` 服务决定），因此不会被重定向。

改插件源码后，**正在运行的 DSH 进程仍持有旧模块**（Node ESM 按 URL 缓存；禁用/再启用条目也不会重新加载）。改动需重启 DSH 才生效。

## 自检

```powershell
cd "D:\DSH工作区\插件"
node test/smoke.mjs    # 服务端：PASS 51  FAIL 0
node test/client.mjs   # 客户端：PASS 34  FAIL 0
```

两个测试都用桩对象替换 Cordis ctx / Session / fs 服务（写真实临时文件），不依赖运行中的 DSH 进程。
