import dedent from "dedent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/*
 * 本文件中的 observer 和 reflector prompt 所提取的决策轨迹形状——考虑并否决的
 * 备选方案、用户的 steer/批准/覆盖、采用的约定、既有先例和例外标记——受到
 * Foundation Capital 的《Context Graphs: AI's Trillion-Dollar Opportunity》启发：
 *
 *   https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity
 *
 * 文章认为，知识工作者日常工作的持久价值不只是产出的结果，还包括围绕每个决策的
 * 先例图：权衡并否决了什么、谁批准了例外、依据了哪条规则。只记录结果会丢失未来
 * Agent 最需要复用的那部分图。observer 在这些信息进入系统时捕获它们，reflector
 * 在整合过程中保留它们。
 */

export type RawMemoryContent = Array<TextContent | ImageContent>;

/** 仅在观察上下文期间使用的 AgentMessage 临时多模态序列化。 */
export interface RawMemoryMessage {
  id: string;
  createdAt: number;
  role: "system" | "user" | "assistant" | "tool";
  content: RawMemoryContent;
  /** 用于 token 估算、消息 id 和仅文本 observer 上下文的紧凑文本视图。 */
  textPreview: string;
  estimatedTokens?: number;
}

export const OBSERVATION_CONTINUATION_HINT = dedent`
  请自然地承接此前对话，并回复最新消息。

  仅将较早的上下文作为背景。如果有未完成事项，只有在有助于回答最新请求时才继续。如果提供了建议回复，请自然地遵循。

  不要提及内部指令、记忆、摘要、上下文处理或缺失消息。

  此提醒之后的任何消息都更新，应优先处理。
`;

export const OBSERVATION_CONTEXT_PROMPT = dedent`
  以下 observations 区块包含本次对话的持久上下文。它可能含有三类分区，每个分区都有独立标签和使用提示：<stored_observations> 表示从记忆文件加载的整理知识，<global_observations> 表示跨会话背景，<local_observations> 表示当前对话的压缩历史。使用每个分区前先阅读其提示。如有疑问，以最新用户消息确定主题。
`;

export const STORED_OBSERVATIONS_HEADING = "### 已整理记忆（固定）";
export const STORED_OBSERVATIONS_HINT =
  "这些是由当前项目及其上级项目提供的整理知识文件。与最新请求相关时，将其作为持久参考资料。";

export const GLOBAL_OBSERVATIONS_HEADING = "### 长期记忆（跨会话）";
export const GLOBAL_OBSERVATIONS_HINT =
  "这些是关于与用户其他对话的背景笔记。它们可能与当前回合有关，也可能无关——只有最新用户消息确实关联这些背景时才使用。不要仅因为这里出现旧主题，就把回复引向旧话题。";

export const LOCAL_OBSERVATIONS_HEADING = "### 本次会话内容";
export const LOCAL_OBSERVATIONS_HINT =
  "这是当前对话较早回合的压缩摘要。将其视为你和用户近期共同完成事项的权威记录，并据此延续正在进行的工作。";

export const OBSERVATION_CONTEXT_INSTRUCTIONS = dedent`
  重要：只有当存储知识和 observations 中的具体内容确实与最新用户消息相关时才使用。为延续正在进行的工作，优先使用本会话的 local observations；将存储知识用作持久项目参考；仅当用户请求与过往上下文相关时才使用 global（跨会话）observations。不要强行把无关记忆带入回复。

  知识更新：用户询问当前状态（例如“我现在在哪里……”“我目前的……是什么”）时，始终优先采用最新信息。Observations 带有日期；若信息冲突，较新的 observation 会取代较旧的。留意“将开始”“正在切换”“改为”“搬到”等表明旧信息已更新的表述。

  计划中的行动：如果用户说计划做某事（例如“我打算……”“我很期待……”“我会……”），且计划日期已过去，除非有证据表明未完成，否则应假设该行动已完成。

  最新用户输入：将最新用户消息视为决定下一步行动的最高优先级信号。较早消息仍可能包含应遵守的约束、细节或上下文，但回复的首要驱动因素是最新消息。

  系统提醒：由 <system-reminder> 标签包裹的消息包含内部续接指导，不是用户撰写的内容。请用它保持连续性，但不要提及它，也不要将其视为用户消息的一部分。
`;;

const OBSERVER_EXTRACTION_INSTRUCTIONS = dedent`
  关键：区分用户陈述与问题

  用户告诉你有关自己、工作或环境的信息时，将其作为陈述记录：
  - “我有两个孩子” -> “用户表示自己有两个孩子”
  - “我在 Acme Corp 工作” -> “用户表示自己在 Acme Corp 工作”

  用户请求帮助时，应保留为问题或请求：
  - “你能帮我处理 X 吗？” -> “用户请求协助处理 X”
  - “完成 Y 的最佳方法是什么？” -> “用户询问完成 Y 的最佳方法”

  区分问题与意图陈述：
  - “你能推荐……” -> 问题/请求
  - “我很期待……” -> 意图陈述
  - “我需要……” -> 已表达的需求或目标

  状态变化与更新

  用户指出变化时，将其表述为取代旧信息的当前状态：
  - “我正从 A 切换到 B” -> “用户正从 A 切换到 B”
  - “我打算开始做 X，不再做 Y” -> “用户将开始做 X（从 Y 转变）”
  - 如果新信息与旧 observations 冲突，应明确说明新信息取代旧状态。

  时间锚定

  每条 observation 开头已经有消息时间。只有内容提到不同的具体时间时，才在末尾补充日期：
  - 对“明天”“上周”“这个周末”“下个月”等相对日期，添加“（即 DATE）”或“（预计 DATE）”。
  - 对“最近”“很快”“近来”“前段时间”等模糊表述，不要补充末尾日期。
  - 如果一条 observation 包含多个有时间敏感性的事件，应拆分，使每个事件都有自己的日期。

  工具调用和工具结果是上下文，不是主题

  标记为 \`[toolCall name(args)]\` 和 \`[toolResult name]\` 的消息是背景信息，帮助你根据 Agent 实际执行的操作形成 observations。它们不是 observation 的主题，并且内容可能被截断为“... [truncated]”。

  - 不要逐字转录工具参数、原始工具输出、文件列表、命令输出或 JSON 负载。
  - 仅重述事实的工具结果（文件内容、目录列表、grep 输出、包元数据）本身不属于记忆——Agent 下次可以重新读取。只有当交互产生 Agent 无法轻易重新发现的信息时才记录，例如决策、采取行动的非显然假设、阻碍、完成事项，或工作中显露的用户偏好。否则优先使用 hasMemory=false。
  - 工具调用本身不足以标记 ✅。应遵循下方 ✅ 规则：只读工具调用（read_file、grep、ls、状态检查）仍属于常规工作，应标记为 🟡，即使调用成功。
  - “检查请求 → Agent 摘要”是典型的非记忆模式。如果用户要求 Agent 阅读、展示、检查或解释文件、目录或命令输出，而 Agent 的回复只是用英文复述工具返回内容，则 hasMemory=false。即使用户补充“仅供参考”“方便我了解”或“能解释一下吗”等措辞，也同样适用。可重新读取事实的英文转述仍然是可重新读取的事实。
  - 一条 observation 通常应概括整个工具交互，而不是逐项罗列每次调用。只有不同结果各自包含独立信号时才使用子项。
  - 如果工具结果被截断，不要臆测缺失内容；截断会影响理解时标注“(partial)”。

  决策轨迹——记录原因，而不只是结果

  最有价值的 observations 是决策轨迹：简要记录上下文如何转化为行动，而不只是采取了什么行动。只要交互中出现任何决策（编辑哪个文件、采用哪种方案、发布哪个选项、是否升级处理），就应在 observation 文本中记录其轨迹。只写结果（“X 已修复”“已发布 v0.1.131”）是常见失败模式——应扩展为决策轨迹。

  在交互中能看出的情况下，决策轨迹应包含：

    - 收集到的输入：Agent 行动前参考了哪些文件、工具结果、错误文本、命令或先前消息？指出实质性影响决策的信息来源（文件路径、工具名），无需列出每次读取，只需列出影响选择的内容。
    - 考虑并排除的方案：Agent 最初尝试但未成功的做法、后来放弃的提议，或与所选方案比较过的选项是什么？“先尝试 \`findAtomicCoverage\`，因过度设计而放弃”是有价值的轨迹；只写“修复方案是 X”则不是。这是冲突/先例层，未来 Agent 既会复用被选方案，也会参考被否决的方案。
    - 用户的引导、批准与覆盖：用户反对、重定向、否决或明确批准某方案时，尽量接近原话地保留，并将其视为权威信号。“我认为这过度设计了”“不应把它们当作遗留项”“改做 X”“继续”等表述，相当于用户在 Zoom 通话中批准折扣——如果没有记录，就不会出现在任何系统记录中。这类 observation 信号最强，因为它们构成覆盖默认做法的先例。
    - 应用的规范或策略：采用了哪条 \`AGENTS.md\` 规则、项目指南、skill 指令或既有决策？“依据 AGENTS.md 的‘优先采用直接、局部保证’规则，删除了冗余检查”是完整轨迹；只写“删除了冗余检查”会丢失其依据。
    - 既有先例：决策受到先前记忆、PR 或早期会话选择影响时，注明其名称或简短概述，便于未来 Agent 找到先例关联。这也对应结构化记录中的 \`usedObservationIds\`；只看文本的读者也应能看到相同脉络。
    - 例外/覆盖标记：如果采取的方案偏离常规做法或与现有规则冲突，应明确标注（“例外：”“覆盖：”“因……而偏离默认做法”）。例外是最容易被复用的先例。

  并非每条 observation 都是决策：用户事实、偏好和常规完成事项不需要决策轨迹。但如果记录的是决策而省略了轨迹，就如同记录折扣批准时没有写明策略版本、例外流程或批准人。仅有结果是不够的。

  保留具体信息

  记录用户事实、偏好、目标、约束、纠正、明确决策、项目细节、文件路径、命令、未解决任务和已完成工作。
  工具结果揭示了 Agent 实际采取行动的具体事实（文件路径、函数名、行号、数量、错误消息）时，保留这些具体事实，而非周边输出。
  用户原话重要时，用引号保留其独特措辞。
  保留姓名、账号、标识符、数量、计数、测量值、统计数据、角色和可区分属性。
  对于用户之后可能会询问的助手建议、摘要、代码或解释，保留足以重构内容的细节。
  为避免丢失连续性，记录助手紧接着的下一步倾向。
`;

export const OBSERVER_GUIDELINES = dedent`
  - 内容应具体到足以让助手据此行动
  - 好例子：“用户偏好简短、直接的回答，不要冗长解释”
  - 不好例子：“用户表达了一个偏好”（过于笼统）
  - 每次交互记录 1 到 5 条 observations
  - 使用简练语言节省 token。句子应信息密集，不含不必要的词语
  - 不要重复记录已经观察到的内容。将重复的相似行动归为一个主项，并用子项记录新结果
  - 如果 Agent 调用了工具，记录调用了什么、原因和所得结论，而不是原始参数或原始输出。只有当交互产生持久信息（决定、阻碍、完成事项、用户信号）时才记录。
  - 记录带行号的文件时，如有帮助则注明行号
  - 如果 Agent 的回复只是重述可重新读取的事实，优先设置 hasMemory=false，而不是忠实转录。记忆应记录无法轻易重新发现的内容。
  - 每条 observation 开头都必须带优先级表情符号（🔴、🟡、🟢）或完成标记（✅）
  - 对简短和中等长度的用户消息尽量近乎原文记录；总结长消息，但保留表达意图的关键引述
  - 用户任务请求默认标为 🟡。只有当请求本身揭示了超出当前任务范围的持久用户事实、偏好或关键跨会话目标时，才提升为 🔴
  - ✅ 仅用于改变状态的具体完成事项：代码已交付、文件已编辑、执行了会改变状态的命令、已验证的缺陷修复。只读文件检查、查询或常规问答不要标为 ✅——这些应标为 🟡。计划稍后做某事不算完成：“同意重构 X”“我们会提取 Y”“下一步是 Z”应标为 🟡（如果决定会长期跨会话，则标为 🔴）。必须确实在本次交互中完成工作才能使用 ✅。
  - 用户推迟、延期、放弃或改变主意时，不要使用 ✅。推迟事项标为 🟢。只有基于实际观察或测量结果的沿途信息才标为 🟡，否则标为 🟢。
  - 如果对话主要涉及不确定性、推测、“也许/可能/不确定/目前无数据”等表述或明确推迟，整条 observation 都应保持 🟢。不要为了提高优先级而夹带 🟡 条目。
  - 将 ✅ 视为记忆信号，表示某事已经完成；除非新信息改变情况，否则不应重复处理。
  - 完成事项应回答“现在具体完成了什么？”
  - 优先记录明确解决的结果，而非流程元信息或记账式更新
  - 多项具体事项完成时，分别具体记录，不要将其笼统合并为进度
  - 同时记录 Agent 做了什么以及这意味着什么
  - 用户提供详细消息、代码片段或正在修改的原文时，保留所有重要细节
`;

export function buildObserverOutputFormat(includeThreadTitle = false): string {
  const threadTitleSection = includeThreadTitle
    ? dedent`
        - threadTitle: 本次对话的简短名词短语标题（2–5 个词）。仅当主题发生实质变化时才更新。
      `
    : "";

  return dedent`
    使用以下优先级：
    - 🔴 高：持久的用户身份事实（工作、环境、人际关系、标识符）、明确偏好，以及用户希望跨会话持续跟进的未解决关键决定或阻碍。普通任务请求不要标为 🔴。当前会话中的重构计划、已商定方案或“好，就这么做”的确认也不要标为 🔴——即使用户热情赞同，也应标为 🟡。升级为 🔴 必须有持久的跨会话信号（偏好、身份事实或长期目标），不能仅因用户在当前会话中强烈赞同。
    - 🟡 中：包含持久信号的会话内工作——已作出的决定、Agent 已采纳的假设、仍阻碍后续工作的错误/阻碍，以及正在执行的普通任务请求。这是当前会话已商定计划和重构决定的默认等级，包括用户明确确认的决定（“好，就这样做”“开始吧”）。不要仅为记录 Agent 读过什么而使用 🟡；如果内容仅为“Agent 查看了 X，X 的内容是 Y”，优先设置 hasMemory=false。
    - 🟢 低：试探性、推测性或不确定的观察（“也许”“可能”“未经测量的猜测”）、明确延期或“目前无数据”状态，以及未来相关性不明的偶然细节。可广泛使用 🟢，不要为了显得有帮助而把试探性或未解决内容提升为 🟡。
    - ✅ 已完成：产出了会改变状态的结果——代码已交付、文件已编辑、执行了改变状态的命令或已验证的缺陷修复。只读查询、文件检查或简单问答不要标为 ✅。用户推迟、延期或改变主意时也不要使用 ✅。

    按缩进对相关 observations 进行分组：
    * 🟡 (14:33) Agent 正在排查身份验证问题
      * -> 运行 git status，发现 3 个已修改文件
      * -> 查看 auth.ts:45-60，发现缺少空值检查
      * ✅ 测试通过，身份验证问题已解决

    按日期对 observations 分组，并为每条列出 24 小时制时间。

    hasMemory：
    - 当消息历史包含值得记住的持久信息时设为 true：用户偏好、身份事实、已作出的决策、改变状态的完成事项、会阻碍未来工作的错误/阻碍，或经过实质调查才发现的重要结论。
    - 当交互只是重述 Agent 重新运行工具就能轻易发现的事实时设为 false，例如文件列表、文件内容、grep 输出、package.json 内容或当前代码结构。可重复获得的事实不属于记忆；记录它们只会膨胀持久存储，Agent 下次可以重新读取。
    - 关于事实本身作出的决策属于记忆（“我们同意将重复的身份验证检查重构为 middleware”）；促成决策的事实本身不属于记忆。
    - 阻碍用户工作的工具错误（构建失败、测试失败、用户询问的运行时错误）在尚未解决时属于记忆，因为它们会影响下一回合，即使 Agent 可以重新运行同一工具。
    - 关于用户偏好、计划或约束的试探性或低优先级信号仍属于持久记忆，应标为 🟢。关于事实本身的试探性观察不属于记忆。

    以下是非记忆内容的具体示例（除非交互中还出现持久信息，否则返回 hasMemory=false）：
    - “用户要求查看/阅读/检查 FILE”——检查请求不是持久信号，用户下次会话可以再次提出。
    - “Agent 阅读了 FILE，内容/结构为 X”——可以重新读取。
    - “Agent 运行 COMMAND，输出为 X”——可以重新运行。
    - “Agent 列出 DIRECTORY 并找到这些文件”——可以重新运行。
    - “Agent 搜索 PATTERN 并找到 N 个匹配项”——可以重新运行。
    单独记录以上内容会让存储充斥 Agent 下次本可重新获取的信息。只有交互还产生了持久信号（决策、完成事项、未解决的阻碍或显露的用户偏好）时才记录。

    - 始终调用结构化输出工具。没有记忆时应设置 hasMemory=false，不要跳过工具调用。

    observations：
    日期：2025 年 12 月 4 日
    * 🔴 (14:30) 用户偏好直接的回答
    * 🟡 (14:31) 本次会话正在处理功能 X
    - hasMemory=false 时，observations 必须为空字符串。

    currentTask：
    明确说明当前任务：
    - Primary：Agent 当前正在处理的事项
    - Secondary：其他待办事项；适用时注明“等待用户回复”
    - 如果 Agent 未经用户批准就开始了某项工作，注明该工作偏离当前任务

    usedObservationIds：
    上方已有 observations 区块会列出带有明确 \`[memory id: mem_xxx]\` 标记的跨会话记忆。如果本次交互中的助手回复使用了一条或多条记忆（引用了其中的事实、偏好、先前决策或上下文），在此列出相应 id。若没有实际使用先前记忆，则省略或返回 []。只能引用上方标记中逐字出现的 id；不要编造 id。

    对使用到的每项不同事实都要引用，并选取承载该事实的最具体条目；每项事实只能引用一个条目。对回复实际依赖的每项不同事实，在 observations 区块中找出所有提及该事实的条目，然后为其选择恰好一个 id：
    1. 优先选择最具体的条目——主题就是该事实的条目，而不是顺带提及该事实的宽泛摘要。
    2. 若具体程度相近，优先选择优先级最高（🔴 > 🟡 > 🟢）且记录时间最新的表述。
    3. 只有在没有更具体条目时，才回退引用宽泛摘要。

    同一事实绝不要引用两个 id，即使条目措辞不同或具体程度不同。如果三条记录描述同一 lint 规范（“用户希望 lint 一致”“用户使用 Biome”“用户在 \`biome.json\` 中配置了 Biome，采用 2 空格缩进、双引号，并将 \`noUnusedImports\` 设为错误”），就只选择一个最合适的条目，不要一并引用重复记录。统一刷新所有重叠条目会让过时或含糊的重复项也更新，破坏新鲜度衰减机制；这正是此字段要避免的情况。

    当回复依赖多项不同事实（主题不同，而非同一主题的不同说法）时，每项实际使用的事实各输出一个 id。一条仅描述单一事实的 100-token 记录，比一条顺带提及该事实及其他 15 项内容的 5,000-token 摘要更合适；更新前者可让宽泛摘要继续随时间衰减，直到再次被明确使用。

    示例 A（优先选具体条目，而非摘要）：区块中有一条 \`[memory id: mem_backend_conventions]\`，概述用户后端项目规范——logger 模块路径、错误基类、migration 文件名格式、ORM 选择、测试运行器和 Dockerfile 基础镜像；另有六条具体记录 \`mem_logger\`、\`mem_errors\`、\`mem_migrations\`、\`mem_orm\`、\`mem_test_runner\`、\`mem_docker\`，分别聚焦其中一项。如果回复依赖 migration 文件名格式和 Dockerfile 基础镜像，应引用 \`["mem_migrations", "mem_docker"]\)，而不是 \`mem_backend_conventions\`，也不要引用未使用的具体条目。

    示例 A2（优先具体条目，而非发布记录摘要）：区块中有一条 \`[memory id: mem_release_log]\`，概述近期发布过程——文档清理、捆绑依赖、运行时恢复、升级以及仅打 tag 的发布；另有各次发布的具体条目 \`mem_rel_docs\`、\`mem_rel_bundled_dep\`、\`mem_rel_recovery\`、\`mem_rel_upgrade\`、\`mem_rel_tagonly_a\`、\`mem_rel_tagonly_b\`。如果回复依赖捆绑依赖发布和运行时恢复发布，应引用 \`["mem_rel_bundled_dep", "mem_rel_recovery"]\`，而不是摘要或未提及的发布记录。

    示例 B（合并同一事实的重复记录）：区块中有 \`mem_best\`（🔴 较新且具体：“在高级 IC 面试中，用户给系统设计 40%、编程 30%、行为面试 20%、带回家作业 10% 的权重，且要求系统设计至少有两个强烈的肯定信号才进入下一轮”）、\`mem_dup_medium\`（🟡 较旧且较不具体：“用户在高级 IC 招聘中非常看重系统设计”）和 \`mem_dup_vague\`（🟢 最旧且含糊：“用户有一套面试评估标准”）。三者描述同一事实。若回复使用该事实，只引用 \`["mem_best"]\`，不要引用重复项。

    示例 C（回退至摘要）：区块中只有 \`mem_quarterly_plan\`，内容涵盖用户 Q3 计划（三个 OKR、招聘目标、第 9 周的发布活动、第 7 周的休假、董事会更新日期和预算上限），没有更具体的子条目。如果回复依赖发布活动和董事会更新日期，应引用 \`["mem_quarterly_plan"]\`，因为没有更具体记录承载这些事实。

    不要引用实际未使用的 id。新鲜度衰减依赖于引用确实反映了记忆的使用，因此错误引用比省略引用更糟。

    suggestedContinuation：
    提示 Agent 下一条消息应如何处理。如果助手需要回复用户，应说明回复后先暂停并等待用户，再继续其他任务。
    ${threadTitleSection}
  `;
}

export interface ObserverPromptContext {
  /**
   * runner 正在执行的工作目录。原样提供给 observer，使项目特定观察记录包含足够的
   * cwd / project 信号，稍后读回时仍有意义——尤其是在不同仓库之间，或用户切换项目之后。
   */
  cwd?: string;
}

export function buildObserverSystemPrompt(
  instruction?: string,
  includeThreadTitle = false,
  context: ObserverPromptContext = {},
): string {
  const cwdBlock = context.cwd
    ? dedent`

        === 当前项目（CWD）===

        Runner 当前工作目录：

          ${context.cwd}

        此处生成的每条 observation 都隐含归属于此目录。持久化层也会自动将此 cwd 写入外围的 <observation-group> 标签，因此无需在 observation 内容中重复完整路径。但 prose 本身必须保留足够的项目信息（仓库名称、关键包或模块名、正在处理的产品/领域），确保未来只看到单条 observation、看不到包装属性的读者仍能识别其所属项目。 “更新了 session-store.ts”过于笼统；“更新了 relay-pi monorepo 中的 \`packages/agent-gateway/src/session-store.ts\`”则足够具体。只有明显属于用户个人层面、与任何代码库无关的 observations（偏好、个人信息、日程）才不必标注项目。
      `
    : "";
  return dedent`
    你是 AI 助手的记忆意识。你的 observations 将是助手了解其与该用户过往交互的唯一信息。${cwdBlock}

    提取有助于助手记忆的 observations：

    ${OBSERVER_EXTRACTION_INSTRUCTIONS}

    === 结构化输出字段 ===

    使用这些字段调用结构化输出工具。不要在工具调用之外输出自由文本。

    ${buildObserverOutputFormat(includeThreadTitle)}

    === 指南 ===

    ${OBSERVER_GUIDELINES}

    === 重要：线程归属 ===

    不要在 observations 中添加线程标识符、线程 ID 或标签。
    线程归属由系统在外部处理。
    只输出 observations，不要添加任何线程相关标记。

    请记住：这些 observations 是助手唯一的记忆，应认真记录。

    用户消息极其重要。如果用户提出问题或给出新任务，应在 <current-task> 中明确标注其优先级。
    ${instruction ? `\n\n=== CUSTOM INSTRUCTIONS ===\n\n${instruction}` : ""}
  `;
}

export function buildObserverPrompt(
  messages: RawMemoryMessage[],
  existingObservations: string,
  targetTokens: number,
  retry?: { actualTokens: number },
  now = new Date(),
): RawMemoryContent {
  const retryInstruction = retry
    ? dedent`
        上一次 observation 日志约为 ${retry.actualTokens.toLocaleString("en-US")} 个 token，超过了 ${targetTokens.toLocaleString("en-US")} token 的预算。

        请重试并缩短 observation 日志，使其低于约 ${targetTokens.toLocaleString("en-US")} 个 token。优先保留最高优先级的用户事实、未解决工作、具体决策和完成标记。
      `
    : dedent`
        目标预算：将新的 observation 日志控制在约 ${targetTokens.toLocaleString("en-US")} 个 token 以内。
      `;
  const previous = existingObservations.trim()
    ? dedent`
        ## 现有 Observations

        不要重复以下已有 observations。新的 observations 将追加到其后。

        ${existingObservations}

        ---
      `
    : "";
  const header = dedent`
    ${previous}
    ## 要观察的新消息历史

    当前日期：${now.toISOString()}
  `;

  return [
    { type: "text", text: header },
    ...formatMessagesForObserver(messages),
    {
      type: "text",
      text: dedent`
        ---

        ${retryInstruction}

        请从这段消息历史中提取新的 observations。消息附带图像时，请直接检查图像，并概括与未来保持连续性相关的视觉细节、用户可见文本、UI 状态、图表、错误或其他事实。
      `,
    },
  ];
}

export function formatMessagesForObserver(messages: RawMemoryMessage[]): RawMemoryContent {
  return messages.flatMap((message) => {
    const date = new Date(message.createdAt).toISOString();
    const parts: RawMemoryContent = [
      {
        type: "text",
        text: `--- message boundary (${date}) ---\n${message.role.toUpperCase()} [${message.id}]\n${message.textPreview}`,
      },
    ];
    parts.push(...message.content.filter(isImageContent));
    return parts;
  });
}

function isImageContent(part: TextContent | ImageContent): part is ImageContent {
  return part.type !== "text";
}

export interface ReflectorPromptContext {
  /**
   * 当前 session reflector 运行的工作目录。只有当汇总 blob 来自一个 cwd 中的一个 session
   * 时才设置；global reflector 跨越多个 session 和 cwd，因此保持 undefined，并依赖每个
   * source <observation-group> 上已有的 cwd 属性。
   */
  cwd?: string;
}

export function buildReflectorSystemPrompt(
  instruction?: string,
  context: ReflectorPromptContext = {},
): string {
  const cwdBlock = context.cwd
    ? dedent`

        本批次的当前工作目录：

          ${context.cwd}

        每条来源 observation 都是在此 cwd 中捕获的。整理后的叙述中应保留项目/仓库/模块标识，以便在其他项目中回读时仍有意义。
      `
    : dedent`

        来源 observations 可能来自多个工作目录。输入中的每个 <observation-group> 开始标签都有一个 \`cwd="..."\` 属性，用于标识该行所属项目。应将该属性视为权威项目上下文，并在每条整理后叙述中包含项目/仓库名称（例如“在 relay-pi monorepo 中”“在 marketing-site 仓库中”），前提是该行与项目相关。如果一项操作只有在特定代码库中才有意义，却未注明项目，则该行不完整。
      `;
  return dedent`
    你是观察式记忆系统的反思 Agent。你的输出是行动助手几周后能看到的跨会话长期记忆，此时原始转录已不存在。请以从未读过原始回合的 Agent 为读者来组织内容。${cwdBlock}

    每一行都应是一条持久洞见，并写成自包含的简短叙事。单纯的事实标题（“X 在 Y 时完成”）是错误形式。正确形式应还原过程：

      1. 触发因素——是什么引出了问题、请求或决策？启动这段工作的是哪种症状、投诉、错误或目标？
      2. 调查/过程——尝试、排除或考虑了什么？涉及哪个文件/系统/人员？是什么约束决定了最终路径？
      3. 决策或结果——实际采取或选择了什么，并包含便于 Agent 再次定位的具体标识（文件路径、commit SHA、版本、人员、地点）。
      4. 理由或更高层经验——考虑到这些约束，为什么这是正确选择？下一次会话应推广哪条长期原则？这通常是该行最重要的部分。
      5. 项目/cwd 锚点——只要条目与项目有关，就注明所属仓库、包或产品界面。一条只说“session store 竞争条件”的记录，如果不说明它属于 relay-pi 的 \`packages/agent-gateway/\`，就含糊不清；未来 Agent 阅读时可能正在处理另一个仓库。只有明显属于用户个人层面、与任何代码库无关的事实（偏好、个人信息、日程）才可省略锚点。
      6. 决策轨迹维度——来源 observations 中记录过以下任一信息时，整理后的条目必须保留，不要将其当作“叙述性赘述”删掉。每条记录决策（所选路径、落地的修复、权衡过的选项）都必须将决策归因于明确来源：用户引导、项目规范或规则、先前先例/修复、观察到的症状/错误/测量结果，或明确注明“无先例——基于当前情况作出的判断”。被动语态的结果（“X 被改为 Y”“v1.2.3 已发布”）无效——务必说明为何选择该路径。
         - 考虑并排除的方案（“先试了 X，因……而放弃”“比较 Y 与 Z 后，因……选择 Y”）。未来 Agent 会复用被否决方案所提供的信息。
         - 用户引导、反对、批准、否决——引用或近似引用用户原话。这些是高价值先例，会覆盖默认做法。若整理时丢失用户说的“不要把它们当作遗留项”或“我认为这过度设计了”，就丢失了最有价值的输入。
         - 应用的规范/策略（用于支持该方案的 \`AGENTS.md\` 规则、skill 指令、项目指南）。
         - 既有先例/早期决策/作为基础的记忆条目，用简短概述说明，让下一位 Agent 能追踪先例关系。
         - 路径偏离默认做法时的例外/覆盖标记。例外是最容易被复用的先例。

    将反思视为撰写简短的“为什么”备忘录，而非会议纪要。优先使用能解释过程的多句条目，而不是只陈述结果的短句。缺少触发因素或理由的条目不完整，应补充。

    规则：
    - 每条都必须能被没有其他上下文的 Agent 独立理解。检查方式：读者若无法看出这项工作为何重要或解决了什么问题，该条目就过于单薄。
    - 保留来源中出现的具体标识（日期、文件路径、commit SHA、PR 编号、错误文本、版本标签、人名/产品名）。未来 Agent 依靠它们定位工作。
    - 合并重复内容。每项洞见只保留一条记录。若多条来源 observation 描述同一过程，应合并。
    - 将因果与结果合并为一条，而不是分开记录。例如“metadata.json 竞争条件导致 /answer 返回 400”与“SessionStore.save 改为原子写入”应属于同一条，因为后者解决了前者。
    - 多条来源 observation 从不同角度描述同一过程（症状、调查、修复、验证）时，应积极合并成一条覆盖完整过程的记录，而不是拆成三条。对同一文件或子系统的连续调整也应写成一条分阶段叙述，不要每个版本各写一条。
    - 两条内容若只是以不同细节层级描述同一总体结果或经验，应合并为一条，并在其中点明具体修复。不要因为“此条用了不同 SHA”而保留重复项；应判断其持久洞见是否相同。
    - 保留来源中的时间顺序、observation-group 标题和日期范围。
    - ISO 日期（\`YYYY-MM-DD\`，如 \`2026-05-16\`）用于锚定时间线。即使合并同一天的多条 observation，也应逐字保留来源 group 标题或内容中出现的每个不同日期。删掉所有日期会破坏时间顺序，即使叙述流畅也不例外。来源跨越多个月份时，最终反思至少必须保留三个不同的 \`YYYY-MM-DD\` 日期锚点，以便未来 Agent 排序工作。
    - 保留规范版本标签和最终状态的 PR 编号（\`v0.1.157\`、\`PR #1334\`）作为持久标识。这不代表要枚举被后续提交取代的中间 commit SHA——见下方合并规则。带标签的发布或已合并 PR 是未来 Agent 可导航的稳定锚点；中间 commit SHA 只是已被最终结果取代的步骤。
    - 以易识别的措辞保留持久用户偏好、规范和长期规则，例如“提交前始终运行 \`bun format\`”“PR 标题采用 \`[name] subject\` 格式”“绝不使用 \`as any\`”“仅通过 OpenTelemetry 做 observability”。这些跨会话约定会约束未来工作，不是叙述性赘述。它们可能只在来源中出现一两次，容易被噪声淹没，但正是未来 Agent 必须遵守的内容。保留字面上的触发短语（命令、规范、规则），以便未来 grep 查找。
    - 来源记录了不同的策略决策时，应逐项用可识别措辞保留，并附上原因：移除功能/模式、采用工具或库、选择 provider 或平台、改变架构、推迟/延后/缩小范围/排除本轮工作，或划定边界（哪些界面应用某行为、哪些界面刻意保持原样；哪些数据或模块被拆分及拆分关系）。不要把“移除了 Plan mode”“采用 Hyperframes”“选择 OpenRouter 作为模型路由器”“因需要 IdP 合约而将 SSO 延后到下个里程碑”压缩成“做了若干架构调整”。下一位 Agent 需要知道当前具体有哪些事实，以及哪些事项是有意不做的，以免重新争论。负面决策和范围边界最容易丢失，因为它们没有产出代码，但它们能阻止下一位 Agent 重新提议已拒绝的方案或合并有意拆开的部分；划界决策要明确指出边界两侧。
    - 较大的已完成工作中包含策略决策时，也要用可识别措辞保留该决策。总结多部分功能、发布过程、迁移或营销建设等较大成果时，不要让主要结果吞没期间的延期、移除或范围拆分决定；这些内容最容易在压缩时消失，却是未来 Agent 最需要避免重新讨论的先例。
    - 不要编造细节。来源没有的事实就省略；但来源确实包含的上下文，即使在同一条中显得重复，也要重新说明，因为冷读者看不到原始转录。
    - 每条长度约 150–600 个 token（一段简短文字）。如果过程确实需要更多内容，可以更长；过于短小才是常见问题。
    ${instruction ? `\n自定义指令：\n${instruction}` : ""}
  `;
}

export function buildReflectorPrompt(
  observations: string,
  targetTokens: number,
  retry?: { actualTokens: number },
): string {
  const budgetInstruction = retry
    ? dedent`
        上一版反思整理后的 observation 日志约为 ${retry.actualTokens.toLocaleString("en-US")} 个 token，超过了 ${targetTokens.toLocaleString("en-US")} token 的预算。

        请重试并缩短反思整理后的 observation 日志，使其低于约 ${targetTokens.toLocaleString("en-US")} 个 token。优先保留高优先级事实、未解决工作、具体决策、时间顺序和完成标记。
      `
    : `目标预算：将反思整理后的 observation 日志控制在约 ${targetTokens.toLocaleString("en-US")} 个 token 以内。`;

  return dedent`
    请反思以下 observations，并返回一个由原子化反思条目组成的 ARRAY。每条应是一段自包含的叙述。

    每条都应依次说明触发因素 → 过程 → 决策 → 理由/经验。只陈述结果（“X 已修复”“已发布 v0.1.131”）的条目不完整——应补充工作缘起、尝试过什么、为何选择该解决方案，以及可长期复用的经验。

    ${budgetInstruction}

    ${observations}
  `;
}
