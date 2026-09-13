# POCKET ROOM · 口袋游戏室

独立仓库：[yaoxin521123/gba-arcade](https://github.com/yaoxin521123/gba-arcade)

在线游玩：https://yaoxin521123.github.io/gba-arcade/

通过 GitHub Pages 从 `main` 分支根目录发布，无需构建。

在本目录运行 `python -m http.server 8791`，访问 http://localhost:8791。GBA 模拟器需要 HTTP/HTTPS 页面，请不要双击 HTML 用 file:// 打开。

点击右侧卡带插入，按 Enter 开始或暂停。方向键 / WASD 移动，空格执行游戏动作。机身方向键和 A / B 键支持鼠标、触屏。SELECT 或“弹出卡带”退出游戏。音效默认关闭，右上角开启。切换标签页时自动暂停。

四个原创 Canvas 小游戏：贪吃蛇（空格加速）、赛车（空格加速）、打砖块（空格发球）、星际射击（空格射击）。最高分保存在本机浏览器；切换卡带会开始新一局。

机身采用 CSS 立体造型、透视、光影和卡带插入动画，不是可自由旋转的 WebGL 模型。无构建步骤；Google Fonts 无法连接时自动使用系统字体。

## 本地 GBA 卡带

页面下方点击“导入 GBA 卡带”，可一次选择多个 `.gba` 文件。mGBA WebAssembly 在本机浏览器执行 ROM，文件不会上传服务器。卡带保存在 IndexedDB，刷新后点击本地卡带即可继续使用。ROM 头用于识别名称，SHA-256 用于隔离不同版本的存档；文件语言取决于原始 ROM 或汉化补丁。

- 方向键移动，X / 空格 = A，Z = B，Q / E = L / R，Enter = START，Shift = SELECT。
- P 或“暂停”暂停模拟器。机身 SELECT / START 在 GBA 模式下对应真实按键。
- “即时存档”保存一个本地状态槽，“读取存档”恢复；“导出存档”生成 `.pocket-save` 备份，“导入存档”校验卡带 SHA-256 后恢复。
- 游戏内部存档由模拟器定期保存到浏览器 OPFS。重要进度建议同时导出即时存档备份。清除网站数据会删除浏览器中的卡带和存档。
- “放大屏幕”进入全屏，Esc 退出。窗口失焦会自动暂停。
- 卡带库和即时存档按网站来源隔离，本地和 GitHub Pages 不共享数据；可通过导出、导入迁移即时存档。

模拟器固定使用 `@wasm-gaming/mgba-wasm@0.1.1`，运行文件和许可证在 `vendor/mgba`。无需另外提供 BIOS。项目未包含游戏 ROM；`.gba` 和个人存档在 Git 忽略规则内。

## 站点卡带

支持从同站点加载预配置的 GBA 卡带：文件放在 `roms/`，在该目录的 `catalog.json` 登记 `name` 和 `file`。页面显示“站点卡带”，点击才开始下载并运行。完整格式见 [目录配置说明](roms/README.md)。默认清单为空，不附带任何游戏。

文件下载设有 60 秒超时和 32 MB 大小限制。清单损坏、文件不存在或 ROM 无效时会提示错误，原有小游戏和本地导入仍可使用。站点卡带与同一文件的本地导入使用相同的 SHA-256 存档标识。
