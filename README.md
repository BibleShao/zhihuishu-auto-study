# 智慧树自动学习脚本

面向智慧树（zhihuishu.com）学习页的 Tampermonkey / Violentmonkey 用户脚本。它把课程视频的 1.5 倍速与学习时长上报、随堂 AI 练习的识别作答与关闭、播完自动切换下一节、平台弹窗处理整合成一条低干扰的本地流程，覆盖含 AI 随堂测验的课程类型。

脚本只在本机浏览器内运行，不上传课程数据；不绕过登录、验证码和平台风控。登录由使用者本人完成，遇到易盾验证时会暂停自动操作并等待人工处理。

- 当前版本：1.8.0
- 脚本文件：[`zhihuishujiaobenbysjy.user.js`](./zhihuishujiaobenbysjy.user.js)
- 许可证：MIT

## 它解决什么问题

### 1. 自动切换下一节时的“噪音干扰”

智慧树新学习页把“切下一节”做成了一条带前置条件的异步链路，任何一环没对上都会表现为“点了没反应”，而且不报错。

**保存接口在途时静默丢弃**

站点函数 `qt` 的第一行是 `if (j.value) return;`。`j.value` 表示本节学习进度上报仍在途；此时点击目录或触发切换会被直接丢弃，既不弹提示也不重试。只有 `saveLearningDBInTime` 成功返回后，站点才会执行真正的节点切换。脚本的处理方式是：

- 切换前等待播放器 `playerNext` 就绪（实测目录约 3.0 秒就绪、播放器约 3.9 秒注册，中间存在空窗）；
- 首选官方 `playerNext`，失败后间隔 1.5 秒重试一次；
- 仍未生效时再点目录，并在 1.2 秒后重试一次；
- 记录保存接口的状态、业务 `code`、耗时和近似在途标志，便于判断是否撞上了在途窗口。

**两级目录与 `current` 误判**

目录中带小节的课时，父级 `.chapter-item` 永远不会是 `current`，真正高亮的是内部的小节 `.chapter-content-second`。如果按父级下标判断“当前节点”，同父级内切换小节时签名不变，脚本会误以为没有切换成功，进而重复点击或触发刷新。脚本会先把目录拍平成“真正可播放的节点”，再按 `current` 与 `.finish-icon` 判断当前项和目标项。

**平台弹窗打断切换**

站点的保存结果会把不同原因映射成不同弹窗：

| 业务 code / 状态 | 站点行为 | 脚本处理 |
| --- | --- | --- |
| `0` | 保存成功，允许切换 | 正常继续 |
| `-10` | 提示“同时播放多个视频” | 记录并识别提示，尝试关闭；不强行继续 |
| `-12` | 弹出易盾验证码 | 暂停自动操作，等待人工验证 |
| `-9` | 学习时长相关提示 | 记录并识别提示 |
| `403` | 会话/权限异常 | 记录提示，不绕过 |
| 其他 | 网络异常提示 | 记录并识别提示 |

脚本不会绕过验证码。识别到易盾或“请完成验证”时会主动暂停，避免在错误状态下继续点击。

**倍速只加速了本地视频，没有加速学习时长**

只设置 `video.playbackRate = 1.5` 时，视频播放变快，但站点计时器仍按 1.0 倍累计学习时长，服务器收到的进度并不会同比增加。脚本会额外调用播放器回调 `callback.playbackRate(1.5)`，让站点的 `K.value` 同步为 1.5，从而让上报的学习时长按 1.5 倍累计。

站点会检测超过 1.8 倍的播放速率并判定异常，因此脚本把目标倍速上限限制在 1.75，默认 1.5。

**目录切换失败后的误判与刷新环**

旧版本用父级下标作为“当前节点签名”，并且依赖定时刷新恢复状态；在保存请求在途、目录异步刷新或站点自行切换时，容易出现“实际已经切了但脚本还在点”或“刷新后回到原节点”的循环。当前版本改为：

- 使用可播放节点的下标 + 标题作为签名；
- 切换后同时轮询 `current` 高亮与视频 `src` 变化；
- 在点击前再次确认站点是否已经自行完成切换，避免迟到切换造成双跳；
- 不再依赖定时刷新。

**播放器启动时序**

目录渲染与播放器注册不是同一时刻完成的。脚本在切换前最多等待 8 秒，让 `PlayerStarter` / `ablePlayerX` 注册出 `playerNext`；如果等不到，会在日志中明确说明，而不是静默失败。

### 2. AI 随堂界面的隐式功能问题

含 AI 随堂测验的课程会在播放过程中弹出 `.ai-class-exercise-dialog`。这个弹窗有几个隐式行为：

- 弹出后遮挡播放器，视频实际上被暂停或无法继续，但界面不一定给出明显的“跳过”入口；
- 不处理它，自动切换下一节会一直卡住；
- 提交后还会出现结果弹窗或遮罩，需要再关闭一次才能恢复播放；
- 弹窗停留过久时，没有任何自动恢复机制。

脚本的处理链路是：

1. 通过 DOM 变化监听和 5 分钟巡检发现弹窗；
2. 解析题型、题干与选项；
3. 按“本地题库 → 可选 AI 接口 → 本地启发式规则”的顺序给出答案；
4. 点击选项并提交；
5. 关闭结果弹窗；
6. 依次尝试右上角关闭、Escape、点击遮罩关闭；仍失败时在超时后强制隐藏弹窗与遮罩，恢复页面滚动和播放。

本地题库会按题干归一化后缓存在 `GM_getValue` / `localStorage`，可通过 `zhsAuto.bank` 读写。

## 功能一览

- 1.5 倍速播放，并向站点上报倍速（学习时长按同倍率累计）；
- 随堂 AI 练习自动识别、作答、提交与关闭；
- 本节完成后自动切换下一节，优先官方 `playerNext`，失败时目录点击兜底并重试；
- 两级目录拍平，正确处理“父级永远不是 current”的课程结构；
- 识别多视频、学习时长、易盾验证码、网络异常等平台提示；遇到验证码主动暂停；
- 内置低噪音诊断日志与手动调试接口；
- 右下角面板可暂停、手动下一节、手动处理弹窗、折叠日志。

## 安装

### 1. 安装用户脚本管理器

任选其一：

- [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari）
- [Violentmonkey](https://violentmonkey.github.io/)

Chrome 在 Manifest V3 下通常需要在扩展管理页开启“开发者模式”，否则用户脚本可能不会执行。

### 2. 安装脚本

方式 A：直接打开 raw 地址，脚本管理器会进入安装页：

```text
https://raw.githubusercontent.com/CNsjy2008/zhihuishu-auto-study/main/zhihuishujiaobenbysjy.user.js
```

方式 B：在脚本管理器中新建脚本，把 [`zhihuishujiaobenbysjy.user.js`](./zhihuishujiaobenbysjy.user.js) 的完整内容粘贴进去并保存。

### 3. 打开课程学习页

登录智慧树后进入课程学习页。脚本会自动开始工作，右下角出现“智慧树自动学习”面板。

## @match 覆盖范围

| `@match` | 说明 |
| --- | --- |
| `https://wisdom-mooc.zhihuishu.com/study/*` | 新版课程学习页，主要支持目标 |
| `https://wisdom-mooc.zhihuishu.com/*` | 同域其他页面，便于面板与诊断接口可用 |
| `https://studyh5.zhihuishu.com/videoStudy.html*` | 旧版学习页。目录结构与新页不同，自动切换仅做兼容尝试；倍速与网络诊断仍可用 |

如果智慧树后续更换学习页域名或路径，需要在脚本头部补充对应的 `@match`。

## 使用方法与面板

脚本加载后，右下角面板提供四个操作：

| 按钮 | 作用 |
| --- | --- |
| 暂停 / 继续 | 暂停或恢复自动答题、自动切换、倍速维持等操作 |
| 下一节 | 立即执行一次完整的切换流程（`goNext`） |
| 处理弹窗 | 当前有随堂练习弹窗时立即识别并处理 |
| 折叠 | 收起或展开日志区域 |

日志区域 `#zhs-auto-log` 默认输出关键事件。脚本启动时会打印目录摘要与播放器就绪状态；切换失败时会打印失败原因和平台提示。

### 配置

脚本顶部的 `CONFIG` 可直接修改：

```js
const CONFIG = {
  rate: 1.5,                       // 目标倍速，上限 1.75
  checkInterval: 5 * 60 * 1000,    // 随堂问答巡检间隔
  quizTimeout: 60 * 1000,          // 弹窗超时后强制关闭
  autoNext: true,                  // 是否自动切换下一节
  ai: {
    enabled: false,                // 是否启用外部 AI 作答
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini'
  }
};
```

不配置 `ai.apiKey` 时，脚本只使用本地题库与启发式规则，不产生任何外部请求。

## `window.zhsAuto` 调试接口

脚本会把接口同时挂到沙箱 `window` 和页面 `unsafeWindow`。在 Tampermonkey 的脚本控制台或页面 DevTools 控制台中可直接调用。

### 诊断开关

```js
zhsAuto.debug = false;   // 0：关闭诊断日志，只保留自动化流程日志
zhsAuto.debug = true;    // 1：关键诊断（默认，低噪音）
zhsAuto.debug = 2;       // 详细：额外输出请求发送行、响应体片段、完整目录
zhsAuto.debug = 'verbose';
```

默认值为 `1`。关键诊断包括：保存接口结果、`canJumpChapter` / `lastViewVideoId` 变化、一次目录摘要、一次播放器摘要。

### 方法

| 接口 | 说明 |
| --- | --- |
| `zhsAuto.next()` | 执行完整自动切换流程（等待完成标记、`playerNext`、目录兜底与重试） |
| `zhsAuto.nextRaw()` | 只调用播放器的 `playerNext`，返回 `{ ok, path, attempts, notes, arrayLen, ableType }` |
| `zhsAuto.nextCheck(timeoutMs)` | 调用 `playerNext` 并轮询 `current` 是否变化，返回切换结果 |
| `zhsAuto.clickNode(i)` | 点击目录中第 `i` 个可播放节点（非冒泡 MouseEvent） |
| `zhsAuto.clickAndCheck(i, opts)` | 点击并轮询 `current` 变化；`opts.title` 为真时同时点标题 |
| `zhsAuto.clickTitle(i)` | 冒泡点击第 `i` 个节点的标题，作为最后的兜底 |
| `zhsAuto.handleQuiz()` | 立即处理当前随堂练习弹窗 |
| `zhsAuto.dump()` | 打印完整目录（序号、类型、`current`、`finish`、父级状态） |
| `zhsAuto.probe()` | 返回播放器注册详情：`PlayerStarter`、`ablePlayerX`、`playerNext`、`playerArray` |
| `zhsAuto.snapshot()` | 返回当前节点、`canJumpChapter`、`lastViewVideoId`、在途标志、视频状态、提示框 |
| `zhsAuto.watch(true, 3000)` | 每 3 秒打印一次状态；`watch(false)` 停止 |
| `zhsAuto.tips()` | 当前可见的 Element Plus 提示/弹窗文本 |
| `zhsAuto.videoInfo()` | 当前视频的 `src`、时间、时长、暂停、倍速、结束状态 |
| `zhsAuto.catalog()` | 返回目录拍平后的节点数组 |
| `zhsAuto.config` | 当前配置对象 |
| `zhsAuto.bank.get()` / `.set(obj)` / `.clear()` | 本地题库读写 |
| `zhsAuto.net` | 诊断状态：`records`、`inflight`、`last` |
| `zhsAuto.log(msg)` / `zhsAuto.diag(tag, msg, level)` | 写入面板与控制台 |

常用示例：

```js
// 看当前目录与节点编号
zhsAuto.dump();

// 看是否能直接走播放器官方下一节
zhsAuto.nextRaw();

// 看保存接口/在途标志/提示框
zhsAuto.snapshot();

// 切换失败时连续观察 10 秒
zhsAuto.watch(true, 2000);
```

### 日志标签

| 标签 | 内容 |
| --- | --- |
| `AUTO` | 自动化关键流程（始终输出） |
| `NET` | 保存、最后学习视频、学习时长限制等接口的状态、`code`、耗时、近似在途标志 |
| `PLAYER` | `PlayerStarter` / `ablePlayerX` 是否注册、`playerNext` 是否存在 |
| `CAT` | 目录节点数、`current` 命中、节点明细 |
| `NEXT` | `playerNext` 调用结果与切换轮询结果 |
| `CLICK` | 目录点击目标、点击前后 `current` 对比 |
| `BOOT` | 启动自检与诊断级别变化 |
| `SNAP` / `STATE` / `WATCH` | 快照、周期状态、观察开关 |

`NET` 中的 `inflight` 是按接口关键字统计的近似在途值，不是直接读取站点闭包里的 `j.value`；它用于判断“请求是否还没结束”，不能替代站点内部状态。

## 诊断能确认什么、不能确认什么

**可以确认**

- `saveLearningDBInTime` 的 HTTP 状态、业务 `code`、耗时与响应体；
- 当前目录的可播放节点、`current` 命中的节点、是否带 `.finish-icon`；
- `PlayerStarter.get('container'|'vid')` 是否存在，`callback.playerNext` 是否可用；
- 调用 `playerNext` 是否抛异常、返回什么、切换后 `current` 是否变化；
- 当前视频 `src`、播放时间、暂停状态与倍速；
- 页面上可见的提示框、验证码弹窗文本。

**不能直接确认**

- 站点闭包内部的 `j.value` 真实值；只能用请求在途近似判断；
- `canJumpChapter` 的完整 Vue 内部状态；脚本从 `queryStudiedTimeLimitInfo` 响应中提取，若该接口未调用或字段缺失则显示 `unknown`；
- 账号维度的跨章策略、教师端的课程限制；
- 平台是否在更底层做了未暴露的检测。脚本只根据可观测的 DOM 与网络结果行动。

## 已知限制

1. **不绕过登录、验证码或风控。** 遇到易盾或“请完成验证”时脚本会暂停自动操作，需要人工完成后继续。
2. **同一账号只建议打开一个课程学习页。** 多个页面/多个播放器同时播放会触发站点的“同时播放多个视频”限制（`-10`），这不是脚本能规避的。
3. **倍速上限为 1.75。** 站点检测超过 1.8 会判定异常并跳转首页，默认 1.5 更稳妥。
4. **随堂练习答案不保证正确。** 本地启发式规则与外部 AI 都可能答错；题库命中时优先使用题库。使用者需自行确认答案是否符合课程要求。
5. **旧版学习页只做兼容尝试。** `studyh5.zhihuishu.com/videoStudy.html` 的目录结构与新页不同，自动切换不保证生效。
6. **页面结构变化会导致失效。** 脚本依赖 `.chapter-item`、`.chapter-content-second`、`.finish-icon`、`.ai-class-exercise-dialog` 等选择器，平台改版后需要更新。
7. **浏览器后台节流。** 页面最小化或浏览器休眠时，定时器与视频播放可能被节流，自动流程会变慢或暂停。
8. **`canJumpChapter` 可能未知。** 如果站点没有调用 `queryStudiedTimeLimitInfo`，或响应结构变化，脚本无法判断跨章许可，跨章切换仍可能被站点拒绝。
9. **合并版的验证范围。** 1.7 修复逻辑与诊断埋点此前在真实学习页验证过；1.8.0 合并版通过 `node --check` 语法校验。不同账号、课程和地区仍建议先观察一段日志再长期挂机。

## 免责声明

本项目仅供学习、研究与个人自动化实践使用，与智慧树及其关联公司没有任何关系，也未获得其授权。

使用本脚本可能违反平台的服务条款或学校的学习规定，可能导致账号被限制、课程进度异常或其他后果。是否使用、如何使用以及由此产生的全部责任由使用者自行承担。作者不对任何直接或间接损失作出保证或承担责任。

请遵守所在学校与平台的学习规则；不要将本脚本用于代替本人完成应当由本人完成的学习任务，也不要用于商业用途或规避平台的安全验证。
