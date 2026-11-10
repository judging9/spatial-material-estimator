# 三维地形与隧道查看

三维画布左下角的移动工具中增加「地形：实景 / 剖视 / 隐藏」。这些选项只控制当前三维显示，切换时保持相机位置、区域几何、工程量、报价、撤销历史和保存数据。

- **实景**：绘制真实地形并写入深度。山体遮挡的道路与管线不能从山体表面透选；真实隧道洞口与 DEM 空白范围仍可正常查看、拾取。
- **剖视**：以 22% 不透明度叠加真实地形，不写入地形深度。可以查看、选择地下道路、隧道与管线，保留山体位置参照。
- **隐藏**：临时隐藏地形，集中查看设施。工程量和地形本身不会删除。

存在真实地形时，三维查看不绘制人工水平网格，避免网格挡住低于零标高的设施。选择或调整价格不会重置显示模式；切换到另一个项目后恢复实景。

## 接口

`Viewer3D.setTerrainDisplayMode('solid' | 'cutaway' | 'hidden')` 更改显示方式，无须重新生成工程几何。

`Viewer3D.focusTunnel(id, 'inside' | 'start' | 'end')` 根据已生成道路隧道的真实洞口、道路标高与朝洞内切线定位。洞内视点位于起点洞口向内最多 2 米、路面上方净高的 45% 处；短隧道按实际长度缩短前进距离。起点、终点视点位于相应洞口外朝向洞内。定位后可继续使用现有 WASD、Space、Ctrl 移动和鼠标转向。没有有效隧道的设施返回 `false`。

显示控件为 `#terrain-display-solid`、`#terrain-display-cutaway`、`#terrain-display-hidden`，`aria-pressed` 表示当前选择。没有可见地形时不显示控件。

`getStats()` 提供 `terrainDisplayMode`、`terrainOpacity`、`terrainOccludesPicking` 和 `terrainRenderedDrawBatches`。原 `terrainTriangleCount` 与 `terrainDrawBatches` 仍表示原始几何和 GPU 缓存，便于区分显示隐藏与几何删除。

## 计算与校验

`lib/scene-visibility.ts` 将真实地形面片编译为三角形与独立包围盒缓存，射线先做包围盒筛选，再对真实三角形求交。不会使用整个山体的包围盒伪造遮挡，也不会填补 DEM 空白、孔洞或隧道洞口。实景的设施便利拾取也受地形交点限制，防止宽道路的中心线容差穿透山体。

`tests/terrain-visibility.test.mjs` 检查真实坡面交点、缺失面片、距离上限、实景遮挡、剖视选择、宽道路中心线、实际渲染器的深度状态恢复、洞口与洞内相机以及项目数据不变性。纯算法与控制器测试不需要启动浏览器。
