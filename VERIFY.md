# VERIFY.md — 真机验证清单（dsh 0.1.5-rc.2，macOS）

验证日期：2026-09-20（t4）。执行环境：`dsh 0.1.5-rc.2`，node v24.20.0（fnm），
web profile（`@deepseek-ai/dsh-web-all` 组合树 + 用户 cordis.patch.yml）。

**沙箱约束（重要）**：本轮验证在成员沙箱内进行，不能写 `~/.config/dsh`。
做法：把 `~/.config/dsh` 骨架复制到临时 `DSH_HOME`
（`.tmp/t4-dshhome`，profiles/web 的 node_modules 符号链接回真目录），
通过 `dsh --patch <overlay>` 挂载三个插件 —— **用户真实 profile 配置零改动、零残留**
（overlay 是只读传入的额外层；测试 boot 用独立端口 3907，已停止）。

## ① jev-mcp 挂入 web profile（- insert:）

Overlay 片段（`- insert:` 形式，stdio command 用 fnm 绝对路径）：

```yaml
- insert:
    - id: dsh-jev-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jev
        transport: stdio
        command: /Users/bytedance/.local/share/fnm/aliases/default/bin/node
        args:
          - <repo>/packages/jev-mcp/dist/index.js
        env:
          JEV_API_KEY: t4-fake-key-transport-test   # 故意用假 key
        toolCallTimeoutMs: 10000
        failOnStartupError: false
```

结果：

| 检查 | 结果 |
| --- | --- |
| `--dump-config` 组合树含 `dsh-jev-mcp` 条目 | ✅（`grep dsh-jev-mcp` 命中，exit 0） |
| dump 输出头部 `entry not found` 警告 | ✅ 无 |
| 真实 boot（`DSH_HOME=<tmp> dsh --profile web --patch …`） | ✅ web server 正常起在 127.0.0.1:3907 并保持运行（timeout 人工结束），loader 0 条 failed to apply/import |
| MCP 子进程 spawn | ✅ `pgrep -f jev-mcp/dist/index.js` 命中（fnm node 绝对路径启动），存活 >25s 无重启 |
| 传输层 initialize / tools-list（假 key） | ✅ 直连 stdio 冒烟：initialize 返回 serverInfo `dsh-jev-mcp 0.1.0`；tools/list 返回 `jev_choice` / `jev_score` / `jev_noul` 三个 schema |
| 假 key 下真实 tools/call | ✅ 应用层优雅降级：返回 `jev: degraded (HTTP 403)` + fallback 值，工具调用本身不报错 |

**TYPESAFE_API_KEY / JEV_API_KEY 注入问题（如实记录）**：
与 `ZAI_CODING_CN_API_KEY` 同款坑——shell 导出的 env 只覆盖终端拉起的 dsh；
GUI/launchd（com.dsh.doctor）域读不到，届时 jev 调用会应用层降级（403/401），
**不会崩**（failOnStartupError: false + 客户端降级语义兜底）。正式接入时需要在
env 中显式注入（overlay `env:` 字段或 launchctl setenv 方案，后者已有争议，待定）。
本轮验证用的是 overlay 内联假 key。

## ② router / effort 插件 import 不炸（boot 探测法）

Overlay 用 `- insert:` + **`name:` 指向本地 dist 绝对路径**：

```yaml
- insert:
    - id: dsh-jev-router
      name: <repo>/packages/router/dist/index.js   # 注意是 name，不是 path！
      config: { mode: shadow }
    - id: jev-effort
      name: <repo>/packages/effort/lib/index.js
      config: { enabled: true }
```

| 检查 | 结果 |
| --- | --- |
| `--dump-config` 组合树含两条目、无 not found | ✅ |
| 真实 boot，loader 无 failed to import/apply | ✅（整树 0 失败；web server 正常监听） |
| router/effort 的 jev 调用失败不炸 boot | ✅（假 key + 无网络权限下 boot 正常；shadow/静默降级语义生效） |

**⚠️ 踩坑（已写进 overlay 注释与本文件）**：本地文件插件必须把绝对路径写在
`name:` 字段——dsh-app-boot 的 `anchorInsertedPluginNames` 只转换 `name:` 里的
文件系统路径为 `file://` URL；写成 `path:` 会被 loader 忽略，
import(undefined) 报 `Cannot read properties of undefined (reading 'startsWith')`。
router README 的示例需要改（`path:` → `name:`）。

**boot 时另需注意**：`- id: webserver` 的 config patch 是整体替换，改 port 必须
同时带 `host:`，否则 `$.host missing required value` 整树失败（验证时用
`{host: 127.0.0.1, port: 3907}` 绕开用户在跑的 3080 实例）。

**未覆盖（需真实会话才能验证，留给后续）**：router 的 shadow 日志行
（`[dsh-jev-router] … shadow …`）与 effort 的 `[dsh-jev-effort]` 日志行需要
在 web UI 里发一条真实消息触发 agent/request；本轮沙箱未做浏览器侧操作。
方法：正式接入后在跑着的 web profile stdout 里 `grep dsh-jev-`。

## ③ core 单测全绿

| 包 | 命令 | 结果 |
| --- | --- | --- |
| packages/core | `vitest run` | ✅ 11/11 |
| packages/router | `vitest run` | ✅ 13/13 |
| packages/effort | `vitest run` | ✅ 11/11（另 `node --check` 两文件过） |

工作区合计 35/35。

## 正式接入步骤（对用户真实 profile）

1. 把 overlay 里的 `- insert:` 三段并入 `~/.config/dsh/profiles/web/cordis.patch.yml`
   （源 `.tmpl`，改后 `chezmoi apply`），路径指向 `~/workspace/opensource/dsh-jev`。
2. 先 `dsh --profile web --dump-config | head` 查无 `entry not found`。
3. 重启 web 服务并刷新页面（client bundle 缓存），stdout `grep dsh-jev-` 看
   router/effort 日志。
4. 回滚：删除插入的三段（或整段 `disabled: true`）即可，无其它持久化副作用。
