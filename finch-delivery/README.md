# 成果库 · Artifacts

一个安静运行在后台的小工具：AI 每次帮你生成一份文档或图片，它就悄悄记一笔账，让你随时找得到、看得到、跳得回去。

## 这是什么

聊着聊着，AI 可能已经帮你写了好几份 Markdown 报告、导出过 PDF、画过几张图……但这些文件散落在不同的会话里，过几天想找出来往往要翻半天聊天记录。

**成果库** 做的事情很简单：只要 AI 生成的是"能读的文档"——Markdown、Word、PPT、PDF、Excel、网页、图片——它就会自动帮你登记一条记录，包括标题、简介、生成时间、以及是在哪个会话里产出的。你不需要做任何操作，登记是全自动的。

> 代码、配置文件（`.ts`、`.py`、`.json` 等）不算在内——成果库只关心你会打开来看、会分享给别人的"成品文件"。

## 在哪里能看到它

装好之后，你会在三个地方看到它：

- **左侧栏「成果库」入口**：点开是一个独立页面，汇总你在所有会话里产出过的全部文件，随时可以逛一逛、找旧文件。
- **右侧「成果库」面板**：在某个具体会话里，从面板菜单打开它，看到的默认是"当前会话"这次对话产出了什么。
- **侧边栏「生成文件」提示行**：某个会话一旦有文件产出，聊天侧边栏会自动出现一行摘要，比如「生成文件 · 3个MD」「生成文件 · 5个文件」，点一下就直接打开面板。

三处入口用的是同一个图标（一个小书架 📚），风格是统一的。

## 怎么用

成果库默认按**成果流**展示：按天分段，每份成果先显示标题和说明，下面一行小字写明所属项目和文件名，读起来像一份工作记录。右上角可以切换到**卡片**视图，卡片视图可以按项目、文件夹或日期分组，按项目分组时能拖动调整项目顺序。

- **顶部一句话** — 一共多少份成果、本周新增多少、来自几个项目。
- **筛选** — 标签页可选全部、当前会话（只在右侧面板里出现）和收藏；旁边可以搜索标题、说明和文件名；下面一排按项目筛选；类型下拉框只列出实际有的文件类型。
- **同一份成果只占一条** — 同一个文件交付了多次（比如改了几轮的方案），只显示最新一次，旁边标“交付 N 次”。点这一条会展开全部交付记录，点其中一行就打开那一次的文件。同一会话、同一文件夹里连续生成的一批图片会合成一组，每张都能单独打开。
- **点击成果** → Finch 能预览的文件（Markdown、文本、图片、网页、100MB 以内的 PDF、20MB 以内的 .docx/.xlsx）在 Finch 里预览，其余的用电脑上该类型的默认应用打开。
- **收藏** — 重要的成果点星标收藏，在“收藏”标签页里集中查看。
- **复制当天成果** — 鼠标移到某一天的标题上，可以把当天的成果复制成一份清单，写日报时直接用。
- **右键菜单** — 在 Finch 中预览（能预览时）、用默认应用打开、在文件夹中显示、复制文件路径、复制成果摘要、收藏、跳转到对应会话、删除。
- **悬浮时卡片角落会出现几个小按钮**：
  - ✎ 添加批注 — 把这份文件作为引用插入当前对话的输入框，方便接着跟 AI 讨论它（只在右侧面板里出现，见下）
  - 📂 在文件夹中显示 — 在访达（Finder）或资源管理器里定位并选中这个文件
  - ↗ 跳转到这份文件是在哪个会话里生成的
  - ✕ 删除这条记录——会先弹出确认弹窗，里面还有一个“同时把文件移到废纸篓”的勾选框，**默认不勾选**；勾上再确认，原文件会被移到废纸篓，可以从废纸篓里恢复。交付过多次的成果会一起删除全部交付记录

文件被移走或删除的成果会标明“文件已移动或删除”。成果库更新后，已经打开的页面会自动刷新一次，你的筛选、展开状态和滚动位置都会保留。

AI 登记成果时，标题写的是成果本身，不带“V2”“初稿”这类版本标记；同一个文件改了几轮，会记成同一份成果的多次交付。

「添加批注」只在右侧面板打开时才会出现——因为它要把文件插入*当前对话*的输入框，而左侧栏的独立页面不属于任何一个具体会话，没有输入框可以插。

界面语言跟随 Finch 本身的中英文设置自动切换，深色/浅色皮肤也会自动适配，不需要额外设置。

## 常见问题

**会不会把我的代码文件也记录进去？**
不会。这个工具只登记 AI 明确产出的文档/图片类"成果"，源代码、配置文件从一开始就被排除在外。

**删除记录会不会把文件本身也删掉？**
默认不会——删除只清掉"记录"（一条索引），不碰磁盘上的原始文件。如果你在删除弹窗里主动勾选了“同时把文件移到废纸篓”，源文件会被移到废纸篓，误删了可以从废纸篓里放回去。成果库不会永久删除文件；Windows 上暂不支持移到回收站，勾选后文件会原样保留并提示你。

**数据存在哪里？会联网吗？**
所有记录都存在本地（Finch 的扩展私有存储里），不联网。成果库只读取它登记过的文件：用来显示图片缩略图、发现文件已被移走。只有你在删除弹窗里主动勾选时，才会把文件移到废纸篓。

**为什么要运行系统命令的权限？**
“用默认应用打开”“在文件夹中显示”“移到废纸篓”这三件事，Finch 还没有开放给小程序，所以成果库调用系统自带的命令来做：macOS 的 `open`、`trash`，Linux 的 `xdg-open`、`gio`，Windows 的资源管理器。只有你点了某一份成果时，才会对那一个文件执行，文件路径取自成果记录。

## 支持的文件类型

| 类型 | 扩展名 |
|---|---|
| Markdown | `.md`、`.markdown` |
| Word | `.doc`、`.docx` |
| PowerPoint | `.ppt`、`.pptx` |
| PDF | `.pdf` |
| Excel | `.xls`、`.xlsx`、`.csv` |
| 网页 | `.html`、`.htm` |
| 图片 | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.bmp` |

---

# Library · Artifacts (English)

A quiet little assistant that keeps a running tally of every document the AI hands you — so you never have to go digging through old chats to find it again.

## What it does

While you're chatting, the AI might write you a Markdown report, export a PDF, or generate a few images along the way. All of that tends to scatter across different sessions, and a few days later it's genuinely hard to find.

**Artifacts** solves this by automatically logging every "readable" file the AI produces — Markdown, Word, PowerPoint, PDF, Excel, web pages, images — along with its title, a short description, when it was created, and which session it came from. There's nothing for you to do; the logging happens on its own.

> Source code and config files (`.ts`, `.py`, `.json`, etc.) don't count — Artifacts only tracks finished files you'd actually open or share.

## Where you'll find it

Once installed, it shows up in three places:

- **"Artifacts" entry in the left sidebar** — a standalone page listing everything the AI has ever produced for you, across every session.
- **"Artifacts" panel on the right** — open it from inside a specific session to see what that conversation has produced.
- **A "Generated Files" row in the session sidebar** — appears automatically once a session has produced anything, e.g. "Generated Files · 3 MD" or "Generated Files · 5 files" — click it to jump straight into the panel.

All three entry points share the same icon (a little bookshelf 📚) for a consistent look.

## How to use it

Artifacts opens as a **timeline**: one section per day, each artifact led by its title and description, with its project and file name in a small line below — it reads like a work log. Switch to the **Cards** view in the top-right corner to group by project, folder or date; when grouped by project you can drag projects into your own order.

- **A one-line summary** at the top — how many artifacts, how many this week, from how many projects.
- **Filters** — tabs for All, Current Session (only in the right-side panel) and Starred; a search box for titles, descriptions and file names; a row of project filters; a type menu listing only the file types you actually have.
- **One entry per artifact** — when the same file is delivered several times (a plan revised over a few rounds, say), only the latest delivery is shown, marked "Delivered N times". Click the entry to list every delivery, and click a row to open that delivery's file. A batch of images generated in one session and folder becomes one album; each image still opens on its own.
- **Click an artifact** → files Finch can preview (Markdown, text, images, web pages, PDF up to 100 MB, .docx/.xlsx up to 20 MB) open in Finch's native file preview; everything else opens in your computer's default app for that type.
- **Star** the artifacts that matter; they collect under the Starred tab.
- **Copy a day's list** — hover a day heading to copy that day's artifacts as a list, handy for a daily report.
- **Right-click** for Preview in Finch (when it can), Open in default app, Show in folder, Copy file path, Copy summary, Star, Go to session and Delete.
- **Hover a card** to reveal a few small buttons in the corner:
  - ✎ add an annotation — inserts a reference to this file into the current conversation's Composer, so you can keep discussing it with the AI (only shown in the right-side panel, see below)
  - 📂 show in folder — reveals and selects the file in Finder or File Explorer
  - ↗ jump to the session where it was created
  - ✕ remove this record — a confirmation dialog pops up first, with an "Also move the file to the Trash" checkbox that is **unchecked by default**; checking it and confirming moves the original file to the Trash, where it can be restored. For an artifact delivered several times, every delivery is removed together

Artifacts whose file was moved or deleted are marked as such. After Artifacts is updated, pages that are already open refresh themselves once and keep your filters, expanded entries and scroll position.

When the AI records an artifact, the title names the artifact itself — no "V2" or "draft" markers; a file revised over several rounds is recorded as several deliveries of the same artifact.

"Add annotation" only appears when opened as the right-side panel — it inserts into *that conversation's* Composer draft, and the standalone left-sidebar page isn't tied to any single session, so there's no draft to insert into.

The UI language follows Finch's own language setting, and it adapts to light/dark skins automatically — nothing to configure.

## FAQ

**Will it also log my source code?**
No. Only document/image-type deliverables the AI explicitly produces get logged — source and config files are excluded by design.

**If I delete a record, does it delete the actual file too?**
Not by default — deleting only removes the index entry, not the file on disk. If you explicitly check "Also move the file to the Trash" in the delete dialog, the original file goes to the Trash, so a mistaken delete can be undone. Artifacts never deletes files permanently; on Windows moving to the Recycle Bin isn't supported yet, so the file is left in place and you're told so.

**Where's the data stored? Does it need internet access?**
Everything is stored locally in the extension's own private storage — no network access. Artifacts only reads files it has recorded: to show image thumbnails and to notice files that were moved. It moves a file to the Trash only when you explicitly check that box in the delete dialog.

**Why does it need permission to run system commands?**
Finch doesn't offer "open in the default app", "show in folder" or "move to Trash" to mini tools yet, so Artifacts uses the system's own commands: `open` and `trash` on macOS, `xdg-open` and `gio` on Linux, File Explorer on Windows. They only run on the one file you clicked, with the path taken from the artifact's record.

## Supported file types

| Type | Extensions |
|---|---|
| Markdown | `.md`, `.markdown` |
| Word | `.doc`, `.docx` |
| PowerPoint | `.ppt`, `.pptx` |
| PDF | `.pdf` |
| Excel | `.xls`, `.xlsx`, `.csv` |
| Web | `.html`, `.htm` |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp` |
