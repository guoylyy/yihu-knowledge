# yihu-knowledge 知识库

把一个 Markdown 笔记目录变成手机上能读、能分享、能追溯的私有网站。可以自己部署给一个人用，也可以作为以虎 One 平台的一个应用运行。

打开就能配：不用读 `.env`，浏览器里四步填完，手机上也能操作。

| 阅读页 | 关系图 | 分享页 | AI 面板 |
|---|---|---|---|
| <img src="docs/screenshots/reading-375.png" width="180" alt="手机上的笔记阅读页"> | <img src="docs/screenshots/graph-default-375.png" width="180" alt="双链关系图"> | <img src="docs/screenshots/share-375.png" width="180" alt="分享页"> | <img src="docs/screenshots/ai-open-375.png" width="180" alt="AI 总结面板"> |

## 三个卖点

- **手机可读**：服务端渲染，手机优先。支持 Obsidian 风格的双链、嵌入、Callout，内置 PDF 阅读器（手机上也能翻页、缩放，PDF 正文进搜索），也能预览图片、视频、CSV，PPT/Word 可看原版排版或文字。
- **可控分享与访问审计**：默认全部私有，分享必须显式创建，可设有效期和访问密码，随时撤销；谁在什么时候看了哪一篇，后台都查得到。
- **双链图谱 + AI 总结**：用 Canvas 画笔记关系；AI 一次只读当前这一篇，疑似含口令或密钥的笔记不会发出去。

## 快速开始（独立部署）

不用改任何配置文件：起服务，打开浏览器，四步填完。

**Docker：**

```bash
git clone https://github.com/guoylyy/yihu-knowledge.git && cd yihu-knowledge
docker build -t yihu-knowledge .
docker run -d --name kb -p 3030:3030 -v "/你的/笔记目录:/data/library:ro" -v kb-data:/data yihu-knowledge
docker logs kb | grep 设置码      # 打开 http://服务器:3030/setup 时要填，见下方「卡住了看这里」
```

向导第一步会列出容器里能选的目录，带 md 文件数和只读/读写标记，点进去选就行。知道路径的话可以展开「高级」手填，填的是**容器内路径**，不是你电脑上的路径。什么都没挂时，页面会给出可复制的 `docker run` 命令。

**不用 Docker（Node 22+）：**

```bash
npm ci
npm start                         # 打开 http://localhost:3030
```

配置写进 `data/config.json`，首次索引完成后跳到登录页，不用重启。

### 卡住了看这里

- **Docker 下目录检测报「目录不存在」**：填的是宿主机路径。向导运行在容器里，只看得见 `-v` 挂进去的目录，`-v /你的/笔记目录:/data/library:ro` 对应要填 `/data/library`。
- **页面要「设置码」**：只有在服务器本机直接打开才免填。从别的设备、反向代理或 Docker 端口映射进来时都要填，它打印在启动日志里（`docker logs kb`）。这样服务暴露在公网时，别人不能抢在你前面配置，也不能用检测接口探测服务器目录。
- **页面提示数据目录写不进去**：Docker 用 `-v kb-data:/data` 这样的命名卷最省事。如果绑定宿主机目录（`-v ./data:/data`），它的属主必须是 UID 1000，否则先 `sudo chown 1000 ./data`。
- **没挂 `/data`**：容器重建后配置和索引都会丢，又回到向导。

### 重新配置

日常修改不用重新配置：`/admin/settings` 可以改知识库目录、站点名、主人名、对外地址、登录方式、口令和 AI 通道，每个分区单独保存，保存后立即生效，不用重启。每项标着来源，来自环境变量的项是只读的，因为环境变量优先，界面改了也不生效。

**更换知识库目录**是破坏性操作：

1. 检查新目录：存在、可读、非空，且不能和数据目录互相包含。
2. 弹窗确认后果：索引重建（当前 N 篇 → 预计 M 篇），**已有分享链接全部失效**。新库没有 Markdown，或文件数比旧库少 90% 以上时，还要额外勾选确认。
3. 把新目录索引到临时库 `reindex.tmp.sqlite`，这期间全站继续读旧库，设置页显示进度。
4. 成功后在一个事务里把索引搬进正式库，再写 `config.json`；任何一步失败，旧配置和旧索引都保持不变。

会话、分享记录和日志和索引放在同一个 `kb.sqlite` 里，换库时都保留。分享记录标记为「换库后失效」，打开链接是 404；即使新库里有同路径的文件也一样，避免旧链接打开另一份内容，换回原目录也不会恢复。改动记录写在 `audit_log` 表（`settings_change`），设置页可以看到，口令和 key 只记「已修改」。

要从头配置：删除 `data/config.json`（Docker 下是 `/data/config.json`）并重启，下次访问回到向导。配置完成后 `/setup` 一律 404。换口令后，旧口令登录的会话全部失效。

### 上线到公网

向导把当时访问用的地址记作对外地址，分享链接用它生成，地址是 `http://` 时登录 cookie 不带 Secure，这样局域网里也能登录。上线前走 HTTPS 反向代理（`KB_TRUST_PROXY=1`），并设 `KB_BASE_URL=https://你的域名`，cookie 就恢复 Secure。完整步骤和「库怎么同步到服务器」见 [docs/DEPLOY-1PANEL.md](docs/DEPLOY-1PANEL.md)。

已有 `.env` 的部署不受影响：`docker compose` 固定设了 `KB_ROOT`，不会进向导。

## 平台部署（以虎 One 应用）

仓库根目录的 `yh-app.json` 是应用清单：`code` 为 `knowledge`，地址是 `<平台地址>/apps/knowledge/`，默认 `AUTH_MODE=sso`，库放在 `/data/library`，数据库放在 `/data/db`。

1. 在平台「管理 → 应用 → 从 Git 安装应用」安装本仓库（或在服务器上 `yh add` + `yh up`）。`YH_CLIENT_ID`、`YH_CLIENT_SECRET`、`YH_WEB_URL`、`YH_API_URL`、`YH_APP_URL` 由平台自动注入。
2. 决定谁能进：看应用的启动日志，白名单为空时会打出设置码。用平台账号登录一次（会看到 403），再打开 `/apps/knowledge/access?token=<设置码>`，在列表里勾上自己保存，就转成正式登录了。之后在 `/access`（后台「访问权限」）勾选其他人，保存后立即生效，不用重启。走向导部署的，在第三步直接勾选。
3. 把笔记同步到宿主机的 `apps/knowledge/data/library/`，在后台点「增量索引」，或等 30 分钟一次的自动扫描。

平台把 `/apps/knowledge/` 前缀剥掉再转发，并通过 `X-Forwarded-Prefix` 告诉应用；页面链接、跳转和 cookie 路径都会带上它，不用额外配置。

SSO 登录走平台的 OAuth2 授权码流程：`/sso/login` 跳平台授权页，平台回调 `/sso/callback`，应用校验 state、用 client 凭证换用户信息、再校验白名单，最后建立自己的会话。外部部署的应用要在平台登记回调地址 `<YH_APP_URL>/sso/callback`。

## 权限模型

一个知识库通常只属于一个人，里面没有「张三能看这个目录、李四能看那个目录」的需求，所以这里没有用户、角色和目录权限：**进得来的人看到的都一样，都是站点主人**。

| 部署方式 | `AUTH_MODE` | 怎么进 |
|---|---|---|
| 独立部署 | `password`（默认） | 一个口令。一个人部署一个人用，简单最要紧 |
| 平台部署 | `sso` | 平台账号，且在白名单里 |
| 过渡或兜底 | `both` | 两个入口都开。口令是给站点主人的，不受白名单限制 |

平台只回答「他是谁」，「他能不能进」由白名单决定。平台上的同事默认都进不来：

- 在 `/access` 从平台用户列表里勾选。最近被拒绝的登录也列在那里，点一下「加入白名单」就放行。保存写进 `config.json`，立即生效。
- 同时保存 `allowedUsers`（username）和 `allowedUserIds`（id），任一匹配即放行，平台改用户名不会失效。匹配是精确的，大小写敏感。
- 白名单为空时一律拒绝，不存在「没配置就全放行」。这时可以用启动日志里的设置码打开 `/access?token=<设置码>`：得到一个 30 分钟的临时会话，只能访问这一页，保存后结束。设置码每次启动都换，白名单有人之后不再生效，连错 5 次锁 15 分钟。
- 把人移出白名单后，他已有的会话在下一次请求时就失效。平台登录的人不能把自己移出去。
- **高级用法**：设了 `KB_ALLOWED_USERS` 后整份白名单都以它为准（填 username 或 id），`/access` 变成只读，`config.json` 里的名单不再生效，改动要重启。自动化部署时才需要；去掉它并重启就回到界面管理。
- 平台会话 8 小时过期，之后再走一次授权；所以平台上停用的账号最多再放行 8 小时。
- 每次登录和被拒绝都记在后台「访问记录」里。

要给别人看某几篇，用分享，不要加白名单。

## 配置

大多数人用向导就够了。需要脚本化部署时用环境变量，完整示例见 [.env.example](.env.example)。

**未配置的判定**：`data/config.json` 不存在，且 `KB_ROOT` 环境变量为空。此时所有页面都跳到 `/setup`。

**优先级**：环境变量 > `config.json` > 默认值，逐项判断，空字符串算没设。`/admin` 的「配置来源」列出每一项的来源。

**`config.json` 里的敏感内容**：口令只存 argon2 hash。API key 是明文，因为调用模型时要原样发出去，存 hash 没有用；文件权限 600，只有运行用户可读。这个取舍和把 key 放进 `.env` 一样，`data/` 目录本来就等同于笔记全文，备份时同样对待。不想让 key 落盘就用 `AI_API_KEY` 环境变量，向导里选「先关掉」。

### 登录

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_MODE` | `password` | `password` / `sso` / `both`，其他值启动失败 |
| `KB_PASSWORD` | 向导填写 | 环境变量部署时 `password`、`both` 必填，缺了启动失败。至少 8 位（向导要求至少 10 位），或直接填 argon2 hash。`sso` 时不生效 |
| `KB_ALLOWED_USERS` | 空 | 高级用法，自动化部署时用。平时在 `/access` 勾选；一旦设了，界面只读。空 = 用界面管理的名单 |

### 站点

| 变量 | 默认 | 说明 |
|---|---|---|
| `KB_ROOT` | 向导填写 | 知识库根目录，只读。设了它就不进向导 |
| `KB_ROOTS` | `/library,/data/library,/vaults,/host,/mnt,/media` | 目录浏览器允许看的根，逗号分隔，也可写进 `config.json`。范围外的路径和指向范围外的符号链接一律 403。手打路径不受它限制 |
| `KB_DATA_DIR` | `./data` | 数据目录，放数据库和 `config.json`，里面有库内全文，权限 700，不要外传。Docker 镜像默认 `/data` |
| `KB_BASE_URL` | 向导时的访问地址，否则 `http://localhost:<端口>` | 分享链接前缀。`sso`、`both` 下缺省取 `YH_APP_URL` |
| `KB_OWNER_NAME` | 知识库主人 | 分享页署名 |
| `KB_IN_DOCKER` | 空 | 设为 `1` 时向导按容器环境提示。镜像已内置，自动识别不到时才用 |
| `KB_DENY_GLOBS` | 空 | 追加 deny 规则，`!规则` 移除默认规则 |
| `KB_TRUST_PROXY` | `0` | 反向代理层数，必须和实际一致，见下方安全边界 |
| `KB_ZIP_MAX_MB` | `1024` | 目录打包下载上限 |
| `KB_PREVIEW_MAX_MB` | `200` | 超过这个体积的 PDF / Office 不在线渲染，只给下载 |
| `KB_PDF_MAX_PAGES` | `50` | 每份 PDF 进搜索索引的页数上限 |
| `KB_PREVIEW_CACHE_MB` | `2048` | Office 转换缓存上限，超过时清掉最久没打开的 |
| `KB_CONVERT_TIMEOUT_S` | `120` | 单个文件转换超时，超时退回文字预览 |
| `KB_SOFFICE` | 自动探测 | LibreOffice 的 `soffice` 路径。配错就当没装，不会回退到别的路径 |
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

## PDF 与 Office 预览

**PDF**：内置 PDF.js（在 `public/vendor/pdfjs/`，不走 CDN，内网可用），手机和平板都能连续阅读，左右滑动翻页；双指捏合或双击放大（1~5 倍，松手后按新比例重绘），放大后单指平移，桌面用 `Ctrl/⌘ + 滚轮` 或 `Ctrl/⌘ + =`、`-`、`0`。只渲染看到的页，大文件按 Range 分段加载。

PDF 正文进搜索，AI 也能读。每份抽前 50 页、最多 2MB 文字，多出来的搜不到，「管理后台 → 索引状态」会写「已截断」。扫描件没有文字层，只能看，页面上有提示；加密的 PDF 只能下载后看。

**PPT / Word**（`pptx`、`ppt`、`docx`、`doc`、`odp`）：装了 LibreOffice 时先转成 PDF 再用同一个阅读器看，版式、图片和中文都保留。第一次打开时先显示文字，转好自动刷新，之后走缓存；转换失败退回文字预览。没装时 `pptx`、`docx` 只显示文字，`ppt`、`doc`、`odp` 只能下载。

LibreOffice 是可选依赖，启动时自动探测，「管理后台」能看到有没有启用。转换缓存放在 `数据目录/previews`，文件改了自动失效。

| 镜像 | 体积 | PDF 阅读器 | PPT / Word |
|---|---|---|---|
| `Dockerfile`（精简版，默认） | 约 450MB | 有 | 只有文字 |
| `Dockerfile.full`（完整版） | 约 1.2GB | 有 | 原版排版 |

```bash
docker build -f Dockerfile.full -t yihu-knowledge:full .
# 或者用 compose：在 .env 里写 KB_WITH_OFFICE=1，再 docker compose up -d --build
```

不用 Docker 时执行 `brew install --cask libreoffice`（macOS）或 `apt install libreoffice-impress libreoffice-writer fonts-noto-cjk`（Linux），重启服务即可。

完整版建议给 1GB 内存。实测 512MB 能转普通的 PPT（10MB 以内），28MB 和 92MB 的 PPT 会把 soffice 撑爆，这时退回文字预览，服务本身不受影响。

## 安全边界

- **默认私有**：除了登录和分享链接，其余页面都要登录。
- **分享是显式的**：只有你创建的链接才对外，token 为 32 字节随机值，可设有效期、密码，可撤销，访问都有记录。
- **敏感内容三层拦截**：
  1. 路径 deny：`.env`、`*.pem`、`*密码*`、`*token*` 等命中默认规则的文件不进索引，登录后也打不开。
  2. 内容打标：正文疑似含口令或密钥的笔记会标记为敏感，不进目录分享，单篇分享要二次确认。
  3. 发送前复查：AI 调用前按标记和当前正文再扫一遍，命中就不发，索引落后于文件时也拦得住。
- **AI 只发当前一篇**：总结和追问都只带这一篇（或选中的片段），内嵌图片会被剥掉。相同内容命中本地缓存，不重复发送。模型回答按不可信内容渲染，不开 HTML 和图片。`claude-cli` 通道以 `--safe-mode --tools ""` 运行，模型没有任何工具，子进程也拿不到 `KB_*`、`AI_*`、`YH_*` 环境变量。
- **`KB_TRUST_PROXY` 要等于实际代理层数**：设大了，客户端能伪造 IP 绕过登录锁定；设小了，所有人共用一个 IP，一次爆破会把主人也锁在外面。
- **`data/` 等同于笔记本身**：里面有全文索引和 `config.json`，备份和迁移时按敏感数据对待。库目录和数据目录不能互相包含，否则配置文件会被当成笔记索引，向导和设置页都会拒绝。
- **未配置的实例不要长期暴露**：向导期间任何人都能打开 `/setup`，但提交、目录检测和平台用户列表要么来自本机，要么带启动日志里的设置码。配置完成后这组接口整体消失。

## 已知限制

- 精简版镜像里 Office 文件只有文本预览，老格式 `.doc` / `.ppt` 不支持预览（完整版可以，见[上面](#pdf-与-office-预览)）。
- PDF 阅读器不能选中文字，也不能跳到搜索命中的位置。
- 进来的人都能打开 `/access` 改白名单，没有单独的管理员角色。
- 向导只运行一次。之后改配置用 `/admin/settings`；deny 规则仍然只能用 `KB_DENY_GLOBS`，改完要重启。
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
npm run index        # 只跑一次索引（需要 KB_ROOT 或 config.json）
npm run demo         # 生成示例库
npm run screenshots  # 重新生成截图（需要本机 Chrome）
npm run screenshots:setup  # 配置向导截图，顺带在真浏览器里走一遍完整流程
```

## License

[MIT](LICENSE)

## English TL;DR

A self-hosted, mobile-first reader for a folder of Markdown notes: Obsidian-style wiki links, a link graph, controlled sharing with access logs, and per-note AI summaries.

- **Standalone**: run `npm start` or the Docker image and open `/setup`. A four-step wizard writes `data/config.json` (mode 600) and runs the first index. Inside Docker, pick a mounted directory in the browser (or enter its container path, e.g. `/data/library`, under Advanced); unless you are on the server itself, the wizard asks for the setup code printed in the startup log. Afterwards, `/admin/settings` edits the library path, site info, sign-in mode, password and AI channel without a restart; changing the library builds a temporary index first, keeps serving the old one until the swap, and invalidates existing share links. Delete `config.json` and restart to reconfigure from scratch. Environment variables override `config.json`, and `docker compose` deployments that set `KB_ROOT` skip the wizard.
- **On Yihu One**: `AUTH_MODE=sso`. Platform login plus an explicit allowlist, picked from the platform's user list at `/access` and effective immediately. An empty list denies everyone; the setup code in the startup log opens `/access?token=<code>` to add the first member. `KB_ALLOWED_USERS` (usernames or user ids) is for automated deployments: when set it overrides the UI, which turns read-only. `AUTH_MODE=both` enables both entry points.
- **AI**: uses the platform model when `YH_CLIENT_ID` and `YH_CLIENT_SECRET` are set, otherwise any OpenAI-compatible API, the local `claude` CLI, or off. `AI_PROVIDER` overrides the choice. Only the current note is sent, and notes that look like they contain secrets are never sent.
- **Limits**: single library per instance, no per-user permissions, the allowlist is edited by hand, Office files get text-only previews unless LibreOffice is installed (`Dockerfile.full`, about 1.2GB, versus about 450MB for the default image).
- **PDF**: a bundled PDF.js reader (works offline, on phones too), with PDF text indexed for search and AI.

MIT licensed.
