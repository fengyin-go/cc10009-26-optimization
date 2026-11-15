# 网页采集配置管理工具

离线版采集配置管理工具，涵盖站点管理、抽取模板编排、代理池配置、限速策略、重试机制、增量采集与数据落盘规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/data/retry/       失败重试领域：异常清单、重试批次引擎、存量迁移
│   ├── src/stores/           会话与筛选状态
│   ├── scripts/              重试引擎测试与 esbuild 测试打包器
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

重试批次引擎的确定性验证（假时钟 + 内存存储，不依赖浏览器）：

```bash
cd frontend
npm run test:retry
```

## 失败重试链路（失败记录 → 重试批次 → 采集作业）

重试领域代码在 `frontend/src/data/retry/`，独立于通用 CRUD 台账，单独持久化到
localStorage 的 `scraper-config-studio:retry-batches`：

| 文件 | 职责 |
| --- | --- |
| `exception-catalog.ts` | 可重试/不可重试异常清单与分类口径 |
| `types.ts` | 失败尝试、重试批次、作业重试视图等领域模型 |
| `retry-store.ts` | 批次持久化、宽容读取、中断恢复（running → waiting） |
| `policy.ts` | 通用台账 retry 行到重试策略的归一化（兼容占位文本字段） |
| `retry-engine.ts` | 核心引擎：批次合并、指数退避、事务回退、转存幂等 |
| `migration.ts` | 存量失败记录一次性迁移，历史尝试按原顺序保留 |
| `retry-service.ts` | 浏览器侧单例服务，页面只通过它读写 |

关键语义：

- **窗口内共享一个计划批次**：同一关联任务存在 `waiting/running` 批次时，新的失败上报只并入
  （`mergedFailureCount+1`、追加 attempts），不新建批次、不重算退避；批次级互斥锁保证并发触发
  只计算一次退避。
- **不能跳过等待**：退避窗口未到期时 `executeRetry` 直接拒绝并返回剩余等待秒数。
- **事务失败退回等待**：执行器抛错后批次回到 `waiting`，从最后一次尝试时间起算下一轮指数退避。
- **中断恢复**：落盘为 `running` 的批次在下次加载时统一退回 `waiting`，沿用原定退避窗口。
- **转存只做一次**：`dumpCount` 是 0→1 的幂等闸门，达到最大重试次数或命中不可重试异常后只转存一次；
  转存后的失败上报仅在原批次留痕，不再开在途计划。
- **历史尝试只追加**：成功恢复（`recovered`）后全部失败尝试按原顺序保留。
- **异常口径**：同时命中两张清单的冲突异常按不可重试处理；未登记异常保守视为不可重试；
  老记录自带的 retryable 标记仅留档，一切以已知异常清单为准。
- **状态同步**：采集任务页、采集监控页通过 `jobView` 显示「正在等待退避 / 重试执行中 / 已恢复 /
  已失败转存」，暂无下一次尝试时写明原因；反爬对抗页可模拟识别服务中断观察回退与空态说明。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点管理 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 抽取模板 | `template` | 网页模板 | 模板编号、入口地址、列表选择器 |
| 代理池管理 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 采集任务 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度策略 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬对抗 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速控制 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 失败重试 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量采集 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-config-studio:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据采集、爬虫与RPA
