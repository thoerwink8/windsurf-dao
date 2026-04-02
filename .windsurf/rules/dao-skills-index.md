---
trigger: always_on
description: dao skills 可用列表。需要调试/重构/优化/测试/逆向/边界探测/前端设计/终端恢复/Windsurf扩展开发等技能时读取此文件。
---

# Skills 索引

> **硬门控**：收到用户请求后，先识别任务域（调试/重构/优化/测试/逆向/…），从下表加载对应 skill，**然后**才读业务代码。见文件名就读文件 = 惯性，不是对齐。

用 `read_file` 读取对应路径的完整内容。

| Skill | 描述 | 路径 |
|-------|------|------|
| dao-debug | 调试诊断镜头：Bug难以定位、修了没好、错误信息不明确时，按四层逐级深入定位根因 | `.windsurf/skills/dao-debug/skill.md` |
| dao-refactor | 重构镜头：代码重复、过长函数、命名不清时，安全改善代码结构 | `.windsurf/skills/dao-refactor/skill.md` |
| dao-optimize | 性能优化镜头：代码运行缓慢、内存占用高时，量化瓶颈后精准优化 | `.windsurf/skills/dao-optimize/skill.md` |
| dao-test | 测试镜头：需要为代码添加测试、验证功能正确性时，按 AAA 模式编写高覆盖测试 | `.windsurf/skills/dao-test/skill.md` |
| dao-boundary-probe | 边界探测术：集成外部系统前，识别隔离机制并用最小穿透测试确认可行路径 | `.windsurf/skills/dao-boundary-probe/skill.md` |
| dao-reverse-engineering | 逆向拆解术：面对未知/混淆的代码库时，系统化的逆向分析流程 | `.windsurf/skills/dao-reverse-engineering/skill.md` |
| dao-frontend-aesthetics | 前端审美术：在受限空间中设计高信息密度、高辨识度的界面 | `.windsurf/skills/dao-frontend-aesthetics/skill.md` |
| dao-terminal-resilience | 终端韧性术：终端卡死诊断与Agent五感降级恢复 | `.windsurf/skills/dao-terminal-resilience/skill.md` |
| dao-windsurf-extension | Windsurf扩展术：Windsurf扩展开发的已验证技术约束与最佳实践 | `.windsurf/skills/dao-windsurf-extension/skill.md` |
