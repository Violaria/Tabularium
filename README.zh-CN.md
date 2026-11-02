# Tabularium

[English](README.md) · 中文 · [Lingua Latīna](README.la.md)

Tabularium 是一个自托管的 Obsidian 笔记库同步服务器，采用端到端加密，并配有连接它的 Obsidian 插件。笔记在每台设备上加密后才上传；服务器把它们存在 CouchDB 中，无法读取内容。不开放注册：账户由管理员创建。

除同步外，服务器还提供一个网页应用：管理控制台、在浏览器中阅读和编辑笔记的云笔记（在浏览器内解密）、笔记分享页、发送到 Kindle、定时备份，以及可选的 AI 管理员 Tabularius（书记员）。笔记库的所有者可以为单个笔记库开启它。

版本 0.24.5。项目仍在积极开发中，尚未以自己的许可证发布；见下文「许可证」。

## 仓库

这是父仓库。服务器和插件是子模块，各有自己的仓库：

| 路径 | 仓库 | 内容 |
| --- | --- | --- |
| `apps/server` | [Tabularium-Server](https://github.com/Violaria/Tabularium-Server) | Node.js 网关、SQLite 应用库、网页应用、Tabularius |
| `apps/obsidian` | [Tabularium-Obsidian](https://github.com/Violaria/Tabularium-Obsidian) | Obsidian 插件，fork 自 Self-hosted LiveSync；云笔记和服务器所用 LiveSync CLI 的源码也在这里 |
| `packages/custom-sort` | 本仓库 | 来自 Custom File Explorer sorting 的文件列表排序，打包供插件使用 |
| `deploy/` | 本仓库 | Compose 文件，备份、恢复、升级与回退工具，发布包构建 |
| `tests/` | 本仓库 | 跨组件的测试：真实客户端同步、Tabularius 端到端、备份、发布包 |

服务器镜像由两个子模块共同构建，所以构建和测试都在本仓库中进行。

## 构建

需要 Node.js 24.10.0 和 npm 11.6.1（见 `.nvmrc` 和 `package.json` 的 `engines`）；服务器和大部分测试需要 Docker 与 Compose 2.24 或更新版本。

```bash
git clone --recurse-submodules git@github.com:Violaria/Tabularium.git
cd Tabularium
npm run bootstrap   # 安装工作区、排序包和插件的依赖
npm run build       # 服务器、排序包、插件 main.js、CLI
npm run check       # 全部类型检查与 lint
```

测试：

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run test:server` | 网关与 API，连接真实的 CouchDB |
| `npm run test:server:browser` | 无头浏览器中的管理控制台 |
| `npm run test:unit` | 插件单元测试 |
| `npm run test:tabularius` | Tabularius 端到端，模型提供商为脚本化替身 |
| `npm run test:backup` | 备份、恢复与定时备份 |
| `npm run test:gateway` | 真实客户端的同步回归（需要桌面版 Obsidian） |
| `npm run test:release` | 用构建好的发布包做一次全新安装 |

## 本地运行

```bash
cp deploy/local/.env.example deploy/local/.env
# 设置三个密码；管理员初始密码至少 12 个字符
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
curl http://127.0.0.1:3000/health/ready
```

打开 `http://127.0.0.1:3000/`，以 `admin` 登录并修改密码。运行设置（发信、分享、AI 提供商、备份）都在网页上配置；`.env` 只放容器启动前就需要的内容。

## 发布与安装

`npm run release` 生成 `release/<版本>/`：服务器镜像的 tar 文件、插件的 zip、部署目录（`compose.yaml`、`couchdb.ini`、`.env.example`、`backup/`）、第三方许可证和校验和。在目标主机上：

```bash
cd release/<版本>
sha256sum -c SHA256SUMS
docker load -i tabularium-server-<版本>.tar
docker tag tabularium-server:<版本> tabularium-server
cd deploy
cp .env.example .env    # 填写密码和 TABULARIUM_PUBLIC_URL
docker compose -p tabularium --env-file .env up -d --wait
```

网关只监听 `127.0.0.1`。前面要放一个 HTTPS 反向代理，满足三个条件：不缓冲响应（同步的变更流是长连接）；读取超时长于网关五分钟的连接上限；接受 64 MiB 的请求体。nginx 的写法：`proxy_buffering off`、`proxy_request_buffering off`、`proxy_read_timeout 600s`、`client_max_body_size 64m`。

安装插件：把 zip 中的 `main.js`、`manifest.json` 和 `styles.css` 复制到 `.obsidian/plugins/tabularium/`，然后启用。

## 备份与升级

`deploy/backup/cli.ts` 用 Node.js 24.10.0 运行，没有其他依赖：

```text
node deploy/backup/cli.ts backup   --compose <文件>... --env-file <文件> --project <名称> --output <目录>
node deploy/backup/cli.ts verify   <备份目录>
node deploy/backup/cli.ts restore  <备份目录> --project <名称> --target <目录> --port <端口>
node deploy/backup/cli.ts restore-scheduled <备份根目录> <备份点> --image <镜像> --compose <文件>... --env-file <文件> --project <名称> --target <目录> --port <端口>
node deploy/backup/cli.ts upgrade  --image <镜像> --compose <文件>... --env-file <文件> --project <名称> --output <目录>
node deploy/backup/cli.ts rollback <备份目录> --compose <文件>... --env-file <文件> --project <名称> --output <目录>
```

`backup` 短暂停止服务，归档两个数据卷和镜像。`upgrade` 先做这样一份备份，在副本上试运行新镜像，通过后再切换；`rollback` 回到升级前的那份备份。恢复总是进入一个新的 Compose 项目，从不覆盖正在运行的项目。定时备份由服务器自己写入，在「管理 → 备份」中配置。

## 许可证

插件沿用 Self-hosted LiveSync 的 MIT 许可证（版权归 vorotamoroz），见 `apps/obsidian/LICENSE`。排序包来自 SebastianMC 的 Custom File Explorer sorting，见 `packages/custom-sort/UPSTREAM.md`。Tabularium 其余部分的许可证尚未确定。发布包在 `THIRD_PARTY_LICENSES.md` 中列出所有第三方依赖。
