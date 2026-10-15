# 技术优化验收记录

日期：2026-10-15。保留原手算例，三个模型的计算实现不变。

| 任务 | 结果 | 验收 |
| --- | --- | --- |
| CS-01 | 完成 | 4 个固定种子，每种模型各 80 组输入；计数、分类、分页幂等、Reno 窗口边界与不修改输入均通过。失败辅助器输出种子和删除元素后不可再缩减的输入，不声称全局最小 |
| CS-02 | 完成 | 相同容量/块大小/相联度/序列复用 `simulateCache`；同步回放第 6 次访问时 LRU 替换块 1、FIFO 替换块 0；FIFO 无 3C 分类 |
| CS-03 | 完成 | 版本 1 URL 保存三类实验所有表单输入及当前实验；刷新恢复；64 位十六进制文本保持；非法版本及模型参数显式失败 |
| CS-04 | 完成 | Edge 真实点击、键盘、390×844 移动视口及 GitHub 文档导航通过；截图检查排版与可操作范围 |

## 实际测试

- Node 单测 71 项通过，保留原 57 项手算与边界例；新增性质和分享格式测试。
- Playwright 1.56.1 + 本机 Microsoft Edge，5 组浏览器测试全部通过。覆盖 Cache 0/8 与 5/8、页表 4/7 张、Reno 第 10/20 轮事件，以及分享恢复、错误焦点、移动端无页面级溢出。
- 文档链接通过真实点击打开 GitHub `article.markdown-body`，不是只检查 URL 文本。
- `npm run check` 检查 JavaScript 语法和本地资源；`git diff --check` 通过。
- [桌面策略对照](validation/cache-comparison.png)、[移动端 Reno](validation/mobile-reno.png) 是本轮真实渲染截图。

## 复验

```sh
npm ci
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

本机使用系统 Edge 时，在 PowerShell 设置 `$env:PLAYWRIGHT_CHANNEL='msedge'` 后运行浏览器测试。测试自动启动和关闭只监听 127.0.0.1:4193 的静态服务。文档导航测试需要 GitHub 网络连接，失败会正常报错。

分享参数放在 URL 中，不上传服务；领域取值仍由现有表单解析与三个模型校验，分享模块只验证版本和传输结构。默认模型约定和教学范围见 [模型说明](models.md)。
