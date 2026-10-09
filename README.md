# web-player

中文 | [English](README.en.md)

极简儿童视频播放器：**文件夹即节目**。

给孩子学外语（英语原版动画、儿歌、绘本视频……）准备的家庭播放器。把下载好的视频按文件夹放好，
家里的 Mac / 电脑跑起来，iPad、手机、电视、安卓平板打开浏览器就能看：没有广告、没有推荐、没有自动跳到别的视频，
孩子只看你放进去的内容。支持断点续播、喜欢、历史记录，还能按字幕台词搜索。

欢迎各位宝爸宝妈使用、提 Issue 和 PR。

- 每个直接包含视频的文件夹就是一个节目，文件夹名就是节目名，封面自动从第一集截取。名字和封面都不可编辑。
- 目录可以多层嵌套，卡片只显示最内层文件夹名，鼠标悬浮显示完整路径和集数。
- 点封面即播放，支持「顺序连播」和「单集播放」。
- 点卡片左上角 🤍（或播放页的「喜欢」）标记喜欢，喜欢的节目排在最前面，最近喜欢的在最前。记录在 `data/favorites.json`，所有设备共用。
- 局域网内 iPad / 手机 / 电视的浏览器都能打开。
- mp4 / mov / webm 直接播放；mkv / flv / avi 等由内置 ffmpeg 实时转成 mp4 流。
- 界面支持中文和英文，默认跟随浏览器语言，也可以在设置页「语言」里切换（只对当前浏览器生效）。

## 下载即用（推荐）

到 [Releases](https://github.com/codewithyou365/web-player/releases/latest) 下载对应的安装包，不用装 Node，也不用 `npm install`：

- **Mac / Windows / Linux**：下载对应的 `web-player-*.zip`，解压后双击 `start.command`（Mac）/ `start.bat`（Windows）/ `start.sh`（Linux），浏览器会自动打开。
  Mac 第一次如果提示「无法验证开发者」，右键 → 打开。
- **安卓平板 / 手机**：下载 `web-player-android.apk` 安装。

把视频放进用户主目录下的 `kids-videos` 文件夹（或在设置页添加目录）即可。

## 从源码启动

需要 Node.js 22.13 以上。

```bash
npm install
npm start
```

打开 http://localhost:8080 ，终端会打印局域网地址。首次启动自动扫描。

## iPad 固定地址（Tailscale）

局域网 IP 会变，出门连热点时网段也不一样，所以 iPad 统一走 Tailscale：

1. iPad 安装官方 Tailscale（中国区 App Store 没有，要用外区 Apple ID），登录和 Mac 同一个账号，保持开启。
2. Safari 打开 `http://<mac 的 MagicDNS 名>:8080`，例如 `http://macbook-pro.tailxxxxx.ts.net:8080`。打不开就换成终端打印的 `Tailscale:` 那个 100.x 地址。
3. 分享 →「添加到主屏幕」。从桌面图标打开是全屏的，在家 Wi-Fi 和出门连热点都用这一个图标。

在家时 Tailscale 会自动走局域网直连，不会绕路。

## 配置

`config.json`（首次启动自动生成，默认扫描用户主目录下的 `kids-videos` 文件夹）：

```json
{ "port": 8080, "scanDirs": ["/Users/me/kids-videos"] }
```

也可以在页面右上角 ⚙️ 设置里增删目录并重新扫描。

## 搜索

首页右上角 🔍，输入节目名、集名、目录名或**字幕里的台词**，多个词用空格隔开表示同时满足（如「小猪佩奇 泥坑」）。
不区分大小写，忽略空格和标点；整句按顺序出现的排在前面。

- 命中节目名/目录 → 打开节目；命中集名 → 直接播那一集。
- 命中节目目录里的文本（srt / ass / ssa / vtt / lrc / txt / nfo / md，只收直接有视频的目录里的）→ 显示所在节目和命中的那句台词，
  点进去不自动播放，自己从列表里选一集。字幕的 UTF-8 / UTF-16 / GBK 编码都能识别。

第一次用要先**建立搜索索引**（设置页或搜索页的按钮；要读字幕，几千个文本大约几秒到几十秒）。索引存在 `data/search.db`（Node 自带的 SQLite，不用装别的），
建好以后重新扫描、删除视频时自动更新。不用 AI 模型，不联网，几乎不占内存。Android 版同样支持，索引用系统自带的 SQLite。


## 数据

`data/library.json` 是扫描结果，`data/covers/` 是封面缓存，`data/search.db` 是搜索索引。删掉 `data/` 重启即可完全重扫。

## 管理模式

设置页打开「管理模式」（只对当前设备的浏览器生效）后：

- **归档**：节目卡片上的 🗂，选一个上级目录折叠成文件夹卡片，该目录下所有节目都收进去。可以多层嵌套，文件夹卡片上的 📂 取消归档。归档只影响显示，不动硬盘文件。记录在 `data/folders.json`。
- **彻底删除**：🗑 直接从硬盘删除单集或整个节目（含同名字幕），不可恢复。只删该节目自己的文件，目录空了才删目录。
- **断点续播 / 最近播放**：进度存在 `data/progress.json`，所有设备共用。
- **历史播放**：首页右上角 🕘，列出所有播放过的节目（每个节目一条，记最后看到的集数和时间），点一下接着播。记录永久保存，只能手动 ✕ 删除或清空；删掉记录会同时清掉断点。

## Android 平板版（`android/`）

同一套前端页面（`public/`）打进 APK，后端用 Kotlin 重写（NanoHTTPD + ffmpeg-kit），
平板自己监听端口，局域网里其他设备用浏览器打开同样能看；平板本机用内置 WebView 打开。

- 数据（`config.json`、`data/`）存在应用私有目录，卸载即清空。默认扫描 `/sdcard/Movies` 和 `/sdcard/kids-videos`，可在设置页改。
- 需要「所有文件访问」权限（首次启动会引导去系统设置打开），用来扫描目录、截封面和删文件。
- 前台服务常驻，退到后台、熄屏后端口照常监听；开机自动拉起。设置页和通知栏都会显示局域网地址。
- 非原生格式实时转码：优先 `h264_mediacodec` 硬编，跑不通自动回退 `libx264`（重编码时限到 720p）。

### 构建

```bash
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 里的 `sdk.dir` 指向本机 Android SDK；依赖走阿里云镜像。只打 arm64-v8a 一种架构。

`assembleRelease` 会读取 `android/keystore.properties`（或环境变量 `KEYSTORE_PROPERTIES` 指向的文件）做正式签名，
没有就用 debug 签名。

## 发布

推送 `v*` tag 后，GitHub Actions（`.github/workflows/release.yml`）会自动打包四个平台的电脑版 zip 和 APK，并发布到 Releases：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

电脑版用 `scripts/package-desktop.sh <mac-arm64|mac-x64|win-x64|linux-x64>` 打包，本地也能跑。

## 许可证

[MIT](LICENSE)
