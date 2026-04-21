# RemoteTool — macOS SSH 客户端（支持 lrzsz）

一个基于 Electron 的 macOS SSH 远程工具，原生支持 **ZMODEM (lrzsz)** 文件传输协议。

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| **SSH 连接** | 支持密码认证 & 私钥认证（RSA/ED25519/ECDSA） |
| **多 Tab** | 多个会话同时开启，⌘] / ⌘[ 快速切换 |
| **lrzsz 上传** | 服务端运行 `rz`，自动弹出文件选择框 |
| **lrzsz 下载** | 服务端运行 `sz <file>`，自动保存到本地 |
| **传输进度** | 实时显示文件名、进度条、速率 |
| **连接管理** | 保存连接到 `~/.remotetool/connections.json` |
| **macOS 原生风格** | 毛玻璃效果、Traffic Light 按钮、系统菜单 |
| **256色终端** | xterm-256color，支持彩色输出 |

## 📦 安装依赖

```bash
# 需要 Node.js >= 16 和 npm
cd remote-tool
npm install
```

## 🚀 运行开发版

```bash
npm start
```

## 🏗 打包为 .app / .dmg

```bash
# 打包为 .app（不签名）
npm run pack

# 打包为 .dmg（需要 Apple 开发者证书进行公证）
npm run dist
```

打包产物在 `dist/` 目录下。

## 🔑 首次使用

1. 启动后点击左侧 **＋** 按钮
2. 输入主机 IP、端口、用户名
3. 选择认证方式（密码 / 私钥）
4. 点击「保存并连接」

## 📁 lrzsz 文件传输

### 从本地上传文件到服务器（rz）

在 SSH 终端中运行：
```bash
rz
```
- RemoteTool 自动检测到 ZMODEM RINIT 握手
- 弹出本地文件选择对话框
- 支持多文件同时上传

> **服务器需安装 lrzsz：**
> ```bash
> # Debian/Ubuntu
> sudo apt install lrzsz
> # CentOS/RHEL
> sudo yum install lrzsz
> # macOS (服务端)
> brew install lrzsz
> ```

### 从服务器下载文件到本地（sz）

在 SSH 终端中运行：
```bash
sz /path/to/file.tar.gz
```
- RemoteTool 检测到 ZMODEM ZFILE 帧
- 自动弹出「另存为」对话框
- 下载完成后自动在 Finder 中显示

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘N` | 新建连接 |
| `⌘W` | 关闭当前 Tab |
| `⌘]` | 下一个 Tab |
| `⌘[` | 上一个 Tab |

## 📁 项目结构

```
remote-tool/
├── main.js          # Electron 主进程（SSH2、文件 I/O、连接管理）
├── preload.js       # 安全的 IPC 桥接（contextBridge）
├── package.json     # 依赖与打包配置
├── src/
│   ├── index.html   # 主界面 HTML
│   ├── renderer.js  # 终端渲染 + ZMODEM 协议处理
│   └── styles.css   # macOS 风格暗色主题
└── README.md
```

## 🛠 技术栈

- **[Electron 28](https://www.electronjs.org/)** — 跨平台桌面框架
- **[ssh2](https://github.com/mscdex/ssh2)** — 纯 JS SSH2 实现
- **[xterm.js 5](https://xtermjs.org/)** — 终端渲染
- **[zmodem.js](https://github.com/FGasper/zmodem.js)** — ZMODEM 协议（lrzsz）

## 🔒 安全说明

- `contextIsolation: true` + `nodeIntegration: false` — 渲染进程无法直接访问 Node.js
- 所有 Node.js 操作通过 `preload.js` 的 `contextBridge` 暴露
- 连接配置（含密码）保存在本地 `~/.remotetool/connections.json`，建议对私钥文件设置权限 `chmod 600`

## 📄 License

MIT
