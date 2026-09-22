# web-player

极简儿童视频播放器：**文件夹即节目**。

- 每个直接包含视频的文件夹就是一个节目，文件夹名就是节目名，封面自动从第一集截取。名字和封面都不可编辑。
- 目录可以多层嵌套，卡片只显示最内层文件夹名，鼠标悬浮显示完整路径和集数。
- 点封面即播放，支持「顺序连播」和「单集播放」。
- 局域网内 iPad / 手机 / 电视的浏览器都能打开。
- mp4 / mov / webm 直接播放；mkv / flv / avi 等由内置 ffmpeg 实时转成 mp4 流。

## 启动

```bash
npm install
npm start
```

打开 http://localhost:8080 ，终端会打印局域网地址。首次启动自动扫描。

## 配置

`config.json`（首次启动自动生成）：

```json
{ "port": 8080, "scanDirs": ["/Volumes/SANSUNG/kids-videos"] }
```

也可以在页面右上角 ⚙️ 设置里增删目录并重新扫描。

## 数据

`data/library.json` 是扫描结果，`data/covers/` 是封面缓存。删掉 `data/` 重启即可完全重扫。
