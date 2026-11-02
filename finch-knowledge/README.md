# Knowledge Base

Search documents where they already live. Choose a local directory, keep its folder structure, and organize documents with independent tags.

## Install

```bash
npx @finchtoys/minitools add finch-knowledge
```

Enable **Knowledge Base** in Finch’s Toolcase, then open it from the sidebar.

## Set up your library

The setup page shows three local engines and your source directory together. Search and document engines prepare automatically; choose a directory with the system folder picker while they run. Once these required engines are ready and a directory is selected, click **Enter Knowledge Base**. OCR is prepared silently in the background on the first image and does not block entry; that image continues automatically after preparation. Progress and failures remain visible. Empty and populated directories are both accepted; no source index is created before your choice.

- An existing `.knowledge/` opens that directory’s library.
- Otherwise, `.knowledge/` is created for its catalogue, tags and search index.
- Files stay in their original locations. Switching directories never copies the previous library into the next one.
- Downloadable engines remain in Finch’s local cache, not your source directory.

Each time a directory is opened, Knowledge Base checks it in the background: new files are indexed, changed files are refreshed, and confirmed missing files are removed from the index. Files that cannot be read, or whose parent directory is unavailable, keep their previous indexes and are reported. Hidden files, symbolic links and `.knowledge/` are skipped.

## Switch knowledge bases

Open the bottom-left library menu and choose **Add knowledge base…** to select another source directory. Each directory stays in the list, labelled with its folder name and full path. Click a library to switch; the current library is checked, and the list and selection are remembered after restart. Your previous single-library selection is kept automatically.

Browsing, tags, indexing and both in-app and assistant searches use **only the currently selected library**. There is no cross-library search. Switching clears the previous library’s filters and search results without copying files or merging indexes. Each local directory retains its own `.knowledge/` and tags; mounted network directories keep independent indexes and tags on this computer. If a drive is unavailable or a switch fails, the current usable library remains selected and the unavailable entry stays registered for a later retry.

### Mounted SMB/NAS and network folders

Mount or map the share in your operating system first, then add its folder through the same library picker. Windows UNC paths and mapped network drives, macOS SMB/NFS mounts, and Linux CIFS/NFS mounts are detected automatically. A local disk or USB drive continues using its existing `.knowledge/`.

For a network source, **no index or tags are written to the share**. Each selected remote directory has a separate index under Finch’s local mini-program data (`remote/<opaque-id>/`). Reopening the same share subdirectory reuses its index; another share or subdirectory gets a different one. Reusing a mapped drive letter for another share does not reuse the previous share’s index. The footer explains when an index is local, and the assistant’s library information reports its location.

The share must already be mounted and readable; this tool does not log in, mount shares, or store credentials. An interrupted scan never treats an unavailable root as an empty library. Reconnect and retry to continue; this is not a file backup or a guaranteed offline browsing mode. Existing `.knowledge/` data on a network share is left untouched, not opened, copied or automatically migrated: the first local scan rebuilds its index, and tags on the old share are not imported.

## Use your documents

- Manage source files in your system file manager. Use **Open source folder** to get there, then **Scan and update** to reconcile indexes.
- Knowledge Base manages indexes and tags, never original files: it cannot import copies, save web pages, create Markdown, rename, move, delete or back up source files.
- Browse **Source folders** at the top of the sidebar. Only folders containing indexed documents appear; selecting one includes its subfolders and scopes browsing and search.
- **Tags** live below the folders. Only user-created tags appear here. Hovering or focusing a tag replaces its count with rename/delete actions without shifting the label. Apply one or more tags from the **Tags** context submenu; its checkboxes stay open without instructional text. For files, choose **Tags → New tag** from the context menu; creating a tag is never a separate top-level file action. The tag section also has a right-click creation shortcut. Context menus and tag submenus open to the right by default and flip left near the window edge. Click the dot before a tag to open its color plane and hue strip directly—no hover-only color button, large preview, or second popup. HEX input and presets stay synchronized; cancel leaves the tag unchanged, and Default restores gray. Tags do not move files or duplicate their search indexes.
- Search a tag with the magnifier, or use the book button in chat to draft a question for your assistant.
- Ask the assistant to index a new file or scan the directory after edits. Tool paths are relative to the selected knowledge directory, not the chat’s working directory.

The directory is the source of truth. Scanning follows moved folders, removes confirmed obsolete paths, and repairs duplicate old/new mappings. Uniquely identifiable moved files keep their document IDs and tags. Unreadable locations remain indexed until absence can be confirmed. Empty files and sources without searchable text are listed as skips, separately from real processing failures. Original files are never changed.

Drag the boundary between the sidebar and document list to resize the sidebar between **220 and 420 px**. The two panes have a compact **8 px** gap; the resize guide disappears immediately after release, even when the pointer stays over it. Your width is remembered; double-click resets it, and arrow keys also resize. Smaller windows tighten the upper limit to preserve room for documents; narrow views stack vertically.

New and renamed tags use a padded, rounded input row with a neutral fill, not an isolated underline. Opening a system folder clears temporary row highlights and actions when Finch loses focus; returning does not replay stale hover, and editing drafts are preserved.

Opening the library triggers an automatic scan only when the directory has not been scanned within the last **30 minutes**. This interval is remembered per directory across reloads/restarts. **Scan and update** and assistant-requested scans remain available at any time. Use **Clear notices** in the scan popup to dismiss the current report and its triangle; this does not remove indexes or diagnostic records.

Folders get the remaining sidebar space. Tags retain a 160 px minimum area when space permits, reduced in short sidebars, and grow with their content up to a capped height; each list scrolls independently. The empty-tag guide is centered in that area rather than squeezed against the footer. Scrollbars appear only on hover or while scrolling, then fade after scrolling stops. Sidebar scrollbars use the existing right padding rather than narrowing tag/folder rows; file columns stay aligned.

Scan completion appears briefly at the top center and dismisses automatically, never at the bottom. The warning button beside **Scan and update** opens individual notices without taking space in the document list. Rows show their status at the far right; hovering or focusing replaces it with file actions. Unassigned files have no placeholder badge.

The top toolbar is the single home for scanning and opening the source folder. The footer menu only lists knowledge bases, adds or switches libraries, and checks the runtime. Empty lists use a directory-aware guide; empty tag scopes and active scans have separate messages, without duplicate action buttons.

## File details and search

Click a tag badge in a file row to switch directly to that tag, just like the sidebar; this filters the list without opening the file or modifying its tags.

The list shows **Name, Date modified, Type, Size and Index status**. Modification dates and sizes come from the original files, not their indexes. Click a column heading again to reverse sorting across the current folder/tag, including later pages. Unavailable attributes show a dash. Narrow panes hide secondary columns; hover a row for its complete details.

An empty search shows only a short prompt. Results appear after typing; no matches get a separate suggestion to try other keywords. Scan notices open from the triangle to the left of **Scan and update**.

## Document states

Each row shows one actionable state: **Processing**, **Indexed**, **Update needed**, **Index needed**, **Incomplete index**, **Processing failed**, **Source missing**, **Unavailable**, or **Not checked**. Hover for the cause and passage coverage. A complete index is not enough to show Indexed: the source must still match it. Failed updates retain previous passages; failure details survive reopening. Scanning repairs missing/incomplete passages even when the original is unchanged. Status changes patch rows without resetting scroll.

## Existing installations

Use your filesystem backup software for originals. Knowledge Base has no source-copy or backup route; its catalogue, vectors and tags live in `.knowledge/`.

Only source-directory indexes are supported. Existing `.knowledge` indexes, tags and colors are retained. The retired managed-copy format is not opened or migrated; historical files are left untouched, never automatically deleted.

## Supported files and privacy

Markdown, plain text, Word, PDFs with a text layer, and images; up to **200 MB** per file. Scanned PDFs need a text layer or separately exported images for OCR. Supported platforms: Apple Silicon macOS, Linux x64/arm64, Windows x64/arm64.

Search is **lexical, not semantic**: use words that appear in your documents. Indexing and page searches stay local. When the assistant retrieves passages, their contents and original paths enter the conversation and may be sent to your selected model provider.

---

# 知识库

直接检索已有目录中的资料，保持原来的目录结构，用独立标签整理资料。

## 安装

```bash
npx @finchtoys/minitools add finch-knowledge
```

在 Finch 工具箱启用 **知识库**，从侧栏打开。

## 一次完成准备

初始化页同时显示三个引擎和资料目录。检索与文档引擎自动准备，期间也能通过**系统文件夹选择器**选择资料目录，不需要手输路径。OCR 标记为按需加载，首次处理图片时才在后台准备，准备后自动继续当前识别，不弹窗口；进度与失败原因仍可查看。

**检索、文档引擎就绪＋目录已选定**后，点击 **进入知识库**。空目录和已有资料的目录都可以；选定前不会在资料目录建立索引。

- 有 `.knowledge/`：打开该目录已有的知识库。
- 没有 `.knowledge/`：创建它，用来保存数据库、标签和检索索引。
- 文件保持原位；切换目录不会把旧库复制进新目录。
- 引擎下载缓存留在 Finch 本机数据目录，不放进资料目录。

每次打开目录，会在后台增量核对：新增文件入索引，修改文件更新索引，确认删除的文件清理索引。文件暂不可读或父目录不可用时保留旧索引并提示。跳过隐藏文件、符号链接和 `.knowledge/`。

## 切换知识库

打开左下角知识库菜单，点 **添加知识库…**，通过系统选择器选择另一个资料目录。每个目录会保留在列表中，显示文件夹名及完整路径；点击即可切换，当前库带勾选标记，列表与当前选择在重启后保留。旧版已选目录会自动加入列表。

浏览、标签、索引、页面搜索与 AI 检索都**仅针对当前选中的知识库**，不做跨库检索。切换会清除上一库的筛选和搜索结果，不复制文件、不合并索引；每个本地目录继续使用自己的 `.knowledge/` 和标签；网络挂载目录则使用各自独立的本机索引和标签。磁盘暂不可用或切换失败时，保留当前可用知识库，离线目录仍留在列表中以便稍后重试。

### 已挂载的 SMB/NAS 与网络目录

先在操作系统中挂载或映射共享，再通过同一个知识库选择器添加目录。自动识别 Windows UNC 路径与映射网络盘、macOS SMB/NFS 挂载，以及 Linux CIFS/NFS 挂载；本地硬盘和 USB 外接盘继续使用原来的 `.knowledge/`。

网络目录**仅读取，不在共享中写索引或标签**。每个选中的远端目录分别使用 Finch 本机小程序数据目录中的 `remote/<独立标识>/` 索引；重新打开同一共享子目录会复用，换共享或子目录则隔离。同一网络盘符改为映射另一个共享时，不会误用上一共享的索引。左下菜单会说明索引保存在本机，AI 的知识库信息也会显示实际索引位置。

需要共享已挂载且可读；小程序不负责登录、挂载或保存凭据。扫描时根目录断连不会按空库清理索引，恢复连接后可重试；这不是原文件备份，也不承诺完整离线浏览。远端已有的 `.knowledge/` 原样保留，不打开、不复制、不自动迁移；首次本机扫描重新建立索引，旧远端标签不会自动导入。

## 使用资料

- 在系统文件管理器中管理原文件；顶部 **打开资料目录** 可直达原目录，完成后点 **扫描更新**。
- 知识库只管理索引与标签，不管理原文件；不提供复制导入、保存网页、新建 Markdown、改名、移动、删除原件或复制备份入口。
- 左侧上方是 **资料目录**：仅显示已有索引的目录，选中后浏览和搜索包含其子目录，不展示空目录或尚未索引的目录。
- 下方的 **标签** 仅显示用户创建的标签，不显示系统占位标签；未打标签的资料仍在「全部资料」中。悬停或键盘聚焦标签时，计数由编辑/删除按钮替换，名称和行宽保持不变。在右键菜单的 **标签** 中独立勾选或取消，菜单保持打开，不再显示多选说明。文件右键菜单中通过 **标签 → 新建标签** 创建，外层不再单列入口；标签区右键也可新建标签。右键菜单和标签子菜单默认向右展开，靠近窗口右边缘时自动向左。点标签名前的色点直接打开色板与色相条，不用悬停找颜色按钮，也没有大块预览或第二层弹窗；HEX 与预设颜色同步，取消不改动标签，默认可恢复灰色；一份资料可带多个标签，不移动文件、不复制索引。
- 用放大镜检索当前标签，或用对话工具栏的书本按钮编辑提问模板。
- 可以请 AI 索引新文件，或在编辑后扫描目录。工具的相对路径以知识库目录为根，不以当前聊天工作目录为根。

目录实际内容是唯一依据。扫描会跟随目录移动，清理确认消失的旧路径，并修复新旧路径重复计数；可唯一识别的移动保留索引标识和标签。无法访问时保留映射，待可确认后再清理。空文件、图片未识别到文字、没有可检索文字会分别提示为跳过，不计为处理失败；原文件始终不变。

左右栏之间可拖动调整左栏宽度，范围为 **220–420px**，两栏间距为 **8px**，松手后分隔线立即隐藏，即使鼠标仍停在原处。会记住调整结果；双击恢复默认，也可用左右方向键调整。窗口较小时会自动收紧上限，为右侧资料列表保留空间；窄窗口保持上下排列。

新建和重命名标签使用带留白、浅底和完整圆角边框的输入行，不再只有一条下划线。打开系统文件夹导致 Finch 失焦时，临时行高亮和操作状态会清除；切回不会恢复旧悬停，编辑中的文字仍保留。

打开知识库时，同一目录 **30 分钟内不重复自动扫描**，记录在重开或重启后仍有效；手动点 **扫描更新** 或让 AI 主动扫描不受限制。提示气泡里的 **清空提示** 可关闭本次报告并隐藏三角，不删除索引或诊断记录。

目录占用侧栏的主要空间，标签区在空间足够时保留 160px 最小高度，较短侧栏随可用空间收紧，按内容增长并限制最高高度，两个列表独立滚动；没有标签时提示居中，不再挤在底栏上方，空目录也保留简洁引导。滚动条只在悬停或滚动时显示，停止后自动隐藏；侧栏滚动条放入原有右侧留白，不挤压目录、标签和计数，文件信息列也保持对齐。

扫描完成统一在顶部居中短暂提示，几秒后自动消失，不在底部显示；**扫描更新** 旁的三角提示按钮可查看逐项原因，不占资料列表空间。文件状态靠最右显示，悬停或键盘聚焦时由操作按钮替换；未打标签文件不显示占位标签。

顶部是扫描更新与打开资料目录的唯一主操作区；左下菜单仅保留知识库列表、添加、切换与运行环境检查。空库显示目录与操作指引，无资料的标签、加载和扫描中分别提示，不再重复放置操作按钮。

## 文件信息与搜索

点击文件行中的标签可直接切换到该标签，效果与侧栏一致；只切换筛选，不打开文件，也不改变它的标签。

列表显示 **文件名、修改日期、类型、大小、索引状态**。修改日期与大小读取原文件属性，不是索引的日期或体积。点击列头排序，再点切换升降序；排序覆盖当前目录或标签的全部资料，包含后续页面。无法读取的属性显示横线；窄栏自动隐藏次要列，悬停文件行可看完整信息。

搜索框为空时只显示一行提示，输入后才展示检索结果，未匹配时单独提示换关键词。扫描提示三角位于 **扫描更新** 按钮左侧。

## 文件状态

每行显示最重要的一项：**处理中、已检索、待更新、待索引、索引不完整、处理失败、原文件缺失、暂不可访问、待检查**。悬停可查看原因和片段完整度，不显示数据库名称。只有原文件与完整索引一致才标记已检索；失败更新保留旧索引，重新打开仍能看到失败原因。扫描可修复未改动文件的缺失索引，处理进度原位更新，不重置列表滚动。

## 旧版本兼容

原文件请使用系统备份软件备份。知识库不提供复制或备份路由，只在 `.knowledge/` 中维护目录、向量索引与标签。

只支持「原目录 + .knowledge」模式，现有目录索引、标签和颜色继续保留。旧托管库格式不再读取或迁移；历史文件原地保留，绝不自动删除。

## 文件类型与隐私

支持 Markdown、纯文本、Word、有文本层的 PDF 与图片，单文件不超过 **200 MB**。扫描 PDF 需补文本层，或将页面导出为图片再做 OCR。支持 Apple Silicon Mac、Linux x64/arm64、Windows x64/arm64。

当前是**词法检索，不是语义检索**，请尽量使用资料中出现的词语。索引与页面检索都在本地完成；AI 引用的片段及原文件路径会进入对话，可能发送给所选模型服务商。
