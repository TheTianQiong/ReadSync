# Reeden 同步插件

把 [Reeden](https://reeden.app)（Android 阅读器）的阅读数据从 WebDAV / S3 上读回来，导入本服务器：**阅读进度、阅读时长、书目信息、封面**。

Reeden 自身没有开放同步协议，但它在自己的根目录里留了一份完整的数据。这个插件就是把那份数据读出来 —— **只读，绝不改动**你的 Reeden 目录。

---

## 一、Reeden 在它的目录里留了什么

| 路径 | 内容 |
|---|---|
| `metadata` | zip，含 `book.json`（书目）、`read_record.json`（阅读会话）、`read_record_hourly.json`（按小时的阅读时长）等 |
| `book_progress/<bookId>.json` | 每本书的阅读位置：章节、段落、百分比、最后阅读时间、设备 |
| `covers` | zip，里面是 `<hash>.thumb` 封面图，`book.json` 的 `cover_thumb` 指向它们 |

`metadata` 与 `covers` 是**没有扩展名的 zip**，`book.json` 里的 `title` / `author` 是 UTF-8 中文。

### 三条数据源的取舍

这几条是从真实导出里核对出来的，直接决定了导入对不对：

- **进度**：取 `book_progress/<id>.json` 与 `book.json` 的 `last_read_time` 里较新的那个。
  `readProgress` 是 0–10000 的整数（`8592` = 85.92%），导入后按服务端口径换算。
- **时长**：优先 `read_record_hourly.json`，它的「书 + 日期 + 小时」粒度与本服务器的
  `reading_sessions` 完全对得上；`read_record.json` 是同一批数据的「会话」视图
  （时长记在开始的那一小时），但它**多出更早的若干天**，所以两份都读：
  hourly 覆盖到的日子用 hourly，其余日子按 `read_record` 的 `create_at` 归到对应小时。
- **两份绝不能相加。** 实测同一「书 + 日期」的日总数两边完全一致，相加会把时长翻倍
  （样本里会从 159202 秒变成 311791 秒）。这正是端到端验证里那条断言在守的东西。
- `book_progress` 里的 `todayStats` **不用**：它只覆盖当天一小段窗口，且会被轮转，
  而 hourly / record 是完整的。

### 时间戳口径

`read_record_hourly.json` 里的 `date` / `hour` 是**本地时间**，而 `read_record.json` 的
`create_at` 是 **UTC**。插件按「时区偏移」配置项换算（默认 +8），否则整天的时长会落到
错误的小时上、热力图会乱。这个偏移是从样本中核对出来的：按 +8 换算后，
两份数据的小时归属能逐条对上。

---

## 二、准备工作

1. 确认 Reeden 的根目录已经同步到你配置的存储上（Reeden 自带的 WebDAV / S3 备份）。
2. 在服务器上配好该存储：**设置 → 存储管理**，记下它的 **ID**。
   - 用 **WebDAV / S3**：直接把 Reeden 根目录填进插件配置即可。
   - 用**本地存储**：本地存储只允许数据目录内的路径，所以把 Reeden 目录放进
     `<数据目录>/storage/` 下（例如 `storage/reeden`），插件配置里
     「Reeden 根目录」填 `reeden`。
3. 准备一个接收数据的账号（导入到哪个账号由配置决定）。

---

## 三、安装与配置

```bash
# 打包并安装（在仓库根目录）
cd packages/server/plugins-samples/reeden-sync
zip -r /tmp/reeden-sync.zip .        # 注意：plugin.json 与 index.js 必须在 zip 根部
cd -
readsync plugin:install /tmp/reeden-sync.zip
readsync plugin:enable com.readsync.reeden-sync
```

也可以在**管理后台 → 插件**里上传 zip、启用、填配置。

| 配置项 | 说明 |
|---|---|
| 存储后端 ID | Reeden 根目录所在存储的 ID |
| Reeden 根目录 | 该存储下 Reeden 的根目录；留空表示存储根目录本身 |
| 导入到哪个账号 | 用户名或邮箱；进度与时长都记在它名下 |
| 进度目录名 | 默认 `book_progress`（有些版本是 `bookprogress`） |
| 时间戳时区偏移 | 默认 `8`；只影响那些 hourly 没覆盖到的早期数据 |
| 自动导入间隔 | 分钟；填 `0` 表示只在手动触发时导入 |
| 每日固定同步时间 | 默认 `23:55`；留空关闭 |
| 自动登记缺失的书目 | 默认开；关掉后只导入已在书库里的书 |
| 导入阅读时长 / 取封面 | 默认都开 |

配置改完**立即生效**，不必重启服务。

---

## 四、跑一次

```bash
# 立刻导入一次（名字就叫 sync）
readsync plugin:run com.readsync.reeden-sync

# 看插件任务有哪些
readsync plugin:list
```

## 五、导入之后

- 每本书的**文档标识就是 Reeden 的 bookId**（32 位十六进制）。这意味着：
  你在网页上看到的那串标识，和 Reeden 里的 `bookId` 是同一个值，对不上时可以直接核对。
- 阅读进度会出现在**书籍详情页**，阅读状态会自动从「未读」推进到「在读」。
- 阅读时长进入**统计**：趋势、热力图、阅读时长都包含这部分。
- 封面来自 Reeden 的 `covers`。**只给这次导入新建的书设置封面** ——
  你后来自己传过封面的书不会被覆盖。
- 平台标识是 `reeden`。想让它显示成中文名，可在**设置 → 阅读平台管理**里加一个
  id 为 `reeden` 的平台。

---

## 六、它为什么可以反复跑

导入是**幂等**的，定时任务会在后台一直跑，所以这点必须成立：

| 数据 | 幂等方式 |
|---|---|
| 书目 | 按 `bookId`（即文档标识）与 MD5 去重，已存在就复用 |
| 进度 | 走服务端统一同步接口的 upsert，同一文档只保留最新 |
| 时长 | **按天替换**：每次导入都先删掉该账号 + `reeden` 平台 + 这些天的旧行，再写入 |
| 封面 | 只对新建的书设置一次 |

「按天替换」还顺带处理了上游删除：插件记着上次导入过哪些天，这次没出现的天会被
清空，不会在本地留下早已不存在的数据。

---

## 七、验证

仓库里带一份端到端验证脚本，拿一份**真实的 Reeden 导出**跑完整链路：

```bash
READSYNC_DATA_DIR=./data-reeden REEDEN_SAMPLE=/path/to/你的/Reeden \
  npx tsx src/scripts/reeden-import-check.ts
```

`REEDEN_SAMPLE` 指向 Reeden 根目录（里面应有 `metadata`、`book_progress`、`covers`）。
脚本**只读**它，不会改动你的数据。

它会真的安装插件（走 zip 校验）、真的读 zip、真的写库，然后核对**从样本里独立算出来的**
数字：书目数、会话行数、总秒数、单日秒数、进度百分比、封面、以及「重跑一遍结果不变」。

注意那些期望值（18 本书、159202 秒、单日 8447 秒…）是**按一份具体样本算出来的**：
换一份数据跑时它们要对你的导出重新算过。这个脚本守的是「导入逻辑与样本口径一致」，
不是「所有导出都长这样」。

---

## 八、常见问题

**导入后时长对不上，比 Reeden 里显示的多**

检查是否只导入了 hourly 与 record 中的一份（两份相加会翻倍）。本插件默认按「hourly 优先、
record 补缺」处理，两者不会同时计入同一天。

**热力图上的时间点不对**

「时间戳时区偏移」没配对。hourly 里的时间是本地时间，record 里的是 UTC；
如果你的时区不是东八区，把它改成你的实际偏移。

**书都被登记了，但我只想导入已有的书**

关掉「自动登记缺失的书目」。这时只会导入按文档标识能在书库里找到的书，
其余会被计入「跳过」并在日志里体现。

**一本书都没导入**

先看日志。最常见的原因是存储路径不对 —— 本地存储的路径是**相对**服务器存储目录的，
填绝对路径会被拒绝。

**Reeden 目录里没有 `read_record.json`**

不影响：hourly 与「进度 + 书目」照样能导入，只是早期那些天没有时长数据。
