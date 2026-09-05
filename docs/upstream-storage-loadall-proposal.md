# 上游提案：dsh-storage-domain open() 惰性化（loadAll 全量物化的堆炸弹）

> 状态：提案草稿（拟提交 DSH 核心）。来源：dsh-approve-for-me 2026-09-06 线上 OOM 事故 RCA。

## 问题

`dsh-storage-domain` 的 `open(spec)` 对每个存储单元调用 `unit.loadAll()`，把**全部记录物化进进程堆**（dsh-storage-domain/lib/index.js: open → loadAll；dsh-storage-json/lib/index.js: loadPerRecordState 递归 readdir + readFile 全量解析）。这意味着：

- 任何"只增"型域（审计/事实/日志类）的**打开成本 = 全部历史数据的解析成本**，无界；
- 实测：dsh-approve-for-me 的 `approve_for_me` 域一天真实使用积累 2.5GB / ~1.5 万条记录（每条 ~150KB），插件启用即触发 open → 解析 2.5GB JSON → Node 默认 4GB 堆 OOM（从启动到崩溃 ~136 秒，恰为全量解析耗时）；
- per-record 布局只解决了**写放大**（单条 put 不再重写整个单元），完全没有解决**打开时全量物化**——这是当前设施层的结构性缺口。

## 影响面

任何用 storage domain 存事件/事实/审计类数据的插件都会撞上同一堵墙，只是时间问题。这不是某一个插件的误用：设施层语义（open=全量进内存）与"域可无限增长"的使用方式天然不兼容。

## 提案（按优先级）

1. **惰性记录读取（核心）**：`open()` 不调用 `loadAll()`；`table.get(key)` 首次访问时按需读盘并缓存（可有界 LRU）。内存占用从 O(全量数据) 降为 O(访问过的热数据)。
2. **键枚举 API**：`table.keys()`（或 `iterate()` 流式）——目前设施无任何枚举能力，连"这个域里有哪些键"都无法回答，保留期剪除/运维审计都因此只能绕路（dsh-approve-for-me 被迫维护进程内注册表作已知集合）。
3. **可选的打开时校验**：需要全量校验不变量的域，提供显式 `validate()` 或 open 选项，而不是把全量物化当作唯一路径。

## 兼容策略建议

- 默认行为不变（open 后 get 语义不变），仅把物化时机后移；对依赖"open 即全量驻内存"的调用方（如有），加 open 选项 `eager: true` 过渡。
- dsh-storage-json 的 per-record 单元天然支持惰性（每行一个文件）；whole-file 布局单元可继续 eager 或在打开时只读索引段。

## 插件侧已做的自限（供参考）

dsh-approve-for-me WP9：记录格式 v2（负载内容寻址 digest + 有界预览，150KB/条 → ~8.5KB/条）+ 生命周期保留期剪除（经 per-lifecycle 索引行拿键清单 + delete）。这把**增长速度**压下来了，但只要 open=loadAll 语义不变，"打开成本随存量线性增长"的结构性风险仍在——上游惰性化才是治本。
