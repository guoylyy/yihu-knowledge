# yihu-knowledge 知识库

把一个 Markdown 笔记目录变成手机上能读、能分享、能追溯的私有网站。可以自己部署给一个人用，也可以作为以虎 One 平台的一个应用运行。

| 阅读页 | 关系图 | 分享页 | AI 面板 |
|---|---|---|---|
| <img src="docs/screenshots/reading-375.png" width="180" alt="手机上的笔记阅读页"> | <img src="docs/screenshots/graph-default-375.png" width="180" alt="双链关系图"> | <img src="docs/screenshots/share-375.png" width="180" alt="分享页"> | <img src="docs/screenshots/ai-open-375.png" width="180" alt="AI 总结面板"> |

## 三个卖点

- **手机可读**：服务端渲染，手机优先。支持 Obsidian 风格的双链、嵌入、Callout，也能预览图片、PDF、视频、CSV 和 Office 文本。
- **可控分享与访问审计**：默认全部私有，分享必须显式创建，可设有效期和访问密码，随时撤销；谁在什么时候看了哪一篇，后台都查得到。
- **双链图谱 + AI 总结**：用 Canvas 画笔记关系；AI 一次只读当前这一篇，疑似含口令或密钥的笔记不会发出去。

## 快速开始（独立部署）

需要 Docker 和一个 HTTPS 反向代理。三条命令：

```bash
git clone https://github.com/guoylyy/yihu-knowledge.git && cd yihu-knowledge
cp .env.example .env                                  # 编辑 .env，填 KB_PASSWORD 和 KB_BASE_URL
mkdir -p data && ln -s /你的笔记目录 library && docker compose up -d --build
```

然后把 `127.0.0.1:3030` 反向代理出去并启用 HTTPS。完整步骤和「库怎么同步到服务器」见 [docs/DEPLOY-1PANEL.md](docs/DEPLOY-1PANEL.md)。

不用 Docker 时需要 Node 22+：

```bash
npm ci
cp .env.example .env                  # 同样填好口令
set -a; . ./.env; set +a
KB_ROOT=/你的笔记目录 KB_COOKIE_INSECURE=1 npm start    # http://localhost:3030
```

`KB_COOKIE_INSECURE=1` 只用于本机或局域网的 http 调试，上线不要加。

## 平台部署（以虎 One 应用）

仓库根目录的 `yh-app.json` 是应用清单：`code` 为 `knowledge`，地址是 `<平台地址>/apps/knowledge/`，默认 `AUTH_MODE=sso`，库放在 `/data/library`，数据库放在 `/data/db`。

1. 在平台「管理 → 应用 → 从 Git 安装应用」安装本仓库（或在服务器上 `yh add` + `yh up`）。`YH_CLIENT_ID`、`YH_CLIENT_SECRET`、`YH_WEB_URL`、`YH_API_URL`、`YH_APP_URL` 由平台自动注入。
2. 在服务器的 `apps/knowledge/.env` 写上白名单，然后重启应用：

   ```bash
   KB_ALLOWED_USERS=你的平台账号
   ```

3. 把笔记同步到宿主机的 `apps/knowledge/data/library/`，在后台点「增量索引」，或等 30 分钟一次的自动扫描。

平台把 `/apps/knowledge/` 前缀剥掉再转发，并通过 `X-Forwarded-Prefix` 告诉应用；页面链接、跳转和 cookie 路径都会带上它，不用额外配置。

SSO 登录走平台的 OAuth2 授权码流程：`/sso/login` 跳平台授权页，平台回调 `/sso/callback`，应用校验 state、用 client 凭证换用户信息、再校验白名单，最后建立自己的会话。外部部署的应用要在平台登记回调地址 `<YH_APP_URL>/sso/callback`。

## 权限模型

一个知识库通常只属于一个人，里面没有「张三能看这个目录、李四能看那个目录」的需求，所以这里没有用户、角色和目录权限：**进得来的人看到的都一样，都是站点主人**。

| 部署方式 | `AUTH_MODE` | 怎么进 |
|---|---|---|
| 独立部署 | `password`（默认） | 一个口令。一个人部署一个人用，简单最要紧 |
| 平台部署 | `sso` | 平台账号，且在 `KB_ALLOWED_USERS` 里 |
| 过渡或兜底 | `both` | 两个入口都开。口令是给站点主人的，不受白名单限制 |

平台只回答「他是谁」，「他能不能进」由白名单决定。平台上的同事默认都进不来：

- 白名单按平台 `username` 或用户 `id` 精确匹配，大小写敏感。只用钉钉等方式登录的人没有 `username`，要填 `id`；被拒绝的页面上会显示这个 id。
- 白名单为空时一律拒绝，不存在「没配置就全放行」。
- 把人移出白名单并重启后，他已有的会话在下一次请求时就失效。
- 平台会话 8 小时过期，之后再走一次授权；所以平台上停用的账号最多再放行 8 小时。
- 每次登录和被拒绝都记在后台「访问记录」里。

要给别人看某几篇，用分享，不要加白名单。

## 配置

完整示例见 [.env.example](.env.example)。

### 登录

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_MODE` | `password` | `password` / `sso` / `both`，其他值启动失败 |
| `KB_PASSWORD` | 无 | `password`、`both` 必填，缺了启动失败。至少 8 位，或直接填 argon2 hash。`sso` 时不生效 |
| `KB_ALLOWED_USERS` | 空 | 平台 username 或用户 id，逗号分隔。空 = 全部拒绝 |

### 站点

| 变量 | 默认 | 说明 |
|---|---|---|
| `KB_ROOT` | 必填 | 知识库根目录，只读。Docker 镜像默认 `/library` |
| `KB_DATA_DIR` | `./data` | 数据库目录，里面有库内全文，权限 700，不要外传。Docker 镜像默认 `/data` |
| `KB_BASE_URL` | `http://localhost:<端口>` | 分享链接前缀。`sso`、`both` 下缺省取 `YH_APP_URL` |
| `KB_OWNER_NAME` | 知识库主人 | 分享页署名 |
| `KB_DENY_GLOBS` | 空 | 追加 deny 规则，`!规则` 移除默认规则 |
| `KB_TRUST_PROXY` | `0` | 反向代理层数，必须和实际一致，见下方安全边界 |
| `KB_ZIP_MAX_MB` | `1024` | 目录打包下载上限 |
| `KB_COOKIE_INSECURE` | 空 | 设为 `1` 时 cookie 不带 Secure，只用于 http 调试 |
| `PORT` | `3030` | 监听端口 |

### 以虎 One

平台托管时全部自动注入。这些变量不影响 `AUTH_MODE=password` 的登录。

| 变量 | 说明 |
|---|---|
| `YH_CLIENT_ID` / `YH_CLIENT_SECRET` | 应用凭证。缺一个时，平台登录入口禁用，登录页说明原因 |
| `YH_WEB_URL` | 平台访问地址，浏览器跳转用 |
| `YH_API_URL` | 平台接口地址，服务端换 token、调模型用 |
| `YH_APP_URL` | 本应用对外地址，回调 = 它 + `/sso/callback`。缺省取 `KB_BASE_URL` |
| `YH_BASE_PATH` | 挂载路径，只在拼「退出平台登录」地址时兜底 |

### AI

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_PROVIDER` | 自动 | `platform` / `openai` / `claude-cli` / `off`，填了就强制使用 |
| `AI_PLATFORM_MODEL` | 平台默认 | platform 通道的模型名，如 `deepseek-flash` |
| `AI_BASE_URL` | 空 | OpenAI 兼容接口地址 |
| `AI_API_KEY` | 空 | 接口密钥 |
| `AI_MODEL` | 空 | openai 通道的模型名 |
| `AI_CLI_MODEL` | 空 | claude-cli 通道的模型，留空用 CLI 默认 |
| `AI_MAX_CHARS` | `40000` | 单篇发给模型的字数上限，超出截断并在界面标注 |

`AI_PROVIDER` 留空时按这个顺序选：有 `YH_CLIENT_ID` + `YH_CLIENT_SECRET` → `platform`；有 `AI_API_KEY` → `openai`；本机有 `claude` 命令行 → `claude-cli`；都没有 → `off`。当前通道显示在 `/admin`。

这个选择和 `AUTH_MODE` 无关：环境里有 `YH_*` 时，即使是口令登录，笔记也会发给平台模型。不想这样就设 `AI_PROVIDER`。

## 安全边界

- **默认私有**：除了登录和分享链接，其余页面都要登录。
- **分享是显式的**：只有你创建的链接才对外，token 为 32 字节随机值，可设有效期、密码，可撤销，访问都有记录。
- **敏感内容三层拦截**：
  1. 路径 deny：`.env`、`*.pem`、`*密码*`、`*token*` 等命中默认规则的文件不进索引，登录后也打不开。
  2. 内容打标：正文疑似含口令或密钥的笔记会标记为敏感，不进目录分享，单篇分享要二次确认。
  3. 发送前复查：AI 调用前按标记和当前正文再扫一遍，命中就不发，索引落后于文件时也拦得住。
- **AI 只发当前一篇**：总结和追问都只带这一篇（或选中的片段），内嵌图片会被剥掉。相同内容命中本地缓存，不重复发送。模型回答按不可信内容渲染，不开 HTML 和图片。`claude-cli` 通道以 `--safe-mode --tools ""` 运行，模型没有任何工具，子进程也拿不到 `KB_*`、`AI_*`、`YH_*` 环境变量。
- **`KB_TRUST_PROXY` 要等于实际代理层数**：设大了，客户端能伪造 IP 绕过登录锁定；设小了，所有人共用一个 IP，一次爆破会把主人也锁在外面。
- **`data/` 等同于笔记本身**：里面有全文索引，备份和迁移时按敏感数据对待。

## 已知限制

- Office 文件只有文本预览，不保留版式；老格式 `.doc` / `.ppt` 不支持预览。
- SSO 白名单要手工维护，改完要重启，后台不能改。
- 没有多租户：一个实例一个库，进来的人权限完全相同。
- 只读：应用不修改笔记，编辑仍在你自己的工具里做。

## 更多说明

### AI 总结与追问

阅读页点「AI 总结」。相同正文、相同问题命中 `ai_cache`，正文一变缓存自然失效。通道、模型、最近调用和命中率见 `/admin`。反向代理的读超时要大于 90 秒（AI 调用上限），否则慢请求会被代理提前掐断。

### 关系图

`/graph` 显示笔记间的双链，默认只看有连接的笔记。点节点看详情，双击或长按以它为中心看 2 跳邻域。

- **边**：`[[ ]]` 和 `![[ ]]`，同一对笔记只算一条，自己链自己不算。`[文字](路径.md)` 不画成边，但计入「被引用」。口径在 `src/graph.js` 的 `EDGE_KINDS`。
- **布局**：`public/graph-core.js` 是自写的 Barnes-Hut 力导向，无依赖、无随机数，同样的数据每次形状相同。

### 开发

```bash
npm test             # 全部测试
npm run index        # 只跑一次索引（需要 KB_ROOT）
npm run demo         # 生成示例库
npm run screenshots  # 重新生成截图（需要本机 Chrome）
```

## License

[MIT](LICENSE)

## English TL;DR

A self-hosted, mobile-first reader for a folder of Markdown notes: Obsidian-style wiki links, a link graph, controlled sharing with access logs, and per-note AI summaries.

- **Standalone**: `AUTH_MODE=password` (default). One password, one owner. Copy `.env.example` to `.env`, set `KB_PASSWORD` and `KB_BASE_URL`, then `docker compose up -d --build` behind an HTTPS reverse proxy.
- **On Yihu One**: `AUTH_MODE=sso`. Platform login plus an explicit allowlist, `KB_ALLOWED_USERS` (usernames or user ids). An empty list denies everyone. `AUTH_MODE=both` enables both entry points.
- **AI**: uses the platform model when `YH_CLIENT_ID` and `YH_CLIENT_SECRET` are set, otherwise any OpenAI-compatible API, the local `claude` CLI, or off. `AI_PROVIDER` overrides the choice. Only the current note is sent, and notes that look like they contain secrets are never sent.
- **Limits**: single library per instance, no per-user permissions, the allowlist is edited by hand, Office files get text-only previews.

MIT licensed.
