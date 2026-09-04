# 智能刷题系统（Expo React Native）项目记忆

## 依赖

未引入模板之外的第三方包。业务实际用到的能力均来自 Expo 预装清单：

- `expo-document-picker`：选择 Word/PDF/TXT 题库文件
- `expo-image-picker` / `expo-camera`：拍照/相册识图的取图入口
- `expo-image-manipulator`：识图前压缩到 ≤1MB JPEG（长边 ≤2000px）
- `expo-file-system`：读取选中文件字节并转 Base64（SDK 56 新 API，`File` 类实例方法）
- `expo-haptics`：答错震动反馈（设置页可关）
- `expo-sharing`：导出/分享题库走系统面板
- `react-native-svg`：全部图标（模板禁用 `@expo/vector-icons`）
- `@supabase/supabase-js`：仅通过 `src/supabase/client.ts` 导出的 `supabase` / `supabaseUrl` 访问

## 架构

- 路由：`src/app/` 文件路由（Stack 未写显式清单，新增页面文件即自动可路由）。`(tabs)` 为「题库 / 统计 / 设置」三 Tab，其余栈页面 `auth` `import` `quiz` `session` `result` `wrong` `bank` `bank-stats` `ai-config` `exam` `search` `diagnosis`。跳转一律用公开 URL（`/import`），不带 route group 前缀。
- 状态三层：`AppContext`（题库列表、全局 AI 任务队列、设置）/ `importStore`（模块级单例 + `useSyncExternalStore`，导入草稿与页面生命周期解耦）/ `sessionStore`（当轮答题会话）。AI 任务状态放 Context 而不是页面 state，保证切页后任务继续跑、顶格进度条常驻（`AiTaskLayer` 挂在根 `_layout.tsx`）。
- 解析双通道：`questionParser.ts` 本地正则解析（离线秒级）；`docClient.ts` + Edge Function `doc-parse` 走 AI 通道（extract/gen/parse/vision-start/vision-status 五种 mode），结果按 `题型|题干前40字` 去重合并。⚠️ 识图必须走 vision-start/status 异步任务：视觉模型单张实测 ~70s，超过网关 60s 硬超时；任务状态落 `quiz_vision_jobs`，端侧 3s 轮询、4 分钟封顶。
- 内置免费 AI 双档位（`aiConfig.BUILTIN_CHANNELS`）：**模型一 = 智谱 GLM**（文本 `glm-4.7-flash` / 识图 `glm-4.6v-flash`，Key 存 Edge Function Secret `ZHIPU_FREE_API_KEY`）、**模型二 = 通义千问**（`qwen3.6-plus` / `qwen3-vl-plus`，走平台网关 `MEOO_PROJECT_API_KEY`，会消耗平台账号额度）。端侧只传档位标识、永不下发 Key：`aiService.providerPayload` 带 `provider.channel` → `ai-relay`；`docClient.post` 统一注入顶层 `channel` → `doc-parse` 的 `aiTarget(channel, kind)`。`sanitize()` 在 `useBuiltin` 时按档位强制改写 model/visionModel，老配置不会残留错配。默认档位 `zhipu`。
- 千问每日额度（`quiz_ai_quota`，迁移 `20260904_092831`）：**只有真正打到千问上游的请求才计数**（含智谱失败后的降级那一次），智谱「模型一」不限次、永不停用。`QWEN_DAILY_LIMIT = 2` 在两个云函数与 `quotaService.ts` 各自常量。原子扣减靠 `consume_qwen_quota(p_limit)`（plpgsql `SECURITY DEFINER` + `SET search_path=public` 绕 RLS 写，`INSERT ... ON CONFLICT DO NOTHING` 建行后 `UPDATE ... WHERE qwen_calls < v_limit RETURNING`，超限即不增、无竞态）；只读展示走 `get_qwen_quota(p_limit)`。日切用 `(now() AT TIME ZONE 'Asia/Shanghai')::date`，绝不在端侧算时区。RLS 只给本人 SELECT，端侧无法自行改小计数。`consumeQwenCall` catch 时**默认放行**（额度是省成本的软限制，不该因库抖动弄挂 AI）。计数点：`ai-relay` 的 `callModel` builtin 分支 `!useZhipu` 时扣；`doc-parse` 的 `genQuestions`/`visionQuestions` 在 `target.channel === 'qwen'` 时扣。`QuotaExceededError` 必须在 `callModelWithFallback` / `genQuestionsSafe` / `visionQuestionsSafe` 的 catch 首行原样抛出，不能被降级逻辑吞掉；出口统一 `429 + code: 'qwen_quota_exceeded'`。端侧镜像：`quotaService.ts`（模块级单例 + `useSyncExternalStore`）+ `BuiltinNoticeLayer.tsx` 底部浮层（挂根 `_layout.tsx`，顶部让给 `AiTaskLayer`），`aiService.handleRelaySignal` 读 `fellBack`/`qwenRemaining`/`code` 弹提示，`docClient.reportParseSignal` 按固定文案「额度已用完」/「繁忙」「访问量过大」「1305」识别——识图错误只能靠 `quiz_vision_jobs.error` 文案回传。配置页 `ChannelQuotaBadge`（qwen 档位行显示「今日剩 N/2」/「今日已停用」）+ `BuiltinQuotaLine` 说明文案。
- 千问额度豁免（迁移 `20260904_095657` 建表 + `20260904_100202` 修函数）：`quiz_ai_quota_exempt(user_id PK, note)` 白名单表，RLS 仅本人可读，端侧与云函数**都不出现账号名/密码**。两个 RPC 先 `SELECT EXISTS(... exempt ...)`，命中则照常 `qwen_calls + 1`（保留真实用量）但**永远 allowed=true**，`get_qwen_quota` 回填 `remaining = p_limit` 且 `unlimited = true`。豁免只对名单内账号（当前仅 qby）生效，其他账号仍严格每天 2 次。端侧：`QuotaSnapshot.unlimited` → `QuotaHint.tsx` 显示「模型二（千问）不限次数 · 今日已调用 N 次」。
- 额度提醒条 `components/QuotaHint.tsx`：`variant='card'`（题库列表页、题库详情页，自带卡片底色）/ `'inline'`（设置页 AI 卡片内），`ai.cfg.useBuiltin` 为假时整条不渲染；主文案「模型二（千问）今日剩 N/2」，同行小字固定说明 `ZHIPU_NOTE = 模型一不限次数，但访问限流较高，失败率较大`，靠 `useFocusEffect` + `refreshQuota()` 保证切页刷新。
- 艾宾浩斯遗忘曲线：`statsService.loadForgettingCurve(bankId?)` 以「最近一次答对距今 N 天」把题分 8 桶（当天/1/2/3/4-6/1-2周/2-4周/1月+），`rememberedNow = 最近一次作答正确 && 不在未解决错题本`；虚线理论线 R = 100·e^(-t/S) 的 S 由 `fitStability` 网格搜索（0.3~60 天、按样本量加权最小二乘）**用真实实测点拟合**，样本 <8 题时 `enough=false` 并明确提示样本不足，不编数据。组件 `ForgettingCurveCard.tsx`（react-native-svg，自带取数 + `useFocusEffect`，页面只丢标签）：统计页 `<ForgettingCurveCard />` 全局一份、题库详情页 `<ForgettingCurveCard bankId={id} />` 一份。
- 数据层：`quizStore.ts` 封装 Supabase 增删改查（banks / questions / records / wrong_entries / settings），作用域统一 `user_id = getOwnerId()`（`src/services/ownerId.ts` 是云端作用域取值唯一入口，云函数请求头走同文件的 `authHeaders()`）。`quiz_questions.order_index` 已是 **NUMERIC**（迁移 `20260904_045818`），因此 `insertQuestionsAfter(bankId, afterOrderIndex, questions)` 能在「锚点题与下一题」之间取等分小数一次 insert 落位，不做整库逐行重排；`afterOrderIndex: null` = 追加末尾，间隙被切到 `<1e-7` 时自动退回末尾。`deleteBank` 必须显式清 `quiz_attempts` / `quiz_wrong_book` / `quiz_progress` 三张无外键表。
- 账号体系：只有「账号名 + 密码」一条链路（basic_auth），全部在 `src/store/AuthContext.tsx` 内联实现。Supabase Auth 只接受邮箱，内部拼 `{account}@meoo.local` 虚拟邮箱，绝不展示、绝不写进 `profiles.email`。`onAuthStateChange` 回调里禁止 await 数据库。会话持久化由平台生成的 `client.ts` 走 `expo-secure-store`。不支持自助找回密码。**修改密码**：`AuthContext.changePassword(current, next)` 先用原密码 `signInWithPassword` 做校验（顺带让会话变「新鲜」，平台把改密码当敏感操作、要求近期登录记录，直接 `updateUser` 会被拒），通过后才 `updateUser({ password })`；页面 `src/app/change-password.tsx`（栈路由 `/change-password`，入口在设置页账号区 Row），报错一律走 `translate` 翻成中文、绝不展示原始 message。
- 登录门禁：根 `_layout.tsx` 用 `useAuth().ready` 三态判定；`AppContext` bootstrap 依赖 `userId`，换号先清空数据再拉取。
- 四个 Edge Function（`ai-relay` / `doc-parse` / `doc-export` / `account-close`）均 `verify_jwt: true` + 函数体内 `getUser(token)` 二次校验（匿名密钥本身也是合法 JWT，光靠开关挡不住）。前端裸 fetch 统一带 `authHeaders()`。
- RLS：9 张业务表（banks / questions / attempts / wrong_book / progress / settings / vision_jobs / favorites / reviews）全部 `user_id = auth.uid()`，未登录与持匿名密钥者匹配不到任何行。`quiz_settings` 主键 `user_id`，upsert `onConflict: 'user_id'`。
- 科目分类（新）：`quiz_questions.subject`（TEXT 可空，NULL=未分类）。白名单 12 项在 `aiService.SUBJECT_OPTIONS`，模型返回不在名单内一律归「其他」。链路：`subjectService.classifyBank(bankId, onProgress, shouldAbort)` = 取未分类题 → `aiService.classifySubjects`（每批 15 题串行，走 ai-relay，跟随用户配置的供应商）→ 逐题 `updateQuestion` 回写。触发点：导入保存成功后自动跑（fire-and-forget，任务挂全局队列）+ 题库详情页「有 N 题未识别科目」按钮。全部批次失败才抛 `RelayUnavailableError`，用于区分「AI 不可用」与「部分成功」。
- AI 类似题：题库详情页题目卡展开后有「添加AI生成类似题」按钮（`QuestionEditor.onSimilar`，仅 bank 页传入），弹三选：① 生成 1 题插在这题后面 ② 生成 5 题新建「原名 · 类似题」AI 题库 ③ 从其他题库找相似（`listQuestionsFromOtherBanks` 取 200 题候选 → `findSimilarQuestions` 让 AI 挑下标 → 复制入库）。①③都走 `insertQuestionsAfter(id, q.orderIndex, list)` 精确落位。生成走 `aiService.generateSimilarQuestions`（relayChat，temperature 0.8），产物 `reviewed:false`（答案待确认）、科目沿用母题。
- AI 增强四能力：端侧编排统一在 `aiPlusService.ts`（取数 + 进度协议 + 落库），原子 prompt 能力在 `aiService.ts`，都走 `ai-relay` 跟随用户配置的供应商。① `runDiagnosis()` → `/diagnosis` 薄弱点诊断页（入口在统计页），累计作答 < 5 次直接判「样本不足」不调 AI；② `explainBank` 批量补解析，条件 `needsExplanation`（有答案且 explanation 为空），与「补答案（无答案）」互斥；③ `createVariantBank` 错题变式重练，最多取 12 道未解决错题，末位可选 `subject` 参数支持跨题库（按科目）维度；④ `createMockPaper` AI 出模拟卷，题量 10/20/30，`buildPaperSlots` 用最大余数法按题库自身题型/科目占比分配名额。③④产物都 `createBankWithQuestions` 落**新的 AI 题库**（`原名 · 错题变式` / `原名 · 模拟卷 月.日`），题目 `reviewed:false`。入口分别在错题本页 listHeader 与题库详情页 banner。
- 判题与统计：`quizEngine.ts`（纯函数判分）、`statsService.ts`（loadStats / loadBankStats / loadWrongGroups / loadWrongSubjectGroups）。「已掌握」全站单一口径：最近一次答对且未挂在错题本待消灭里。`loadStats` 的 `accuracy` 已是 0-100 百分数，展示层只做 clamp。分题型与分科目共用 `aggregateAttemptsByKey` + `buildKeyStats`（按 key 泛化），`StatsSummary.bySubject: SubjectStat[]` 供统计页「分科目正确率」卡片；科目为空的题在统计里归 `UNCLASSIFIED`（'未分类'）。
- 多选部分得分：`quizEngine.scoreOf(question, given, result)` 只在「选择题 + 答案≥2项 + 无错选且有命中」时给 0.5，错选 0、全对 1；`diffPicks` 供反馈文案列出漏选项。`AnswerRecord.score` 由 `session.tsx`（逐题交卷）与 `exam.tsx`（批量交卷）两条判分路径写入，`result.tsx` 展示「得分 X / N」并说明两个口径。⚠️ 得分**只进内存会话与 `quiz_progress.answers`（`ProgressAnswer.score`，断点续练靠它保住半分）**，云端 `quiz_attempts` 刻意不加列——正确率/错题本/统计仍是「全对才算答对」单一口径；无 score 的老记录与老进度行一律按对错折算。写 `quiz_progress.answers` 时 jsonb 内不得出现 undefined，可选字段要条件挂载。
- 科目维度入口：统计页分科目行「错题 ›」→ `/wrong?subject=X&name=X`；错题本总览（`WrongGroups.tsx`）有「按科目 / 按题库」分段切换（默认按科目），两种维度统一成 `WrongRow` 共用列表。`wrong.tsx` 的 `BankWrongList` 接 `bankId`+`subject` 二选一：科目维度取全量错题后按 `question.subject` 端侧过滤（错题表不存科目，避免多份口径）；跨题库会话的 `startSession.bankId` 取首题归属（断点进度键必须是合法 uuid），`session.tsx` 交卷走 `submitAnswer(question.id, question.bankId, ...)` 保证分题库统计不失真。
- 简答题判分 `aiService.judgeShortAnswer`：AI 判分失败退回本地关键词，本地兜底 reason 必含「离线」二字，`session.tsx` 靠它决定标签文案。
- 界面风格 4 套（paper/neo/sketch/night），不透明底色；`ThemeContext.readThemeId()` 白名单校验。
- 题号导航 `QuestionNav.tsx`（答题卡），断点进度 `quiz_progress.answers`（jsonb，questionId → {correct, manual, seen, reason, given}），背题模式用 `seen` 存进度。
- 导出/分享：`/bank` 分享全部题目，`/quiz` 分享当前题池；刻意不受题量 limit 影响、都带答案解析。文件由 `doc-export` 生成。
- 数据可靠性：作答落库失败（`submitAnswer` 返回 false 或抛错）进 `offlineQueue.ts` 内存队列，下次成功作答触发 `flushAttemptQueue()` 补交并 `notifySyncFailed()` 提示；批量插入（导入/建库）中途失败走「回读校正」——重新拉取已落库题目比对差集后只补缺口，不做整库回滚删除；`listBanks` 区分「真的没有题库」与「查询失败」，失败不得渲染成空态。
- 账号注销：`account-close` Edge Function 在服务端校验身份后清库并删 auth 用户，端侧只调函数、不逐表自删；入口在设置页，用 `dialog` 的 destructive 按钮二次确认。全量备份/恢复在 `backupService.ts`：导出 JSON（分页拉取，剔除服务端字段）经 `expo-sharing` 分享，恢复按题库名重建并重映射 questionId。
- 刷题闭环扩展：`/exam` 模考限时（`quiz_settings.exam_seconds_per_question`，到时自动交卷，`submitted` ref 防重复交卷）、`/search` 全局搜索、`quiz_favorites` 题目收藏（唯一索引 user+question，`favoriteStore.ts`）、`quiz_reviews` 间隔重复（Leitner box 1-5 ↔ 1/2/4/7/15 天，`upsertReview()` 每次作答自动升降档，模式 `'review'`）、每日目标打卡（`quiz_settings.daily_goal` + 由 `quiz_attempts` 算今日数与连击，`dailyGoal=0` 视为关闭）。题目难度 `quiz_questions.difficulty`（TEXT 可空）。

## 走不通的方案

- ❌ 内置免费 AI 只有千问一档 → 走平台网关 `MEOO_PROJECT_API_KEY`，实际消耗的是用户自己的账号额度，用户发现后明确要求拆分 → ✅ 拆成模型一（智谱，Key 独立存 `ZHIPU_FREE_API_KEY`）+ 模型二（千问），配置页可选，默认模型一。
- ❌ 把智谱 Key 存 SecureStore / 写进端侧代码传给云函数 → 等于把第三方凭证下发到客户端 → ✅ 只做 Edge Function Secret，端侧仅传档位标识 `channel`。
- ❌ 让 AI 一次性处理整份文档 → 网关约 60s 硬超时 → ✅ 前端按 900 字切片串行请求，`enable_thinking:false` + `max_tokens:2048`。
- ❌ 识图同步等返回 → 单张 ~70s 必 504 → ✅ vision-start/status 异步任务 + 轮询。
- ❌ SSE 流式读取 AI 返回 → RN 不支持 `response.body` 流式消费 → ✅ 非流式 JSON + 分片轮转进度。
- ❌ 用 NativeTabs → 不渲染 header → ✅ JS `Tabs` + svg 自绘 tabBarIcon。
- ❌ 「玻璃模态」主题（expo-blur）→ Android 观感差，用户要求删除 → ✅ 已整体下线，勿再试 rgba 假磨砂。
- ❌ `Alert.alert` 做提示 → 不跟随主题、Android 返回键行为异常 → ✅ 自绘 `DialogHost` 全站替换。
- ❌ 「选择文件」入口直接进文本管道 → 用户从文件管理器挑图片时，JPEG 二进制被 GBK 兜底解码成乱码"题目" → ✅ 入口按 MIME/扩展名分流到识图链路 + 云函数按魔数（JPEG/PNG/GIF/WebP/BMP）二次拦截。
- ❌ 科目分类/相似题生成放 `doc-parse` 云函数 → 该函数只走内置模型、且已部署多版本逻辑重 → ✅ 放 `aiService` 走 `ai-relay`，跟随用户已配置的供应商，端侧编排即可。
- ❌ 未登录时对 uuid 列发 `user_id=eq.`（空串）查询 → PostgREST 直接 400（invalid input syntax for type uuid）→ ✅ `quizStore` / `statsService` / `progressStore` / `subjectService` 里**每一个**取 `getOwnerId()` 的函数都必须紧跟 `if (!userId) return <空值>`。根 `_layout.tsx` 的登录门禁是**遮罩层**不是挂载拦截，tab 页会在会话恢复窗口先 mount 并发请求，只补一两个文件仍会残留 400。
- ❌ 整数 `order_index` 想「插到某题之后」→ 必须整库逐行 update，百题级打爆请求数 → ✅ 列改 NUMERIC 后取前后中点，一次 insert 搞定。
- ❌ 千问额度放端侧计数（AsyncStorage/内存）→ 改一下客户端就绕过，且多设备各算各的 → ✅ 服务端 `consume_qwen_quota` RPC 原子扣减，端侧只做只读镜像与提示。
- ❌ 把「一次文档导入」当成一次请求算额度 → 用户以为还有额度却被扣光，说不清 → ✅ 按底层真实请求计数（900 字切片每片各计 1 次），并在配置页文案里写明。
- ❌ 为省额度给智谱也加停用逻辑 → 用户明确要求智谱可以一直自己碰运气 → ✅ 停用范围只有千问，智谱被限流时只弹提示引导、不做任何拦截。
- ❌ 为多选半分给 `quiz_attempts` 加 score 列 → 同一次作答会在「正确率」与「得分」两套指标里被算成不同的事，且历史行 NULL 的折算口径永远说不清 → ✅ 得分只活在内存会话（`AnswerRecord.score`）供本轮分数展示，云端仍只存 `correct`。

## 踩坑记录

- `tsconfig.json` 必须 `exclude` `functions`（Deno 环境代码会污染 `tsc --noEmit`）。
- `expo-file-system` SDK 56：`await file.bytes()` 漏 `await` 会得到 Promise，Base64 为空、解析 0 题。
- Supabase 写入 payload 必须具名字段对象（`RejectExcessProperties` 会拒 `Record<string, unknown>`）；jsonb 值里不能有 `undefined`；改表结构后 `src/supabase/types.ts` 由平台 migrate 自动重生成，手写 payload 要与它对齐。
- FlatList 空态不要 `data={[]}`（never[] 推断）；RN 样式不能 `styles[动态键]`。
- 所有 `async` 调用必须 `try/catch` + `console.error`，报错翻译成中文再展示。
- 构建前必须已有 `assets/icon.png`、`assets/splash.png`；`expo export` 之后放不进去。
- DDL 含函数体时用 `cloud migrate --file`；meoo-cli cloud 命令必须单独执行、参数不能带换行。
- RLS 收紧后写失败是**静默**的：INSERT/UPDATE 被策略拦截时 error 仍为 null，必须 `.select()` 回读行数判定成败。
- 智谱免费模型（`glm-4.7-flash` / `glm-4.6v-flash`）实测会返回 HTTP 429 + `code 1305「该模型当前访问量过大」`，Key 本身是有效的（无效会返回鉴权错误码）→ 两个云函数都做了「智谱失败快速补一次千问」降级（`ai-relay` 的 `callModelWithFallback`、`doc-parse` 的 `genQuestionsSafe`/`visionQuestionsSafe`），日志打 `fallback=qwen`。⚠️ `ai-relay` 网关 60s 硬超时，降级只在**失败耗时 < 15s** 时才重试，慢失败直接抛错。
- `ai-relay` 没有模块级 `reqId`（它在 `Deno.serve` 回调内生成），函数体外写日志要自己 `crypto.randomUUID()`；`doc-parse` 反之有模块级 `reqId` 可直接用。写错会在 `deploy-function` 的 Deno 预检阶段以 TS2304 被拦下、不会污染线上。
- Read 工具会把 `functions/**/*.ts`（Deno 端代码）误判成图片并返回「无法以多模态格式加载」→ 改用 `node -e` 按行区间打印原文来读，不要反复重试 Read。
- 块注释里写 `*/*` 会提前闭合注释（`*/`），描述通配符时改用文字。
- plpgsql `RETURNS TABLE` 的**输出列名与表列同名**（如 `quota_day`）时，函数体内 `UPDATE ... WHERE quota_day = v_day` 会在**运行时**抛 42702「column reference is ambiguous」；`CREATE FUNCTION` 阶段只查语法，所以 **migrate 成功 ≠ 函数可用**。用函数名限定变量（`func.var`）在带表别名的查询里又会报 42P01。正确做法：**输出列改名（quota_date）+ 列引用一律带表别名 + 变量保持 v_ 前缀**。
- `meoo-cli cloud migrate --changes` 的参数值里**不能出现反引号或 `>`**——双引号内的反引号会被 shell 当命令替换执行，命令会以「meoo-cli 必须单独执行」为由失败。改用 `**加粗**` 或纯文本描述对象名。
- 沙箱会回收 `node_modules`：某天 `pnpm exec tsc` 突然报 `Command "tsc" not found`、且 `node_modules/.bin/tsc` 不存在时，不是脚本写错，直接 `pnpm install` 恢复依赖后重跑三步验证即可。
