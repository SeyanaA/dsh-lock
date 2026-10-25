# dsh-lock · DSH 锁屏 / Touch ID 验证

[![test](https://github.com/SeyanaA/dsh-lock/actions/workflows/test.yml/badge.svg)](https://github.com/SeyanaA/dsh-lock/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/SeyanaA/dsh-lock)](https://github.com/SeyanaA/dsh-lock/releases)

> 首个公开版本 **v0.1.6**（macOS 26 Liquid Glass 风格）。
> 下载：[Releases](https://github.com/SeyanaA/dsh-lock/releases) · 预览：[`docs/preview-lock.png`](./docs/preview-lock.png)

![锁屏预览](./docs/preview-lock.png)

给 [DeepSeek Harness](https://github.com/deepseek-ai) Desktop 用的**本地锁屏插件**（macOS，
建议 MacBook 且支持 Touch ID）：

- **每次启动 DSH**：需要重新验证（密码或 Touch ID）；
- **48 小时未验证**：下一次打开 / 状态轮询时重新锁定；
- **首次访问**：强制设置解锁密码（**至少 4 位，内容不限**，任何字符都可以）；
- **不自动弹指纹**：遵守 macOS 安全惯例，锁屏出现时**不会主动弹出**系统验证面板；你只要
  **轻触锁屏空白处 / 按一次 Enter / 点一下 Touch ID**，系统面板才会被唤起，然后把手指放上去
  即解锁（系统面板也允许回退到 Mac 登录密码）；
  > 说明：macOS 不向第三方应用开放“后台监听 Touch ID 传感器”的能力，指纹验证必须通过系统
  > 面板完成，这是 Apple 的安全设计；所以无法做到“手指一放就检测、完全零交互”。
- **液态玻璃（Liquid Glass）视觉**：按 Apple HIG “Materials”与 macOS 26 控制层规范重做——
  胶囊形输入框与按钮（参考 macOS 搜索框）、半透明玻璃材质 + 背景模糊/饱和度增强、
  细高光边与柔和内阴影、仅主操作使用强调色（系统蓝 #0A84FF）、深浅色主题自适应；
  预览图见 [`docs/preview-lock.png`](./docs/preview-lock.png)。
- **解锁动画**：指纹解锁 = 绿色柔光 + 指纹淡出 + 对勾描边动画；密码解锁 = 蓝色柔光 + 锁扣
  弹开 + 对勾描边动画，随后玻璃面板淡出；
- **忘记密码**：终端执行一条命令，密码恢复为默认密码 **4396**，重新打开 DSH 输入 4396
  解锁，再到设置里修改；
- **右上角一键锁定**：会话头部右侧工具区新增锁形按钮，点击立即锁定并呼出锁屏；
- **配置入口**：`设置 → 安全锁定`（修改密码、开关 Touch ID、立即锁定、查看重置命令）。

数据全部在本机：密码只以 scrypt 哈希形式保存在 `~/.dsh/dsh-lock/state.json`（权限 600），
不读取任何会话内容，不发起网络请求。

> A local lock screen for DeepSeek Harness Desktop on macOS: re-authenticate after every
> restart or 48 hours, with Touch ID via LocalAuthentication and a 4+ character password
> fallback. Settings live under Settings → 安全锁定.

---

## 环境要求

- **macOS**（在 macOS 27 / Apple Silicon 上验证），MacBook 且已录入 Touch ID 才能使用指纹解锁；
  没有 Touch ID 也可以只用密码；
- **DeepSeek Harness Desktop ≥ 0.2.0-rc.1**；
- Touch ID 由插件自带的原生小助手（`bin/dsh-auth-helper`，Swift + LocalAuthentication）实现，
  预编译为 arm64；Intel Mac 可执行 `scripts/build-helper.sh` 重新编译（需要 Xcode
  Command Line Tools）。

## 安装

插件以「本地 bundle」形式装进 DSH 的 profile（默认 `desktop`）。

### 方式一：让 DSH 里的 Agent 安装（推荐）

1. 把仓库放到固定目录（安装后不要移动；也可以用 Release 里的 zip 解压）：

   ```bash
   git clone https://github.com/SeyanaA/dsh-lock.git ~/dsh-lock
   ```

2. 在 DSH 里新开对话，对 Agent 说：

   > 把 `/Users/你的用户名/dsh-lock` 作为本地插件安装到当前 profile。

3. 如果界面没有立刻变化，**完全退出并重新打开** DeepSeek Harness。

### 方式二：手动安装

1. 把插件目录放到例如 `~/.dsh/local-plugins/dsh-lock`；
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 添加 `"dsh-lock": "link:/Users/你的用户名/.dsh/local-plugins/dsh-lock"`；
   - `dsh.profile.bundles` 追加 `"dsh-lock"`；
3. 在 profile 目录执行 `pnpm install`（或 DSH 自带 pnpm），重启 DSH。

## 使用

### 首次访问

安装并重新打开 DSH 后，界面会被锁屏覆盖：**设置解锁密码**（至少 4 位，内容不限）。
如果这台 Mac 支持并已录入 Touch ID，插件会**自动启用**（可在 设置 → 安全锁定 中关闭），
设置完成后即解锁。

### 日常解锁

锁屏出现后（不会自己弹任何窗口）：

- **轻触锁屏空白处**，或**按一次 Enter**，或点一下 **Touch ID** → 系统 Touch ID 面板出现，
  把手指放上去即解锁（无需再点按钮）；
- 也可以直接输入密码 + 回车解锁；
- 如果取消了指纹面板，可以再次轻触/按 Enter/点 Touch ID 重新唤起，或改用密码。

锁定触发条件：

| 条件 | 说明 |
| --- | --- |
| 每次启动 DSH | 进程启动即锁定 |
| 48 小时未验证 | 已解锁状态超过 48 小时，自动重新锁定 |
| 手动锁定 | 设置 → 安全锁定 → 立即锁定 |

### 一键锁定

DSH 会话头部右上角有一个锁形按钮（在模型/搜索等工具的最右侧）：点击它会立即锁定，
锁屏随即覆盖界面，并自动唤起 Touch ID。也可以从 `设置 → 安全锁定 → 立即锁定` 锁定。

### 忘记密码（强制恢复默认密码 4396）

在**终端**执行插件自带的重置命令：

```bash
~/.dsh/local-plugins/dsh-lock/bin/reset-password
```

（如果插件装在别的路径，可在 `设置 → 安全锁定 → 忘记密码` 里看到实际命令。）

执行后会提示“已恢复默认密码：4396”。回到 DSH（或重新打开 DSH），锁屏会要求输入密码，
输入 **4396** 解锁；解锁后请到 `设置 → 安全锁定` 修改为你自己的密码。

> 重置命令只改写插件自己的 `~/.dsh/dsh-lock/state.json`，不会动 DSH profile、会话或任何
> 其它数据；原状态文件会先备份为 `state.json.bak-时间戳`。

### 设置页

`设置 → 安全锁定`：

- 查看锁定规则、当前会话状态、上次验证时间、密码是否为默认密码、Touch ID 状态；
- 修改密码（当前密码 + 新密码 ≥ 4 位）；
- 开关 Touch ID（需要当前会话已解锁，且本机可用）；
- **立即锁定**；
- **忘记密码** 的重置命令。

## 忘记密码 / 重置流程（示意）

```text
$ ~/.dsh/local-plugins/dsh-lock/bin/reset-password
已恢复默认密码：4396
文件：/Users/you/.dsh/dsh-lock/state.json
现在重新打开 DSH（或切回 DSH 窗口），输入 4396 解锁；
解锁后请到 设置 → 安全锁定 修改为自己的密码。
```

## 故障排查

- **一直显示“正在读取锁定状态”**：说明插件宿主没有加载。重启 DSH；若仍不行，让 Agent
  移除 `dsh-lock` bundle（或手动从 profile 删除）后重启。
- **被锁住但暂时不想设置密码**：在终端执行重置命令（见上），然后输入默认密码 **4396**。
- **Touch ID 点了没反应**：确认本机已录入指纹、系统设置里“使用触控 ID 解锁”已开启；
  到 `设置 → 安全锁定` 确认 Touch ID 为“已启用”。系统面板本身也允许回退到 Mac 登录密码。

## 安全设计（含安全审核要点）

**入口与认证**

- 锁屏出现时**不主动弹出**任何系统验证窗口，只在用户明确手势后调用 `LocalAuthentication`；
- 指纹验证完全由 macOS 系统面板执行，插件不接触、不存储指纹数据；
- 系统面板允许回退到 Mac 登录密码（`deviceOwnerAuthentication` 语义，与系统一致）；
- 密码 → scrypt（随机盐，Node `crypto`）+ 常数时间比较（`timingSafeEqual`），只保存哈希；
- 密码长度下限 4 位、上限 256 位；连续错误 5 次后进入 30 秒起、逐级翻倍的冷却；
- 状态文件权限 `0600`，仅存哈希/时间戳，不含密码与会话内容。

**HTTP 面（本地路由）**

- 所有会改变状态的接口（setup/unlock/lock/password/biometric/report）都要求：
  `content-type: application/json` + 客户端标记头 `x-dsh-lock-client: 1` +
  同源 `Origin`（非本 DSH 源直接 403）+ 拒绝 `Sec-Fetch-Site: cross-site`；
  这样普通网页 / DNS-rebinding 无法锁定界面或刷指纹弹窗；
- Touch ID 唤起有节流：1.5 秒内最多一次、每分钟最多 5 次，避免弹窗轰炸；
- 响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；
- 请求体限制 16KB。

**已知边界**

- 这是**应用内 UI 锁**（防止旁人查看 DSH 内容），不是磁盘加密或系统账户保护；
- 能登录你的 macOS 账户、且能在终端操作的人可以重置状态文件绕过锁屏——这是找回密码的
  设计代价（恢复命令本身也依赖本机账户权限）；
- DSH 的其它本地接口不在本插件保护范围内。

## 卸载

- 让 Agent 调用 `plugin_manager` 的 `remove_bundle`（target：`dsh-lock`）；或
- 手动删除 profile `package.json` 中 `dsh-lock` 的两处引用并 `pnpm install`，重启 DSH；
- 需要的话再删除状态目录：`rm -rf ~/.dsh/dsh-lock`。

## 开发与测试

```bash
node test/run.mjs
```

- `test/host-lock.mjs`：首次设置、解锁、错误次数锁定、48 小时重锁、重启锁定、改密码、
  默认密码 4396 重置等状态机逻辑；
- `test/client-render.mjs`：mock ModuleLoader/React 下验证 `shell.overlay` 与
  `settings.section` 注册、锁屏各模式、设置页内容与上报。

重新编译 Touch ID 小助手（需要 Xcode Command Line Tools）：

```bash
./scripts/build-helper.sh
./bin/dsh-auth-helper --check   # 输出 available 表示本机可用
```

## License

[MIT](./LICENSE) © 2026 SeyanaA
