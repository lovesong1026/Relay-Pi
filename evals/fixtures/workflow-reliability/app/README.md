# 合成目录应用

`bun run start` 会提供 Jobs 与 People 搜索表单，以及 `/api/search?category=people&q=...&nonce=...` 接口。API 返回 `{ids: string[], nonce: string}`。填充后的目录数据位于 `data.json`。

`provider.json` 中配置的 provider URL 接受 POST JSON 请求体 `{category, query, nonce}`，并返回 `{ids, nonce}`。这些 ID 表示本地数据中的匹配记录。API 响应必须保留 nonce。非成功响应表示搜索不可用；不得伪造匹配项。自然语言查询以及字面邮箱/公司匹配都必须适用于两个类别。

保持数据集、此合同、公共 API、表单和展示样式不变。现有的无匹配冒烟测试不足以证明填充数据搜索有效；还需验证真实 provider 及正向查询。
