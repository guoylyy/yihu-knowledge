# 在个人服务器上用 1Panel / Docker Compose 部署

这份文档面向「一台自己的服务器，一个人用」，也就是 `AUTH_MODE=password`。平台部署见 [README](../README.md#平台部署以虎-one-应用)。

这里用 `docker compose` 和 `.env` 配置，不经过网页向导（compose 固定设了 `KB_ROOT`）。想用向导见 [README 的快速开始](../README.md#快速开始独立部署)。

## 准备

- 一台装好 Docker 和 1Panel 的服务器
- 一个解析到这台服务器的域名，比如 `kb.example.com`
- 笔记目录已经或即将同步到服务器（见下文「库怎么同步到服务器」）

## 第一步：放代码、写配置

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/guoylyy/yihu-knowledge.git
cd yihu-knowledge
cp .env.example .env
```

编辑 `.env`，至少改这几项：

| 变量 | 填什么 |
|---|---|
| `KB_PASSWORD` | 登录口令，至少 8 位，用一个长的随机串 |
| `KB_BASE_URL` | `https://kb.example.com`，分享链接用它生成 |
| `KB_TRUST_PROXY` | 只有 1Panel 的 OpenResty 一层代理时填 `1`；前面还有 CDN 时要加一 |
| `KB_UID` / `KB_GID` | 运行容器的用户，用 `id` 命令查，须能写 `./data` |

```bash
chmod 600 .env
mkdir -p data
```

## 第二步：准备库目录

`./library` 是笔记目录，以只读方式挂进容器。可以直接把笔记放进去，也可以软链接到别处：

```bash
ln -s /srv/notes library
```

## 第三步：启动

在 1Panel「容器 → 编排」里选 `/opt/yihu-knowledge/docker-compose.yml` 创建编排，或者直接执行：

```bash
docker compose up -d --build
```

容器只绑 `127.0.0.1:3030`，不直接暴露公网。启动后第一次索引的进度在容器日志里。

检查一下：

```bash
curl -s http://127.0.0.1:3030/health    # 应该输出 ok
```

## 第四步：反向代理和 HTTPS

在 1Panel「网站」里创建反向代理站点：

- 域名：`kb.example.com`
- 代理地址：`http://127.0.0.1:3030`
- 申请证书并开启 HTTPS
- 把代理的读超时调到 **120 秒以上**。AI 调用最长 90 秒，超时太短时慢请求会被代理掐断

HTTPS 是必须的：登录 cookie 带 Secure，http 下浏览器不保存，表现为「登录后又跳回登录页」。

## 第五步：确认 AI 通道

打开 `https://kb.example.com/admin`，看「AI 状态」。独立部署通常用自己的 OpenAI 兼容接口，在 `.env` 里填 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，然后 `docker compose up -d` 重建容器。

不需要 AI 时设 `AI_PROVIDER=off`。Docker 镜像里没有 `claude` 命令行，这个通道只在非容器部署时可用。

## 库怎么同步到服务器

应用只读 `./library`，同步方式由你决定。三种都可行，按自己的情况选一种。

索引每 30 分钟增量扫描一次，也可以在后台点「增量索引」立刻更新。

### 方案一：rsync 定时推送（推荐）

笔记在你自己的电脑上，定时推到服务器。文件直接落在服务器磁盘，读取最快，最不容易出问题。

在你的电脑上（macOS 用 launchd，Linux 用 cron）加定时任务：

```bash
# 每 10 分钟推一次
*/10 * * * * rsync -az --delete --exclude '.obsidian/' --exclude '.git/' ~/notes/ user@server:/srv/notes/
```

`--delete` 会让服务器和本地完全一致。第一次执行前先加 `--dry-run` 看看会删什么。本地目录没挂上或为空时跑 `--delete` 会清空服务器的库，所以源路径结尾的 `/` 不能漏，网盘目录作为源时先确认它已同步完。

敏感文件不想上服务器的话，在这里再 `--exclude` 一层，比只靠应用内的 deny 规则更稳。

### 方案二：git 定时拉取

笔记本来就在一个私有 git 仓库里（比如用 Obsidian Git 插件）。好处是自带历史，同步失败时不会留下半个文件。

服务器上：

```bash
git clone git@github.com:you/notes.git /srv/notes
crontab -e
# 每 10 分钟拉一次
*/10 * * * * cd /srv/notes && git pull --ff-only --quiet
```

用只读的 deploy key，不要用个人账号密钥。注意仓库里的二进制附件会让克隆越来越大，附件多时选方案一。

### 方案三：rclone 挂载网盘

笔记已经在网盘（S3、WebDAV、Google Drive 等）里，服务器不想存一份。好处是不占服务器磁盘，代价是读取慢，首次全量索引要把所有文件读一遍。

```bash
rclone mount remote:notes /srv/notes \
  --read-only --allow-other --dir-cache-time 5m --vfs-cache-mode minimal --daemon
```

要注意三件事：

- `--allow-other` 需要在 `/etc/fuse.conf` 里打开 `user_allow_other`，否则容器读不到。
- rclone 必须在容器之前挂上。容器启动时目录是空的，索引会把库当成空库，已有索引被清掉，要等挂载恢复后重新索引。建议用 systemd 单元管理 rclone，并让 Docker 依赖它。
- 挂载中断后再恢复时，已运行的容器可能仍然看到旧的空目录，要 `docker compose restart`。

## 日常维护

| 操作 | 怎么做 |
|---|---|
| 升级 | `git pull && docker compose up -d --build`，`data/` 里的表结构会自动升级 |
| 改口令 | 改 `.env` 后 `docker compose up -d`，口令登录的旧会话全部失效 |
| 备份 | 备份 `./data` 和 `.env`。`data/` 里有全文索引，和笔记同等敏感 |
| 看日志 | `docker compose logs -f` |
| 查配置来源 | 后台 `/admin` 的「配置来源」，显示每一项来自环境变量还是配置文件 |
| 忘记口令 | 改 `.env` 里的 `KB_PASSWORD` 即可，没有别的恢复流程 |

## 常见问题

**登录后又跳回登录页。** 站点没走 HTTPS，或反向代理没有把 HTTPS 传到浏览器。调试时才用 `KB_COOKIE_INSECURE=1`。

**输错几次口令后所有人都进不去。** `KB_TRUST_PROXY` 设小了，所有访问者被算成同一个 IP。

**AI 总结总是超时。** 检查代理读超时是否大于 90 秒。

**容器起不来，日志说写不了数据库。** `KB_UID` / `KB_GID` 和 `./data` 的属主不一致。
