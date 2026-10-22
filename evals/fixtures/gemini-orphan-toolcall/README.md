# gemini-orphan-toolcall

来自 `balanced:xai` 会话的真实状态快照。该会话中的下一条用户消息（“Yes. I'm going to give the doc to a coding agent…”）触发了 Vertex 400 错误，模型为 `google/gemini-3.1-flash-lite-preview`：

> Please ensure that the number of function response parts is equal to the
> number of function call parts of the function call turn.

Gemini lite-preview 模型用于辅助调用（例如 memory / 标题生成），而不是主回合。因此，问题在于调用 Vertex 前侧信道如何重塑对话记录，而非主 balanced 路由器。

原始 `TurnState` 中的配对完整（25 个 toolCalls、25 个 toolResults、没有孤立项），所以损坏发生在 state 之后的辅助调用 wire 整形路径中。

来源：会话 `ms782syvyx9q9vpfdwbcdg37s5872bk9`，gen `gen_01KS6J16MPCTAVZVK6HSQQSKFD`。
