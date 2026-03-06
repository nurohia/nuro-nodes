# Nuro-Nodes

前后端分离的 x-ui 节点查询与订阅分发系统。

## 目录结构
- `backend/` Node.js + Express 网关
- `frontend/` Vue 3 + Vite 前端
- `docker-compose.yml` Docker 编排

## 下载后直接改的文件
- `backend/.env`
- `backend/nodes.json`
- `backend/redeem_codes.json`
- `backend/app_config.json`（可选）

`backend/nodes.json` 和 `backend/redeem_codes.json` 已随仓库提供空模板（`[]`），你下载后直接编辑即可。

## 本地开发运行
1. 安装依赖
```bash
npm run install:all
```
2. 编辑配置
- 后端：`backend/.env`、`backend/nodes.json`、`backend/redeem_codes.json`
- 前端：`frontend/.env`
3. 启动
```bash
npm run dev
```

默认地址：
- 前端：`http://localhost:38173`
- 后端：`http://localhost:38081`
- 后台：`http://localhost:38173/<VITE_ADMIN_PATH_KEY>`

## Docker 部署教程

### 1) 拉取项目
```bash
git clone https://github.com/nurohia/nuro-nodes.git
cd nuro-nodes
```

### 2) 直接编辑配置（不用复制模板）
- 编辑 `backend/.env`
- 编辑 `backend/nodes.json`
- 编辑 `backend/redeem_codes.json`
- 可选编辑 `backend/app_config.json`

必须确认：
- `backend/.env` 里的 `ADMIN_PATH_KEY`(后台路径，默认nuro-admin)
- `backend/.env` 里的 `ADMIN_TOKEN`（或 `ADMIN_TOKEN_SHA256`）(后台令牌，默认nuro-admin-token)
- `CORS_WHITELIST` 为你的服务器IP,如果反代需要加上域名例如 `CORS_WHITELIST=https://panel.example.com,http://127.0.0.1:38173`

### 3) 启动容器
```bash
docker compose up -d --build
```

默认端口映射：
- 前端：`38173 -> 80`
- 后端：`38081 -> 38081`

### 4) 常用命令
查看状态：
```bash
docker compose ps
```

查看日志：
```bash
docker compose logs -f backend
docker compose logs -f frontend
```

停止：
```bash
docker compose down
```

重启:
```bash
docker compose restart
```

删除:
```bash
cd ~/nuro-nodes
docker compose down

cd ~
rm -rf nuro-nodes
```

## 支持的X-UI

### 一键命令(不支持3-UI)
`bash <(curl -Ls https://raw.githubusercontent.com/vaxilu/x-ui/master/install.sh)`

### 支持的协议
- Shadowsocks
- HTTP
- SOCKS
- Vmess
### 不支持的协议(因为XUI太久，新版Xray不支持)
- Trojon
- Vless


## 安全建议
- 不要把真实生产数据（节点地址、真实兑换码）长期放在公开仓库。
- 生产环境建议仅使用 `ADMIN_TOKEN_SHA256`。
- 建议配合 HTTPS 与反向代理。

