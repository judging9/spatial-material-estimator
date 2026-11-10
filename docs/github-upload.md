# 上传项目到 GitHub

当前项目目录为 `D:\c\yujiao_project`，已经安装 Git，尚未初始化 Git 仓库。

## 第一次上传

1. 登录 GitHub，点击右上角「+」→「New repository」。填写仓库名称，例如 `spatial-material-estimator`。如果先与甲方或协作者交流，可选择 **Private**。
2. 新建一个空仓库，暂不勾选 README、`.gitignore` 或 License，项目已有 README 和忽略规则。
3. 打开 PowerShell，执行下面的命令。把最后两行中的地址换成 GitHub 新仓库页面给出的 HTTPS 地址。

```powershell
cd D:\c\yujiao_project
git init -b main
git add .
git status --short
git commit -m "Initial release: Spatial Material Estimator 1.3.0"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

提交前检查 `git status --short`：应包含应用源码、`static`、`tests`、`docs`、`desktop` 的源码与 `vendor/dev`；本机的 `data`、`release`、`artifacts`、`node_modules`、`.venv` 和下载的参考项目不会加入提交。

如果第一次提交提示 **Author identity unknown**，先设置本仓库的提交署名，再重新运行 `git commit` 和之后的命令：

```powershell
git config user.name "你的 GitHub 用户名"
git config user.email "你的 GitHub 提交邮箱"
```

邮箱可使用 GitHub Settings → Emails 中提供的 `noreply` 邮箱。推送时通过 Git Credential Manager 的浏览器登录流程登录 GitHub；若终端直接要求 HTTPS 密码，GitHub 使用 Personal Access Token 进行认证。

## 上传正式软件包

项目源码通过 Git 管理；给甲方运行的 ZIP 通过 Releases 分发。

1. 打开仓库的 **Releases** → **Draft a new release**。
2. 标签填写 `v1.3.0`，选择 `main`；标题填写「空间材料估算 1.3.0」。
3. 把以下文件拖到附件区域：
   - `release/空间材料估算-1.3.0-Windows-x64.zip`
   - `release/空间材料估算-1.3.0-Windows-x64.sha256.txt`
4. 在说明中写明 Windows 10 / 11 64 位、完整解压后运行「空间材料估算.exe」、无需安装 Python / Node.js / Blender，然后发布。

Private 仓库的 Releases 也受仓库访问权限限制，甲方需要被添加为协作者才能下载；也可以直接把 ZIP 发给甲方。

## 以后更新

```powershell
cd D:\c\yujiao_project
git add .
git status --short
git commit -m "Describe this update"
git push
```

修改 TypeScript 后，先按项目说明运行构建和相应测试，再提交源码及运行所需的 `static/studio` JavaScript。正式软件修改后需重新构建发行包，并创建对应的新 Release。
