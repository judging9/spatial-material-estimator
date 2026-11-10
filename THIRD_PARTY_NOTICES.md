# 第三方组件与归属

本文件记录图纸材料工作台使用的第三方图标、开发工具和 Python 依赖。各组件保持其原许可；本文件不替代随组件提供的完整许可证及附加通知。

## Lucide 图标

`static/studio/icons.ts` 中选用的 SVG 图标路径参考 [Lucide](https://lucide.dev/) / [lucide-icons/lucide](https://github.com/lucide-icons/lucide)，使用 **ISC License**。部分路径源自 Cole Bemis 的 Feather 图标，其来源归属包含在 Lucide 原版权声明中。本项目仅嵌入所需 SVG 路径，没有运行时 React 图标依赖。

以下为 Lucide 分发的完整 ISC 许可声明：

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## 开发工具

| 组件 | 本项目使用版本 | 许可 / 归属 | 用途与许可文件 |
| --- | --- | --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.6.3 | Apache-2.0；Microsoft Corporation | 前端编译；`node_modules/typescript/LICENSE.txt`、`ThirdPartyNoticeText.txt` |
| [Playwright](https://github.com/microsoft/playwright) / Playwright Core | 1.48.2 | Apache-2.0；Microsoft Corporation | 浏览器验收；对应包内 `LICENSE`、`NOTICE`、`ThirdPartyNotices.txt` |

上述开发包的原始 `.tgz` 位于 `vendor/dev/`，包含各自许可文件。Playwright 的通知包含源自 Puppeteer 的代码归属。浏览器验收使用本机现有浏览器；浏览器自身许可由其安装包提供。

## Python 与系统组件

| 组件 | 当前验证版本 | 许可 / 归属 | 用途 |
| --- | --- | --- | --- |
| [Python](https://www.python.org/) | 3.11.9 | Python Software Foundation License 及随 Python 提供的通知 | HTTP 服务、SQLite、文件处理与桥接 |
| [NumPy](https://numpy.org/) | 2.4.6 | BSD-3-Clause；NumPy Developers | 图像阈值、闭合操作及连通区域分析 |
| [Requests](https://requests.readthedocs.io/) | 2.34.2 | Apache-2.0；Requests Contributors | 原报价系统的公开价格源请求 |
| [openpyxl](https://openpyxl.readthedocs.io/) | 3.1.5 | MIT；openpyxl Contributors | 原系统 Excel 导入导出 |
| urllib3 | 随 Requests 安装 | MIT | HTTP 依赖 |
| certifi | 随 Requests 安装 | MPL-2.0 | CA 证书依赖 |
| charset-normalizer | 随 Requests 安装 | MIT | 字符编码依赖 |
| idna | 随 Requests 安装 | BSD-3-Clause | 域名编码依赖 |
| et-xmlfile | 随 openpyxl 安装 | MIT 及所包含 Python 代码的许可 | XML 输出依赖 |

Python 包的完整许可位于其安装目录和对应的 `.dist-info` 目录。例如，NumPy 2.4.6 的完整声明为 `numpy-2.4.6.dist-info/licenses/LICENSE.txt`；openpyxl 的声明为 `openpyxl-3.1.5.dist-info/LICENCE.rst`。NumPy 二进制包还包含 OpenBLAS 等组件，其通知随 NumPy 完整许可提供，分享二进制依赖时应一并保留。

PNG/JPG 解码调用 Windows `System.Drawing`，PDF 栅格化调用 Windows `Windows.Data.Pdf.PdfDocument`。这些是接收电脑已有的 Windows / .NET 系统 API，本项目没有重新分发 Windows 组件。

## 已保留的桌面版与 GEstimator

`desktop/` 中先前制作的桌面版使用 GEstimator 2.7 的工程清单、单价分析与 `.eproj` 结构适配代码，遵循 GPL-3.0-or-later；详细来源、作者和改动见 `desktop/NOTICE.md`，完整许可见 `desktop/LICENSE`。

用户下载的 `GEstimator-2.7/` 原源码保留原作者 Manu Varkey 的版权及许可声明。此归属对应已有桌面版及原源码，不表示新的 SVG 图标、第三方开发工具或 Python 依赖改变了其各自许可。

## OpenPlan3D 二维绘图参考与改编

本次房间模板及吸附交互参考并改编用户提供的 `openPlan3D-main/openPlan3D-main/` 源码包，包内版本为 `0.9.0`。该包 README 链接的上游项目为 [laanlabs/openPlan3D](https://github.com/laanlabs/openPlan3D)，其 `package.json` 的仓库字段为 [theLodgeBots/open3dFloorplan](https://github.com/theLodgeBots/open3dFloorplan)。许可和版权归属以本地源码包的 `LICENSE` 为准。

涉及的源文件为 `src/lib/utils/roomPresets.ts` 中房间轮廓的纯几何部分，以及 `src/lib/utils/canvasInteraction.ts` 中网格、端点与角度吸附的交互规则。画墙生成房间还实际复制并改编了 `roomDetection.ts`、`roomNesting.ts`、`wallProfiles.ts`，放在 `static/studio/vendor/openplan/`，裁剪了类型依赖并收紧自动连接容差。每份改编源码均保留完整 MIT 许可头。

`static/studio/lib/wall-plan.ts` 将这些墙体拓扑结果转换为扣除墙厚的净施工多边形，并使用当前几何引擎验证有效性、孔洞、区域重叠及墙体占地。改编使用当前工作台的区域、计量单位、报价和历史数据模型，未嵌入完整 Svelte 编辑器、Three.js 视图或其家具与纹理资源。集成范围见 [docs/openplan-integration.md](docs/openplan-integration.md)。

以下为所提供源码包的完整 MIT 许可：

```text
MIT License

Copyright (c) 2026 theLodgeStudio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
