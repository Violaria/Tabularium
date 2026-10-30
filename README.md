# Tabularium

Tabularium 是自托管的加密笔记同步服务器：账户、笔记库、设备凭据、同步网关、浏览器管理控制台、备份恢复与升级回退。笔记在客户端加密，服务器网关后面是内网 CouchDB，不开放公开注册。Obsidian 插件 Tabularium（基于 Self-hosted LiveSync，内置文件排序）登录服务器即可同步。

当前版本 0.10.0，已部署在 oblivaria。已有发送到 Kindle 与网页笔记端（浏览器内解密，可编辑、离线使用），插件与网页均为英文、中文、拉丁语三语。AI 管理员 Tabularius 已能按笔记库开启，检索并带引用回答，按规范整理笔记，改动以提案审阅后应用，可检索本机 RAGFlow 知识库，可联网核实，有跨对话的记忆，支持 Anthropic、OpenAI 与 vLLM；可按权限档位经 SSH 帮忙运维；沙箱在后续阶段。

- [项目蓝图与进度](docs/项目蓝图.md)
- [安装指南](docs/安装指南.md)
- [文档目录](docs/README.md)

`reference/` 是上游参考仓库，来源与版本见开发指南。
