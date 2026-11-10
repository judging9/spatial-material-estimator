# 中文材料报价桌面版

运行源代码：`python desktop/main.py`。发行版入口：`desktop/dist/材料报价.exe`。

使用 Tkinter 原生桌面界面，复用 GEstimator 工程清单/单价分析模型并只读导入其 `.eproj` 文件。无需 GTK 或 Peewee。

系统 Python 依赖：`requests`、`openpyxl`，以及 Python 自带的 `tkinter`。

验证：

```
python desktop/main.py --self-test
python -m unittest discover -s desktop -p "test_*.py" -v
```

构建：`python desktop/packaging/build_portable.py`。

运行时打包使用本机 Python 和依赖副本，保留完整许可证。发行目录必须整体复制。

发行版中的完整对应源码位于 `source/project`；切换到该目录后，可使用上述运行、测试和构建命令。

详细操作见 [使用说明.md](使用说明.md)，开源来源见 [NOTICE.md](NOTICE.md)。
