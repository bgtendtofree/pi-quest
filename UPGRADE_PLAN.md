# pi-quest 升级计划

状态：P1/P2 已实施；P3 实验接线与真实模型小样本检验已实施，尚未证明批处理收益，默认关闭。
验收以当次 `mise run ci` 和交付记录为准。
本文不授权安装第三方插件或修改用户 Pi 配置。

## 1. 定位与边界

pi-quest 只做单目标模式：

> 用户设置目标 → agent 持续工作 → 独立 skeptic 验证 → 完成、继续或暂停。

升级目标：

- agent 随时知道当前目标、验证缺口和剩余轮数。
- 完成判定更可解释，验证失败不再表现为无原因的继续。
- 在不削弱独立验证的前提下，测量并减少验证开销。
- 保持 `/goal <objective> [--max-turns N]` 和现有控制命令可用。

不做：多 goal 队列、任务树、代理舰队、工作流 DAG、PR/合并自动化、定时调度。
不将 goal 限定为编码或“CI 全绿”；文档、研究等目标也要可验证。

## 2. 当前基线

当前工作区已有 Pi 1.0.1 适配改动；先独立验证、评审这批改动，再叠加新功能。

保留：

- `agent_before_settle` 原生续跑；JSON/RPC 不在 goal 中途报最终结束。
- 每个可验证的工作轮次使用独立 skeptic，不接受主 agent 自行宣布完成。
- 缺口指纹停滞检测、最大续跑轮数、用户输入暂停、取消和过期结果保护。
- 分支内 session entries 持久化；恢复与 `/tree` 不自行启动。
- 验证基础设施失败保持 unverified，不能误判 complete。

已知缺口：

- `/goal status` 主要面向用户，没有模型可查询的目标工具。
- verdict 只有结论和缺口，缺少可追溯的验证记录。
- skeptic 失败原因被上层吞掉；用户只能看到继续或最终触顶。
- 只有续跑轮数上限，没有验证耗时、token 或费用统计。
- verifier 默认禁用全部扩展，包括原生 codemode。

此前验证基线：60 项测试通过，`mise run ci` 通过。后续每阶段重新验证，不复用旧结论。

## 3. P1：目标可查询，验证可解释

本阶段是下一批推荐实施范围。先补目标协议，不增加编排能力。

### 3.1 增加一个只读工具 `quest_get_goal`

- 无目标时明确返回无目标，不抛异常。
- 返回 objective、状态、suspended、当前轮次、剩余续跑次数、上次缺口和暂停原因。
- 使用插件前缀，避免与其他 `/goal` 插件的 `get_goal` 工具重名。
- 返回有界快照，不能通过引用修改内部状态。
- 不提供模型创建、替换、恢复或直接完成目标的权限。
- 接入 Pi 原生工具注册机制；原生 codemode 可调用，不写专门桥接层。

### 3.2 记录最近一次验证摘要

在现有 GoalState 中增加可选的最近验证记录，而不是另建存储系统：

- 结果分类：verified-achieved、verified-incomplete、unverified。
- 轮次、耗时、实际 verifier 模型、缺口或失败原因。
- 错误原因至少区分超时、进程失败、模型失败、输出无效。
- 错误文本截断、脱敏；不持久化凭据、完整 stdout 或环境变量。

`/goal status` 和 `quest_get_goal` 展示摘要。取消与目标替换属于控制行为，不记为普通验证失败。
沿用每轮验证和 fail-open 策略；本阶段不增加自动重试，不改变停滞阈值。

### 3.3 让 verifier 逐项解释完成条件

- 从用户 objective 提取待验证要求；隐含或含糊要求不能凭空补成已满足。
- 提示区分“已验证”“未验证”“未满足”，缺口须指向具体要求。
- 编码目标使用测试、构建、文件检查等证据；其他目标使用对应的可检查产物。
- 不把“已有一项检查通过”当成“整个目标完成”。
- 模型文本中的命令和结果仅是陈述，不视为执行器确认的证据。

第一版仍用自然语言 objective，不增加任务树、验收 DSL 或复杂命令语法。

### P1 验收

- 只读工具在无目标、active、暂停、blocked、complete 下均返回正确状态。
- 查询不启动 agent、不消耗续跑次数、不修改目标；codemode 嵌套查询行为一致。
- 失败原因可见；旧 session 缺少新字段仍可恢复。
- 暂停、清除、替换、分支切换后的旧验证不能回写新记录。
- 文档目标和编码目标均有案例；未验证要求不能被当成已验证。
- `mise run check`、`mise run ci` 通过。

预计涉及：`src/index.ts`、`src/verifier.ts`、现有测试、`README.md`。

## 4. P2：验证证据与开销

P1 完成后再实施。只存排错和评估所需数据，不建 observability 平台。

实施口径：

- `lastVerification.records` 采集真实子进程 JSONL 工具事件，每次最多保留 20 条；
  缺失退出码、未完成调用、事件流缺失、输出截断均不伪装成通过。
- 调用、参数、输出只保留 SHA-256 指纹，非可恢复日志路径；
  不持久化原始命令、stdout、stderr 或原生日志路径。
- 完整日志尚未证明必要，按第 8 节先只做摘要；不创建日志缓存或删除用户原生产物。
  摘要随 session 历史保留，clear 写 tombstone 而非擦除历史；删除 session 文件才删除历史摘要。
- `accounting.main` 按目标关联的 assistant turn 统计，含预算结束总结；
  `accounting.verifier` 按独立验证尝试统计，含 diff/子进程/解析时间。
- 只计 final assistant usage 和顶层 tool-result 汇总 usage；不累加流式增量、
  重复 transcript 或嵌套 tool-execution usage。取消/过期尝试只保留开始计数，缺失耗时/usage 显示未知。
- 保留 token 分项与报告覆盖计数；费用是 Pi 估算，零值占位或缺失显示未知，已知小计标记 partial。
  compaction、branch summary、cache warming 和未报告的脚本/嵌套模型费用不在统计范围。
- 不增加费用硬预算，不因任意命令失败替换 skeptic 的整体目标裁决，不启用 P3。

### 4.1 验证证据

- 从实际 Pi 子进程事件收集检查记录，不从最终回复反推“已经执行”。
- 先核实 Pi 1.0.1 的事件和 bash 结果字段；缺失、截断、失败均明确标记。
- 摘要至少保留检查来源、结果及证据引用；无法证明通过时不得填成通过。
- 如需完整日志，使用 Pi 管理的本地产物目录，不污染用户工作树。
- 日志有大小、保留期和删除规则；session 只存摘要及引用。
- 日志丢失不触发自动续跑，也不能成为完成证明。

这些记录提高可追溯性，不等于所有检查结果已由插件独立复核。

### 4.2 开销统计

- 分开统计主 agent 和 verifier，明确口径和可用字段。
- token、费用只有运行时报告时才显示；缺失不能显示为零。
- 同一 assistant 响应只统计一次，嵌套工具调用不重复计费。
- verifier 汇总整个验证运行，不能只统计最后一条 assistant 消息。
- 先显示耗时与可获得的 usage，再决定是否需要额外预算控制。

### P2 验收

- 多轮 verifier、codemode 嵌套调用、失败和取消不造成重复统计。
- 实际检查失败与最终文本宣称成功发生冲突时，记录不能把检查改为通过。
- 非编码目标不被迫执行测试命令。
- 日志截断、路径不可用和 usage 缺失均有测试。
- `mise run check`、`mise run ci` 通过。

## 5. P3：可选使用原生 codemode

只有 P2 的记录足够比较开销后才实施。不是功能升级的前置条件。

实施口径：

- 新增调用级 `--quest-verifier-codemode`，默认 false；不修改主会话工具或用户配置，不持久化自动启用状态。
- 子进程保持原有隔离参数、工具 allowlist 与验证路径，只显式添加 codemode。
  `src/verifier-codemode.ts` 使用公开 `createCodemodeExtension({ models: false, mode: "only" })`。
  启用后只向模型声明 codemode；原来的检查工具仍在 allowlist 中，通过脚本调用。
  旧 `mode: "on"` 只是额外开放能力，不构成真正的 code-only 路径对照，已纠正。
  不直接使用 `builtin:codemode` 别名：该别名默认开放 `models.*` 且无 CLI 关闭选项；
  薄适配文件是关闭额外模型能力所需的最小方案，不迁移 SDK verifier 或重写执行器。
- 回执识别 codemode，嵌套调用保留 parentRef；原生溢出日志只留经校验的 os.tmpdir 文件名引用。
  不建日志缓存、不存原始输出、不读取/删除原生日志；缺失日志不影响目标状态。
- `test/codemode.test.ts` 固定对照目标如下。原生工具实际执行，chat 回复与 usage 均为 mock：

| 目标 | direct / codemode 结果 | 原始工具覆盖 |
|---|---|---|
| 文档完成 | achieved / achieved | 相同的两次读取 |
| 文档缺少来源 | incomplete / incomplete | 相同的两次读取，不强制测试 |
| 两项检查成功 | achieved / achieved | 相同的两项命令 |
| 一项检查失败 | incomplete / incomplete | 相同命令，保留 exit 7 |
| 模型只宣称成功、漏检查 | mock 判 incomplete / incomplete | 均无真实检查，回执不从文本反推 |
| 脚本失败 | incomplete / incomplete | 原始检查仍保留，codemode 外层失败另记 |

- 对照输出耗时、assistant 往返与报告 usage。mock 中批量调用可以减少往返，
  但未包含真实模型时延、提示成本或模型选择行为，不据此宣布省钱/加速或默认上线。
- 集成覆盖真实嵌套取消、models.* 关闭、输出溢出引用；JSON/RPC SDK 验证完成、
  预算总结、停滞均只发一次最终 settlement。打包 smoke 检查显式 adapter 加载与无递归 goal controller。
- 已进行用户授权的 DeepSeek Flash 小样本实测，见下节；**没有证明可重复收益，默认继续关闭。**

范围：

- 主会话由用户自行启用 codemode；quest 不修改全局工具选择。
- verifier 可选显式加载原生 codemode，保留原来的工具 allowlist；
  需关闭 models.* 时使用上述公开 factory 适配，不直接使用默认开放模型的别名。
- 不安装第三方 codemode，不自行实现 JS/TS 执行器。
- 只建议批量读取、输出筛选及互不干扰的检查；共享构建目录的命令不能盲目并行。
- 保留退出码、失败摘要和完整日志引用，不能只返回模型生成的“通过”布尔值。
- goal 状态机仍在确定性扩展代码中，不能交给生成脚本管理。

权限与成本：

- QuickJS 限制脚本直接访问 Node，不限制 `bash` 或被调用检查脚本的副作用。
- 原生 codemode 默认还暴露 `models.*`。启用前明确费用边界；
  若需关闭，应通过公开 `createCodemodeExtension({ models: false })` 能力实现，
  不读取私有 runtime 字段，也不为了这个选项重写整个 verifier。
- 不附带开启 MCP、子代理派生或其他环境中的插件。

### P3 上线门槛

对同一组固定目标比较现有路径和 codemode 路径：

- 目标完成情况、假完成案例、检查遗漏、停滞退出。
- 验证耗时、模型往返、可报告 token/费用。
- 检查覆盖不能下降；若没有可重复的收益，继续保持默认关闭。
- 覆盖原生嵌套工具事件、取消和 JSON/RPC 最终 settlement 的集成测试。

### DeepSeek Flash / off 历史小样本（2026-10-04 UTC）

**方法修正：用户保存的是 `max`，先前擅自固定 `off` 偏离实际用法。
以下数据只适用于 off 工况，不能用于判断用户常用模式的收益，更不能据此判定 codemode 不值得用。**

- 使用用户现有 Pi 配置与凭据，模型 `deepseek/deepseek-flash`，两组均 `--thinking off`。
  不改用户配置，不启用 models.*；实际调用 `createSkepticVerifier` 与宿主 Pi 1.0.1 CLI。
- 四类临时目标：文档齐全、缺少必需来源、代码与两项检查通过、代码错误导致测试失败。
  文档只要求本地文档与来源引用，不要求测试或网络抓取；固定文件还含一份无证据的“全部完成”报告。
  每次在独立目录执行，不修改仓库；本次只比较 verifier，不是整个自主循环的长程压力测试。
- 首批两轮、交替组序，共 16 次。原解析器正确接收 direct 7/8、opt-in 6/8；
  三次误拒均为 `achieved=true, gaps=[], model_fixable=false, blocker=null`。
  修复仅让完成目标忽略不相关的 fixability；仍拒绝有 gaps/blocker 的完成声明。
  原始 16 次响应用修复后解析器复核，均符合样例预期，不等同于重新调用模型。
- 修复后再实际调用 8 次，两组各四类目标一次。目录编号不透露预期结果；
  对提供的全部六个文件做运行前后 SHA-256 比较，8/8 未改变。以下仅统计这批新调用：

| 指标 | direct（4 次） | codemode 开放（4 次） |
|---|---:|---:|
| verdict 符合固定样例预期 | 4/4 | 4/4 |
| unverified / 假完成 | 0 / 0 | 0 / 0 |
| 平均 verifier 耗时 | 8.824 秒 | 10.217 秒 |
| assistant 回复总数 | 18 | 22 |
| input / output tokens | 11,325 / 3,948 | 14,373 / 4,158 |
| cache-read / cache-write tokens | 39,808 / 0 | 63,616 / 0 |
| 报告 total tokens | 55,081 | 82,147 |
| Pi 估算费用（USD） | 0.008374 | 0.009683 |
| 实际 codemode 调用 | 0 | 0 |

- 本批 opt-in 平均慢约 15.8%，估算费用高约 15.6%；不能当统计显著的性能结论。
  首批反而平均快约 7.1%，但 tokens 和费用更高。缓存、网络、模型策略与提示修复均是混杂因素。
  **“允许 codemode”不等于“强制走 codemode”**：所有 12 次 opt-in 中，仅一次真正调用它（四个脚本）。
  所以这次主要测到能力开放后的模型行为/提示开销，未证明批处理本身收益。
- 缺源与失败测试样例均未假完成。代码目标有检查执行记录；部分 bash 命令用输出捕获或
  `; echo ...` 返回外层 exit 0，不能据此声称内部测试通过。verdict 仍依据实际失败输出/实现给出未完成。
  回执的 exitCode 指外层实际工具调用，不从文字反造子命令退出码。
- 24 次合计 Pi 估算费用约 **USD 0.054032**，按当前模型价格与服务报告 usage 计算，不是供应商账单。
  私有原始事件和手工 harness 留在 `/tmp/pi-quest-live.Ij00Xa/`，没有复制凭据或原始输出进仓库。
- 样本小、目标简单、只测一个模型与 off thinking；无分类器/图像调用，无强制脚本策略。
  不据此泛化模型准确率或默认启用；需要更多真实批处理场景、受控缓存与重复测量才重新评估。

### DeepSeek Flash / max / on 历史复测（2026-10-04 UTC）

- 通过公开 SettingsManager 只读取思考档位：无 DeepSeek Flash 专用覆盖，保存的默认档为 `max`。
  不指定 `--thinking` 的原生 RPC `get_state` 也确认模型为 `deepseek/deepseek-flash`、档位 `max`。
  两组随后统一显式 `--thinking max`，其他生产 verifier 参数、目标和文件保持一致。
- 四类目标重复两轮，交换两组顺序，先跑 16 次。手工 harness 的额外 8 次回复上限
  提前截断两次 opt-in 代码成功样例；这是实验限制，不是生产 verifier 的失败。
  删除这个额外上限，按生产 600 秒超时重跑受影响的**两对、共四次**。
  原两对的全部四次结果都排除，避免只替换失败的一侧；总共付费 20 次，正式比较保留 16 次。
- 全部 16 个完整比较结果均包含实际 thinking 块，原始六个文件的前后指纹一致。
  没有强制模型使用 codemode，没有修改用户配置或开启 models.*。

| 指标 | direct（8 次） | codemode 开放（8 次） |
|---|---:|---:|
| verdict 符合固定样例预期 | 8/8 | 8/8 |
| unverified / 假完成 | 0 / 0 | 0 / 0 |
| 平均耗时 | 21.782 秒 | 22.848 秒 |
| assistant 回复总数 | 51 | 52 |
| input / output tokens（output 已含 reasoning） | 40,682 / 29,526 | 40,761 / 31,700 |
| cache-read / cache-write tokens | 216,192 / 0 | 251,136 / 0 |
| 报告 total tokens | 286,400 | 323,597 |
| Pi 估算费用（USD） | 0.048933 | 0.051775 |
| 实际 thinking 块 | 48 | 51 |
| 完整比较结果中的 codemode 调用 | 0 | 0 |

- 被额外上限截断的一次 max 样例实际调用了七个 codemode 脚本，因此不能说 max 模型不会用它，
  也不能从这些截断结果推断完成能力或公平比较耗时。其他完整小样例仍选择直接工具；
  思考开启不保证选脚本，工具选择还受任务规模、输出大小与可用直接工具影响。
- 正式完整比较中，开放组平均慢约 4.9%、估算费用高约 5.8%。这是可选工具开放后的行为数据，
  **不是脚本批处理路径性能对照**，样本小且缓存/网络未控制，不代表模型普遍能力或统计显著差异。
  不能再用 off 或本批小样例替批处理收益下结论。
- 本批全部 20 次 Pi 估算费用 **USD 0.131589**，含排除结果；
  加此前 off 的 24 次，总共 44 次、估算 **USD 0.185621**，均非供应商账单。
  原始私有事件在 `/tmp/pi-quest-live.Ij00Xa/thinking-max/` 与 `max-confirm/`，
  成对替换后的摘要在 `/tmp/pi-quest-live.Ij00Xa/thinking-max-summary.json`。
- 默认实验开关暂不改变。下一次性能评估需实际适合批量读取/大输出筛选的目标；
  分开衡量“允许模型选 codemode”的采纳行为与“实际脚本执行”的耗时/覆盖，
  后续已将 adapter 改为原生 `mode: "only"`，不与本节旧 `mode: "on"` 数据混称。

### DeepSeek Flash / high / code-only（2026-10-04 UTC）

- 按用户要求统一 `--thinking high`，不再用 max。实验开关仍为 opt-in，但启用后的
  adapter 改为原生 `{ models: false, mode: "only" }`：模型只看到 codemode，
  五个检查工具只能经脚本调用。主会话工具和用户配置不变。
- SDK 回归逐轮回放系统消息的 toolsAdded/toolsRemoved，断言 opt-in 声明仅有 codemode；
  同时断言脚本可调用的工具仍恰好属于原 allowlist，保留嵌套父引用、失败、取消与单次 settlement。
- 第一批 high/only 共 16 次，所有 opt-in 都真实执行脚本，但一次成功代码样例保守阻塞：
  要求证明 fixtures 未改，却没有 baseline 可对照。先前手工样例不能把 verifier 无法获得的
  原始文件事实当作已验证；这不是通过放宽 verifier 来修。
- 给每个样例创建独立临时 Git 仓库与初始 commit，将 baselineCommit 传入生产 verifier。
  两组同样具备原始内容参照；不修改目标文字、不设置回复次数限额，保持生产 600 秒超时。
  四类目标各两轮、交替组序，完整重跑 16 次。以下只比较**有 baseline 的这批**：

| 指标 | direct（8 次） | code-only（8 次） |
|---|---:|---:|
| verdict 符合固定样例预期 | 8/8 | 8/8 |
| unverified / 假完成 | 0 / 0 | 0 / 0 |
| 平均耗时 | 9.427 秒 | 11.110 秒 |
| assistant 回复总数 | 33 | 37 |
| input / output tokens（output 已含 reasoning） | 23,453 / 10,823 | 27,053 / 12,492 |
| cache-read / cache-write tokens | 77,824 / 0 | 101,888 / 0 |
| 报告 total tokens | 112,100 | 141,433 |
| Pi 估算费用（USD） | 0.020490 | 0.023718 |
| codemode 实际执行次数 | 0 | 29 |
| 经脚本执行的 opt-in 样例 | — | 8/8 |
| opt-in 绕过脚本的直接检查调用 | — | 0 |

- 全部正式样例有实际 thinking 输出，六个文件前后指纹一致。缺少来源与失败测试均未假完成。
  这是实际路径对照，不再是“是否愿意选择可选工具”的测量。
- 这些极小目标下，code-only 平均慢约 17.9%、估算费用高约 15.7%；样本小、缓存/网络未受控，
  不据此泛化大型批量读取或筛选任务。code-only 路径功能可用，实验开关保持可显式启用。
- 本批有效比较估算费用 USD 0.044208；两批 high 的 32 次合计 USD 0.098999。
  连同历史 off/max，本次累计 76 次、Pi 估算 USD 0.284619，均非供应商账单。
  原始私有事件分别在 `/tmp/pi-quest-live.Ij00Xa/high-code-only/`（无 baseline，历史）
  与 `high-only-baseline/`（正式比较）；不复制凭据或原始输出到仓库。

## 6. 暂缓项

| 项目 | 为什么暂缓 | 何时重新考虑 |
|---|---|---|
| 模型“申请完成”工具 | 每轮边界已有独立验证；不是必需入口 | 证实能减少无效审查且不破坏停滞检测 |
| 只在模型宣称完成时验证 | 会改变核心可靠性与缺口反馈 | 有新的进展判据及回归证据 |
| token/费用硬预算 | 必须先有完整、可信的统计口径 | P2 能覆盖主运行与 verifier，且明确软/硬限制 |
| classifier 判断停滞 | 增加调用和误判；不能代替执行证据 | 缺口改写导致的漏检有实际样本 |
| SDK 内嵌 verifier | 涉及 provider、凭据和隔离边界 | 存在明确需求且公开 API 足够支持 |
| 完成前强制运行指定命令 | 只适用于部分目标，涉及用户命令信任 | 用户需要显式、可选的验收命令 |

## 7. 参考与取舍

- [pi-goal-x](https://pi.dev/packages/pi-goal-x?name=Agent)：
  借鉴独立 auditor、完成条件和驳回反馈；不搬多目标、任务树和复杂 dashboard。
- [pi-codex-goal](https://pi.dev/packages/pi-codex-goal)：
  借鉴目标查询、阻塞恢复和嵌套调用统计；不接受主 agent 直接成为最终完成裁判。
- [pi-goal-pro](https://pi.dev/packages/pi-goal-pro)：
  借鉴预算与用户控制；不照搬“输出 token 少就是无进展”的判据。

参考实现的旧生命周期调度不直接复制。续跑继续使用 Pi 1.0.1 的 `agent_before_settle`。

## 8. 交付顺序与回退

1. 独立确认已有 Pi 1.0.1 兼容改动。
2. 实施 P1，评审工具协议、记录字段和旧 session 兼容。
3. 根据 P1 使用结果实施 P2；完整日志未证明必要时只做摘要。
4. 使用 P2 数据评估 P3，不提前默认启用 codemode。

每阶段独立评审和交付，不一次性实现全文。
新增持久化字段保持可选，不迁移或重写历史 session。
保留现有 CLI 与 verifier 路径；实验关闭后，goal 仍按原有机制工作。

任何阶段都不得回退：用户控制、独立完成判定、轮数上限、过期结果保护、
分支恢复纪律、JSON/RPC 单次最终 settlement。
