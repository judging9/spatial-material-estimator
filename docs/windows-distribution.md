# Windows 发行说明

产品为「空间材料估算」，正式版本 1.3.0，面向 Windows 10 / 11 的 64 位系统。发行前需在独立数据目录验收原生入口、依赖及业务流程。正式产物为 `release/空间材料估算-1.3.0-Windows-x64.zip` 及同名 `.sha256.txt`，完整目录为 `release/空间材料估算-1.3.0-Windows-x64/空间材料估算/`。原 1.1.0 和 1.2.0 目录、ZIP 及校验文件继续保留，不覆盖。

1.3.0 包含任意角度与圆弧绘图、家具和实际管线报价、多楼层及楼梯口、天花板、市政设施、地形编辑、道路纵横断面、土方和管网分析，以及穿山隧道与便捷三维查看。造价总表独立汇总，参考价和指标估算保留标记。完整操作及计量范围见 [使用说明](client-user-guide.html)。

## 构建

使用当前仓库的已编译前端和本机 Windows x64 Python 3.11 依赖，先离线生成发行目录：

```powershell
npm.cmd run build
D:\python\python.exe desktop\packaging\build_studio_release.py --stage-only
```

发行目录先生成于 `release/空间材料估算-1.3.0-Windows-x64/空间材料估算/`。`--stage-only` 只生成目录；验收后运行 `--archive`，生成 `release/空间材料估算-1.3.0-Windows-x64.zip` 及同名 `.sha256.txt`。首次构建要求已有 GCC、windres、requests、openpyxl、NumPy 及其依赖；接收者运行时不需要这些开发工具。

已有当前 1.3.0 运行时目录时，可只更新程序和文档；先验收，再执行最后一条归档命令：

```powershell
D:\python\python.exe desktop\packaging\build_studio_release.py --refresh-app --stage-only
D:\python\python.exe desktop\packaging\build_studio_release.py --archive
```

构建脚本使用文件白名单，不读取工作目录的数据库、图纸、个人项目、日志或旧桌面包。运行时包含 Python、请求及 Excel 依赖、NumPy 二进制和完整第三方许可。`BUILD-MANIFEST.json` 记录每个发行文件的 SHA256；归档时检查完整性及文件清单。

正式目录应包含三专业及公共造价模块的已编译 JavaScript、1.3.0 版本资源和随包使用说明。不得仅更新版本号后直接归档；图纸上传、绘图、三专业生成、单价修改、汇总、保存和导出需在独立数据目录完成验收。

## 启动与数据

入口为带正式图标和版本资源的「空间材料估算.exe」。C 启动器以隐藏方式启动包内 `runtime/pythonw.exe`，通过 `-I` 和独立 `_pth` 配置隔离开发机或接收者的 Python 环境，不使用系统 Python 回退。子进程显式使用交互桌面，避免隐藏进程继承非交互桌面后发生系统 DLL 初始化错误；不会打开命令行窗口。

桌面服务使用稳定地址 `http://127.0.0.1:18770`。Edge / Chrome 使用专用浏览器数据目录，关闭应用窗口后停止本地服务。再次启动使用原目录和地址，已保存项目可从顶部文件夹按钮打开。

用户数据位于 `%LOCALAPPDATA%\PlanMatter`：

- `browser-profile`：项目 IndexedDB、自定义材料库及当前用户浏览器配置。
- `data/app.db`：材料价格工具的本地数据库。
- `data/drawings`：上传图纸、PDF 及渲染页。
- `desktop-config.json`：固定端口配置。
- `logs`：启动及服务日志。
- `cache/temp`：应用临时文件。

程序目录可替换，以上数据目录独立保留。完整备份需退出软件后复制整个用户数据目录；跨电脑单项目交接可使用完整项目 JSON。不得仅备份 SQLite 数据库后声称已备份工作台项目。

1.3.0 的全楼层几何、家具设备、管线、天花板、市政地形、道路及隧道参数，以及价格快照、手工清单和统一费率随工作台项目保存。旧项目没有 `cost` 字段时可以打开；进入造价页后再生成专业清单。升级前备份完整用户数据目录，旧1.1.0及1.2.0发行文件作为历史版本保留。

升级时先关闭旧版本窗口，再将新版完整解压到新目录并启动。新旧版本共用稳定产品标识、18770端口和 `%LOCALAPPDATA%\PlanMatter` 数据目录，用户项目与材料保留。旧实例仍在运行时，新入口会激活旧窗口，因此需先退出旧版本才能运行新版。

## 验收

启动层支持 `--self-test`，测试依赖加载、数据库、首页及包内模块路径；`--data-dir` 可指定隔离数据目录。测试 native 入口时同时设置 `PLANMATTER_DATA_DIR`，将早期启动日志与临时文件也置于同一隔离目录，避免接触用户数据。

`--headless-browser` 与 `--serve-only` 用于无可见窗口的自动化验收。独立浏览器验收脚本为 `artifacts/release-validation/desktop-host.e2e.mjs`；正式发行包不包含测试脚本和验收项目。业务计算由现有几何及金额单元测试覆盖。

验证脚本通过 RELEASE_ROOT、RELEASE_EXE 和 RELEASE_VERSION 指向新发行目录。原生入口自检、真实包内服务的图纸上传、绘制、保存重开和导出，应全部通过后再归档。自动化使用隔离目录，不包含实际用户项目或图纸；验收记录保存于 artifacts/release-validation。

材料价格与开孔规则见 [功能说明](next-improvements.md)，甲方操作说明见 [使用说明](client-user-guide.html)。

## 计价范围

材料供应单价不直接充当完整施工综合价；待定价项使总额仅表示已定价部分。项目措施和税率统一计算，造价总表不再叠加原材料报价。绘图支持最多8层独立布局；土建方案的层数只复制标准层地上方案工程量，基础与土方计一次，不自动创建设计楼层或复制装修房间。部分钢筋、水电和桥梁方案项目仍为指标 / 方案估算，实际绘制的设备、管线和设施按对应几何计量；不进行结构设计、抗震验算、自动隧道支护消防设计或机电管线综合，不替代施工图预算和招标控制价。每条道路目前支持一个连续隧道区间。

## 1.3.0 真实包内验证命令

```powershell
$env:RELEASE_VERSION='1.3.0'
$env:RELEASE_ROOT='D:\c\yujiao_project\release\空间材料估算-1.3.0-Windows-x64\空间材料估算'
$env:RELEASE_EXE=Join-Path $env:RELEASE_ROOT '空间材料估算.exe'
$env:NODE_OPTIONS='--jitless'
node --single-threaded --single-threaded-gc --max-semi-space-size=128 artifacts/release-validation/native-self-test.mjs
node --single-threaded --single-threaded-gc --max-semi-space-size=128 artifacts/release-validation/desktop-host.e2e.mjs
```

两条命令分别验证实际原生 EXE 自检，以及包内 Python 运行时、真实浏览器窗口生命周期、上传、保存重开和导出。所有用户数据均写入自动创建的隔离目录。最终 ZIP 还需全量 CRC 和 SHA256 清单校验，并从全新目录解压后再次运行原生 EXE 自检。
