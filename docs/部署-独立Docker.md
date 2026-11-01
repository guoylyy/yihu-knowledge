---
title: 独立 Docker 部署与升级（不会丢目录）
category: 部署
order: 12
summary: 用 compose 声明笔记目录与数据目录；升级只换镜像，挂载与索引不受影响
---

# 独立 Docker 部署与升级

## 为什么用 compose，不用 `docker run`

`docker run` 的挂载写在命令里，**下次换个命令重建容器，挂载就没了**——这就是"更新完目录又空了"的来源。
`docker-compose.yml` 把挂载写进文件，升级只换镜像，挂载与数据原样保留。

## 一次性配置

仓库根目录建 `.env`（不要提交）：

```ini
KB_BASE_URL=https://kb.example.com      # 必填，对外访问地址
KB_LIBRARY=/Users/你/笔记目录            # 宿主机上的真实路径（只读挂进容器）
KB_DATA=/Users/你/kb-data                # 索引/设置/分享/预览缓存，务必单独一个目录
KB_PORT=3030
KB_BIND=127.0.0.1                        # 由反向代理终止 HTTPS
KB_WITH_OFFICE=1                         # 1 = 完整版镜像，PPT/Word 看原版排版
```

启动：

```bash
docker compose up -d --build
curl -s http://127.0.0.1:3030/health      # {"status":"ok","version":"…","mode":"full"}
```

启动后打开网页 → 设置 → 知识库目录 → 浏览：容器里的 `/library` 会带「只读」标记列出来，点进去选子目录即可，**不用手打路径**。

## 升级（不丢挂载、不丢索引）

```bash
cd yihu-knowledge
git pull                                  # 或 git fetch && git checkout v1.5.3
docker compose up -d --build              # 只重建镜像与容器，挂载/数据沿用 compose 里的声明
curl -s http://127.0.0.1:3030/health      # 确认新版本号
```

`/data` 里放着 `kb.sqlite`（索引）、`config.json`（设置）、`shares`（分享）、`previews`（转换缓存）。
只要 `KB_DATA` 不变，升级后打开就能用，不需要重新索引。

**回滚**：镜像 tag 换成上一个版本再 `docker compose up -d`：

```bash
docker images | grep yihu-knowledge            # 找到上一个 tag，例如 1.5.2-full
docker tag yihu-knowledge:1.5.2-full yihu-knowledge:latest && docker compose up -d
```

## 换笔记目录

```bash
# 1. 改 .env 里的 KB_LIBRARY
# 2. 重建容器（10 秒不可用）
docker compose up -d
# 3. 网页 → 设置 → 知识库目录 → 选新目录 → 保存并重新索引
```

换目录会**清空旧索引并重建**（旧分享链接失效，符合预期：不能让人拿旧链接看到新库里的同名文件）。

## macOS 的坑

- Docker Desktop 只能挂「文件共享」里允许的路径（默认 `/Users`、`/Volumes`、`/private`、`/tmp`）。放在 iCloud / 坚果云等 File Provider 目录里，容器里可能**看到空目录**——先在容器里 `ls /library` 确认再索引。
- 笔记目录建议 `:ro` 只读挂载，知识库本来不需要写。
- `KB_DATA` 的属主必须是容器运行用户（默认 1000），否则启动时报无法写入。
