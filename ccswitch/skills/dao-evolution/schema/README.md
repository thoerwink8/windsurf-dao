# Evolution CSV Schema

## evolution-entries.csv

| 列 | 类型 | 说明 |
|----|------|------|
| id | string | 条目 ID，格式 `e001`、`e002`... |
| status | enum | `draft` \| `mature` \| `synthesized` |
| date | string | YYYY-MM-DD |
| version | string | 项目版本号，如 `v1.22.6` |
| component | string | 组件/模块标识 |
| title | string | 一行摘要 |
| root_cause | string | 根因简述（分号分隔多条） |
| lesson_ids | string | 关联教训 ID（逗号分隔），如 `T140,T141` |
| tags | string | 标签（分号分隔），用于 BM25 搜索加权 |
| synthesized_to | string | 若 status=synthesized，指向合成后的条目 ID |

## evolution-lessons.csv

| 列 | 类型 | 说明 |
|----|------|------|
| id | string | 教训 ID，格式 `T1`、`T2`... |
| title | string | 短标题 |
| version | string | 发现时的版本 |
| component | string | 组件/模块标识 |
| detail | string | 完整因果分析：踩坑现象 → 根因 → 正确做法 |
| tags | string | 标签（分号分隔） |
| source_entry | string | 来源条目 ID |
| status | enum | `active` \| `deprecated` \| `review` |
| superseded_by | string | 若 deprecated，指向替代教训 ID |
