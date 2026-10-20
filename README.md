# 搭个伙 · 聚餐分账

一个可自行托管的多人聚餐分账工具，支持 Docker。所有金额使用人民币，以整数分计算，无第三方 npm 运行依赖。首次启动为空账单。

## 功能

- 每笔费用单独选择参与人，实时计算分摊；点击成员查看明细。
- 始终核对总费用与分摊合计，余下的分按固定成员顺序依次分配。
- 费用、成员分摊、垫付结算分类展示；支持聚餐历史、定稿和只读快照。
- 管理员维护账户、费用、成员、页面文字和图片；编辑者新增及修改账单资料。
- JWT 与 30 天 HttpOnly Cookie、会话撤销、密码管理、CSRF 和操作日志。
- 可校验备份、恢复工具，桌面和手机响应式布局。

不提供公开注册或真实支付。聚餐成员与登录账户独立。当前账单可公开浏览，历史与管理需要登录；需要完全私有账单时请置于受控网络或访问网关后。

## Docker Compose 部署

需要 Docker 和 Docker Compose v2。

1. 获取本仓库源码，在项目目录执行 `cp .env.example .env`。
2. 编辑 `.env`，自行设置 `ADMIN_PASSWORD`（12–256 个字符的强密码）。不要提交 `.env`。
3. 启动：

```sh
docker compose up -d --build
docker compose ps
```

默认地址为 `http://localhost:3000`，初始管理员用户名为 `admin`，密码由部署者配置，没有内置通用密码。初始密码仅用于创建空数据目录；已有数据重启或更换初始化变量不会重设密码，后续通过后台修改。

镜像以非 root 用户运行，根文件系统只读。`dinner-data` 与 `dinner-backups` 命名卷分别保存运行数据和备份。`docker compose down` 保留命名卷；带 `-v` 会删除数据，日常更新不要使用。

### 外网、HTTPS 与代理

默认仅发布到本机。外网部署按环境配置 `BIND_ADDRESS`、`APP_PORT`、`PUBLIC_ORIGIN`。例如域名为 `split.example` 时，可放在 HTTPS 反向代理后，并设置 `PUBLIC_ORIGIN=https://split.example`。

Origin 必须与浏览器实际协议、域名和端口一致，代理须保留 Host。HTTPS origin 自动启用 Secure Cookie。

`TRUST_PROXY=loopback` 仅信任应用进程的回环连接，普通跨容器代理不在范围内。Docker 默认不设置此值，日志可能显示容器网络地址。需要真实客户端 IP 时先设计受信代理边界，禁止信任任意客户端转发头。

### 更新与备份

更新前先备份，然后执行 `docker compose up -d --build`。保留整个数据卷，其中含账本、上传图片、JWT 密钥和有效会话。

```sh
docker compose exec -T app node scripts/backup.mjs \
  --data-dir /app/data --backup-dir /app/backups --retain-days 14
```

备份包含账户哈希、会话、密钥和图片，必须私有保存。可用宿主定时任务执行上述命令；Compose 本身不含定时执行器。另存一份到自己控制的独立存储。

本地校验与恢复（新目录必须尚不存在）：

```sh
node scripts/restore-backup.mjs --verify /path/to/backup.tar.gz
node scripts/restore-backup.mjs --verify /path/to/backup.tar.gz --restore-to /path/to/new-data
```

恢复历史快照并用于服务前，清空恢复副本中的 `authSessions` 数组，使旧会话重新登录，避免重新启用后来已注销的会话；不要修改备份原件。

## 本地开发

需要 Node.js 20 或更新版本。先通过环境变量设置 `ADMIN_PASSWORD`，再运行：

```sh
npm start
npm test
npm run check:version
npm run build
```

默认监听 `http://127.0.0.1:3000`，可用 `HOST`、`PORT`、`DATA_DIR`、`PUBLIC_ORIGIN` 配置。测试使用隔离临时目录和虚构凭据；`dist/` 发布目录不含运行数据。

密码以独立随机盐和 scrypt 哈希保存。JWT 签名密钥与会话持久化，可随退出或账户变化撤销；接口不返回密码哈希。Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下设置 Secure。写入还校验 Origin、CSRF、权限与数据版本。

本仓库只有通用源码、测试、模板和自制 SVG，不含运行账单、账户、上传图片、签名密钥、私有备份或部署者资料。`.gitignore` 与 `.dockerignore` 分别限制提交及镜像构建上下文。

## 许可证

采用 [MIT 许可证](LICENSE)，默认原创 SVG 随同分发。
