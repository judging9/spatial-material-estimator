# 开源来源与许可

材料报价桌面版 1.0.0 使用 GPL-3.0-or-later 许可。完整许可证见 LICENSE。

工程清单、单价分析的五种计算步骤、ROUND_HALF_UP 金额舍入及 .eproj 读取结构，根据 GEstimator 2.7 的 estimator/data/schedule.py 进行适配。

- 原项目：https://github.com/manuvarkey/GEstimator
- 原作者：Manu Varkey
- 原源码版权声明：Copyright 2014 Manu Varkey
- 原源码文件许可声明：GNU GPL version 2 or any later version；仓库 LICENSE 提供 GPL version 3。
- 本版改动：使用中文 Tkinter 界面替代 GTK；使用标准库 SQLite 只读导入原工程，避免 Peewee 依赖；加入国内材料价格库、工程报价快照、Excel 导入导出和便携启动入口。

完整桌面版源代码位于 app/（发行版）或 desktop/（工作区）。工作区保留用户下载的原始 GEstimator 源码包，没有改写原源码及原定额数据库。本版核心的测试会把真实工程分析与原作者的算法进行比较。

运行时和库的原许可证随发行版提供：

- Python 3.11 / Tkinter：Python Software Foundation License（runtime/LICENSE.txt）
- Tcl / Tk：各自许可见 runtime/tcl 目录
- requests：Apache-2.0
- urllib3：MIT
- certifi：MPL-2.0
- charset-normalizer：MIT
- idna：BSD-3-Clause
- openpyxl：MIT
- et-xmlfile：MIT

库的许可证、版本和作者信息见 runtime/Lib/site-packages 中对应的 .dist-info 目录。
