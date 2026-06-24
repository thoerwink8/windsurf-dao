# 附录 C · 设计 Token 工具链参考

### C.1 Token 定义与管理

| 工具 | 定位 | 适用场景 |
|------|------|---------|
| **CSS Custom Properties** | 原生浏览器支持 | 中小项目首选，零依赖 |
| **Style Dictionary** | token 编译器（JSON → CSS/iOS/Android） | 多平台设计系统 |
| **Tokens Studio** | Figma 插件 + token 管理 | Figma 生态项目 |
| **W3C DTCG Format** | 标准化 token JSON 格式 | 未来趋势，工具链逐步支持 |

### C.2 视觉回归测试

| 工具 | 定位 | 适用场景 |
|------|------|---------|
| **Playwright Screenshots** | 免费、本地、灵活 | 开发阶段 QA |
| **Chromatic** | Storybook 集成 | 有 Storybook 的项目 |
| **Percy** | CI 集成 | 团队级视觉回归 |
| **BackstopJS** | 开源视觉回归 | 预算有限的团队 |

### C.3 设计-代码同步

| 工具 | 定位 | 适用场景 |
|------|------|---------|
| **Contract Tests** | 代码级设计断言 | 任何项目（推荐） |
| **Stylelint** | CSS lint 规则 | 拦截硬编码值 |
| **Design Lint (Figma)** | Figma 内 lint | Figma 生态项目 |
| **Penpot MCP** | AI 直接操作设计工具 | 有 Penpot 的 AI 工作流 |
