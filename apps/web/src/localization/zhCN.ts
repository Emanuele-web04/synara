// FILE: zhCN.ts
// Purpose: Keeps this Chinese fork's presentation-only localization in one update-safe layer.
// Boundary: UI chrome is translated; user content, code, terminal output, paths, URLs, model names, and server diagnostics remain untouched.

const UI_TEXT: Readonly<Record<string, string>> = {
  "Add action": "添加操作",
  "Add Action": "添加操作",
  "Add panel": "添加面板",
  "Add project": "添加项目",
  All: "全部",
  Retry: "重试",
  Read: "已读",
  File: "文件",
  Panel: "面板",
  Source: "源码",
  Custom: "自定义",
  "Built-in": "内置",
  Plugins: "插件",
  Subagents: "子智能体",
  "Check updates": "检查更新",
  "Checking...": "正在检查…",
  Preparing: "正在准备",
  "Updating...": "正在更新…",
  "Saving...": "正在保存…",
  "Save changes": "保存更改",
  "Delete action": "删除操作",
  "Delete threads": "删除对话",
  "Delete draft": "删除草稿",
  Restore: "恢复",
  Maximize: "最大化",
  "Close panel": "关闭面板",
  "Close plan sidebar": "关闭计划侧边栏",
  "Close image preview": "关闭图片预览",
  "Close search (Esc)": "关闭搜索（Esc）",
  "Add to chat": "添加到对话",
  "Remove attachment": "移除附件",
  "Remove comments": "移除评论",
  "Remove selections": "移除所选内容",
  "Remove marker": "移除标记",
  "Cancel turn": "取消本轮",
  "Cancel voice note": "取消语音备注",
  "Transcribing voice note": "正在转写语音备注",
  "Full Plan": "完整计划",
  "Hide files sidebar": "隐藏文件侧边栏",
  "Hide search sidebar": "隐藏搜索侧边栏",
  "Review files": "审阅文件",
  "Filter files": "筛选文件",
  "Hide file tree": "隐藏文件树",
  "Show file tree": "显示文件树",
  "No matching files.": "没有匹配的文件。",
  "Previous page": "上一页",
  "Next page": "下一页",
  "Fit width": "适合宽度",
  "Fit page": "适合页面",
  "Current page": "当前页",
  "All turns": "所有轮次",
  Turns: "轮次",
  "Choose diff source": "选择差异来源",
  "Diff source": "差异来源",
  "Diff view options": "差异视图选项",
  "Copy diff": "复制差异",
  "Copied diff": "已复制差异",
  "Jump to file": "跳转到文件",
  "Git actions": "Git 操作",
  Commit: "提交",
  "Git action options": "Git 操作选项",
  "Choose turn diff": "选择轮次差异",
  "Move to its own terminal tab": "移到独立终端标签页",
  "Collapse terminal into chat drawer": "将终端收回对话抽屉",
  "Collapse side panel": "收起侧边面板",
  "Open side panel": "打开侧边面板",
  "Actions are project-scoped commands you can run from the top bar or keybindings.":
    "操作是项目级命令，可从顶部工具栏或快捷键运行。",
  Name: "名称",
  "Choose icon": "选择图标",
  "Press shortcut": "按下快捷键",
  "Press a shortcut. Use": "按下快捷键。使用",
  Backspace: "退格键",
  "to clear.": "以清除。",
  "Save action": "保存操作",
  "Run automatically on worktree creation": "创建工作树时自动运行",
  "Resize Sidebar": "调整侧边栏宽度",
  "Drag to resize sidebar": "拖动以调整侧边栏宽度",
  "Copy message": "复制消息",
  "Edit message": "编辑消息",
  "Pin message": "固定消息",
  "Change model and reasoning": "更改模型和推理强度",
  "Record voice note": "录制语音备注",
  "Toggle environment panel": "切换环境面板",
  "Toggle diff panel": "切换差异面板",
  "Collapse panel": "收起面板",
  "Toggle Sidebar": "切换侧边栏",
  Apply: "应用",
  Archive: "归档",
  Archived: "已归档",
  Automations: "自动化工作流",
  Back: "返回",
  Browse: "浏览",
  "Type path": "输入路径",
  "Cancel add project": "取消添加项目",
  "Edit project": "编辑项目",
  "Open in Finder": "在 Finder 中打开",
  "Open in Kanban": "在看板中打开",
  "Start dev": "启动开发",
  "Edit name": "编辑名称",
  "Pin project": "固定项目",
  Browser: "浏览器",
  Cancel: "取消",
  Chat: "对话",
  Chats: "对话",
  "Choose Chat": "选择对话",
  Clear: "清除",
  Close: "关闭",
  Code: "代码",
  Collapse: "收起",
  "Command palette": "命令面板",
  "Composer extras": "输入框扩展功能",
  Confirm: "确认",
  Continue: "继续",
  Copy: "复制",
  "Copy Path": "复制路径",
  "Copy Thread ID": "复制对话 ID",
  Create: "创建",
  "Create handoff thread": "创建交接对话",
  Current: "当前",
  Dark: "深色",
  Day: "日期",
  "Default permissions": "默认权限",
  Delete: "删除",
  Details: "详情",
  Diff: "差异",
  Done: "已完成",
  "Download manually": "手动下载",
  Edit: "编辑",
  Editor: "编辑器",
  "Editor view": "编辑器视图",
  Every: "每隔",
  Expand: "展开",
  Explorer: "文件浏览",
  Export: "导出",
  Files: "文件",
  "Fork Into Local": "派生到本地",
  "Fork Into New Worktree": "派生到新工作树",
  Git: "Git",
  "Hand off thread": "交接对话",
  Hide: "隐藏",
  Home: "主页",
  Implement: "实施",
  Import: "导入",
  "Import thread from...": "导入对话自…",
  Kanban: "看板",
  Light: "浅色",
  "Loading...": "加载中…",
  Local: "本地",
  "Max iterations": "最大迭代次数",
  Model: "模型",
  More: "更多",
  "New chat": "新建对话",
  "New terminal": "新建终端",
  New: "新建",
  "New thread": "新建对话",
  Next: "下一步",
  "Next question": "下一题",
  "Next run": "下次运行",
  No: "否",
  "No automations yet": "还没有自动化工作流",
  "No runs yet.": "还没有运行记录。",
  "No unread runs.": "没有未读运行结果。",
  Notifications: "通知",
  Off: "关",
  On: "开",
  Open: "打开",
  "Open Path in Terminal": "在终端中打开路径",
  Pause: "暂停",
  Paused: "已暂停",
  Pinned: "已固定",
  Plan: "计划",
  "Plan mode": "计划模式",
  "Add image": "添加图片",
  "Plan details": "计划详情",
  Previous: "上一步",
  "Previous runs": "历史运行",
  Project: "项目",
  Projects: "项目",
  Refresh: "刷新",
  Remove: "移除",
  Rename: "重命名",
  "Rename thread": "重命名对话",
  Resume: "继续运行",
  Review: "审阅",
  "Review Against Base Branch": "与基准分支比较审阅",
  "Review Uncommitted Changes": "审阅未提交的修改",
  Run: "运行",
  "Run at": "运行时间",
  "Runs in": "运行位置",
  Save: "保存",
  Scheduled: "已计划",
  Search: "搜索",
  "Search projects, threads, and actions": "搜索项目、对话和操作",
  Suggested: "推荐",
  Recent: "最近使用",
  "Usage settings": "用量设置",
  "Import chat from…": "从…导入对话",
  "Jump to threads, projects, actions, or appearance.": "跳转到对话、项目、操作或外观设置。",
  "Enter to open": "按 Enter 打开",
  "Select a chat": "选择一个对话",
  "Select a thread or create a new one to get started.": "请选择一个对话，或新建对话后开始。",
  Send: "发送",
  "No chats in this project yet": "此项目还没有对话",
  Settings: "设置",
  Show: "显示",
  "Show less": "收起",
  "Show more": "显示更多",
  Side: "侧边对话",
  "Sort chats": "排序对话",
  "Sort threads": "排序对话",
  "Sort projects": "排序项目",
  "Last user message": "最后一条用户消息",
  Standalone: "独立运行",
  Status: "状态",
  Stop: "停止",
  Studio: "工作室",
  "Submit answers": "提交答案",
  System: "跟随系统",
  Tasks: "任务",
  Temporary: "临时",
  Terminal: "终端",
  Thread: "对话",
  Threads: "对话",
  Time: "时间",
  Timezone: "时区",
  Today: "今天",
  Undo: "撤销",
  Unarchive: "取消归档",
  Unknown: "未知",
  "Unknown project": "未知项目",
  Unread: "未读",
  Update: "更新",
  "Update available": "有可用更新",
  Usage: "用量",
  View: "查看",
  Workspace: "工作区",
  Worktree: "工作树",
  Yes: "是",

  "What should we do in Grok?": "想在 Grok 构建什么？",
  "What should we do in Grok ?": "想在 Grok 构建什么？",
  "What should we work on?": "我们来做什么？",
  "Ask for follow-up changes or attach images": "提出后续修改，或附加图片",
  "Ask anything, @tag files/folders, or use / to show available commands":
    "随便问，使用 @ 引用文件/文件夹，或输入 / 查看可用命令",
  "Default permissions — click to change permissions": "默认权限 — 点此修改权限",
  "Provider is disabled in Synara settings.": "此提供商已在 Synara 设置中禁用。",
  "Provider is disabled": "提供商已禁用",
  Provider: "提供商",
  Providers: "提供商",
  "Provider visibility": "提供商显示",
  "Provider installs": "提供商安装",
  "Provider update checks": "检查提供商更新",
  "Provider tools": "提供商工具",
  "Custom models": "自定义模型",
  "CLI docs": "CLI 文档",
  "from your PATH.": "（来自 PATH）。",
  Install: "安装",
  Config: "配置",
  Headless: "无界面模式",
  Quickstart: "快速开始",
  "Leave blank to use": "留空即可使用",
  "Cursor editor CLI paths are accepted too.": "也支持 Cursor 编辑器 CLI 路径。",
  "Cursor Agent or Cursor CLI path": "Cursor Agent 或 Cursor CLI 路径",
  "Cursor API endpoint": "Cursor API 端点",
  "Optional Cursor API endpoint override passed to `cursor-agent -e`.":
    "可选的 Cursor API 端点覆盖值，将传给 `cursor-agent -e`。",
  "Kilo server URL": "Kilo 服务器 URL",
  "Optional existing Kilo server URL. Leave blank to spawn a local server.":
    "可填写现有 Kilo 服务器 URL；留空则启动本地服务器。",
  "Kilo server password": "Kilo 服务器密码",
  "Optional password for an externally managed Kilo server.": "外部管理的 Kilo 服务器可选密码。",
  "OpenAI response WebSockets": "OpenAI 响应 WebSocket",
  "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.":
    "为托管的本地服务器使用 OpenCode 实验性的 OpenAI 响应 WebSocket 传输。",
  "Pi agent directory": "Pi 智能体目录",
  "Optional custom Pi agent directory for auth, models, skills, and commands.":
    "可选的自定义 Pi 智能体目录，用于认证、模型、技能和命令。",

  "Needs review": "需要审阅",
  "New result": "有新结果",
  Active: "运行中",
  Auto: "自动",
  Mode: "模式",
  "Created from": "创建来源",
  "Created at": "创建时间",
  "Last ran": "上次运行",
  Repeats: "重复方式",
  Cron: "Cron 表达式",
  Never: "从不",
  Heartbeat: "心跳",
  "Approve the automation first": "请先批准此自动化工作流",
  "Cancel run": "取消运行",
  "Delete automation": "删除自动化工作流",
  "Automation run": "自动化运行",
  "Automation created": "已创建自动化工作流",
  "Automation updated": "已更新自动化工作流",
  "Automation needs a bit more detail": "自动化工作流还需要补充一些细节",
  "Chat required": "需要先选择对话",

  Compact: "紧凑",
  Comfortable: "舒适",
  Spacious: "宽松",
  Theme: "主题",
  "UI density": "界面密度",
  "Time format": "时间格式",
  "System default": "跟随系统",
  "Recently active": "最近活跃",
  "Recently added": "最近添加",
  "Newest first": "最新优先",
  "Manual order": "手动排序",
  "Base font size": "基础字号",
  "Terminal font size": "终端字号",
  "Terminal font": "终端字体",
  "Font smoothing": "字体平滑",
  "Activity toasts": "活动通知条",
  "Desktop notifications": "桌面通知",
  "Assistant output": "助手输出",
  "Delete confirmation": "删除确认",
  "Archive confirmation": "归档确认",
  "Terminal close confirmation": "关闭终端确认",
  "Restore default settings?": "恢复默认设置？",
  "Restore defaults": "恢复默认设置",

  "Loading models": "正在加载模型",
  "Loading browser...": "正在加载浏览器…",
  "Loading diff viewer...": "正在加载差异查看器…",
  "Loading explorer...": "正在加载文件浏览…",
  "Loading file...": "正在加载文件…",
  "Loading Git...": "正在加载 Git…",
  "Loading terminal...": "正在加载终端…",
  "Connecting to Synara server...": "正在连接 Synara 服务…",
  Connecting: "连接中",
  "Sending...": "发送中…",
  "Submitting...": "提交中…",
  "Preparing update": "正在准备更新",
  "Update ready": "更新已准备就绪",
  Updating: "更新中",
  Updated: "已更新",
  "Update failed": "更新失败",
  "Update queued": "更新已排队",
  "Still outdated": "仍不是最新版本",
  "Couldn’t finish updating": "无法完成更新",
  "Couldn’t download the update": "无法下载更新",

  "Archive thread": "归档对话",
  "Clear notification": "清除通知",
  "Mark unread": "标记为未读",
  "Temporary chat": "临时对话",
  "Pending approval": "等待批准",
  "Terminal input needed": "终端需要输入",
  "Terminal process running": "终端进程运行中",
  "Terminal task completed": "终端任务已完成",
  "Terminal is sleeping. Restoring shortly.": "终端正在休眠，即将恢复。",
  "No active thread": "没有活跃对话",
  "Project instructions added to notepad.": "项目说明已添加到记事本。",
  "Temporary chat — deleted when you leave. Click to keep it.":
    "临时对话 — 离开后将删除。点击可保留。",
  "Make this a temporary chat (deleted when you leave)": "设为临时对话（离开后删除）",
  "Plan mode — click to return to normal build mode": "计划模式 — 点击返回常规执行模式",
  "Stop generation": "停止生成",
  "Stop the current response. On Mac, press Ctrl+C to interrupt.":
    "停止当前回复。在 Mac 上按 Ctrl+C 中断。",
  "Implementation actions": "实施操作",
  AppSnap: "应用截图",
  "Not now": "暂不设置",
  "Set up AppSnap": "设置应用截图",
  "Synara AppSnaps are live!": "应用截图已启用！",
  "Press both Option keys (⌥ ⌥) to snap any app’s window into the task you’re working in.":
    "同时按下两个 Option 键（⌥ ⌥），即可把任意应用窗口捕捉到当前任务中。",
  "Toggle thread sidebar": "切换对话侧边栏",
  Forward: "前进",
  "World Cup 2026": "2026 世界杯",
  "Loading projects": "正在加载项目",
  "Loading projects...": "正在加载项目…",
  "Expand all projects": "展开所有项目",
  "Pin Grok": "固定 Grok",
  "Create new terminal thread in Grok": "在 Grok 中新建终端对话",
  "Create new thread in Grok": "在 Grok 中新建对话",
  "Pin thread": "固定对话",
  "Worked for 7.8s": "已运行 7.8 秒",
  "Full access": "完全访问",
  "Full access — click to change permissions": "完全访问 — 点击修改权限",
  "Context window 4.7% used": "已使用上下文窗口 4.7%",
  "Send message": "发送消息",
  "Back to app": "返回应用",
  "Search settings": "搜索设置",
  "Search settings...": "搜索设置…",
  App: "应用",
  General: "通用",
  Profile: "个人资料",
  Appearance: "外观",
  Behavior: "行为",
  "Keyboard Shortcuts": "键盘快捷键",
  Worktrees: "工作树",
  Models: "模型",
  Skills: "技能",
  Advanced: "高级",
  "Default provider, thread mode, and sidebar organization.":
    "默认提供商、对话模式和侧边栏组织方式。",
  "Core defaults": "核心默认设置",
  "Default provider": "默认提供商",
  "default provider": "默认提供商",
  "chats section": "对话分区",
  "studio section": "工作室分区",
  "environment panel default open": "环境面板默认打开状态",
  "Reset default provider to default": "将默认提供商重置为默认值",
  "Choose the provider used for new chats.": "选择新建对话使用的提供商。",
  "New threads": "新建对话",
  "Pick the default workspace mode for newly created draft threads.":
    "选择新建草稿对话的默认工作区模式。",
  "Sidebar organization": "侧边栏组织",
  "Project order": "项目排序",
  "Controls how projects are arranged in the main sidebar.": "控制项目在主侧边栏中的排列方式。",
  "Thread order": "对话排序",
  "Controls how threads are arranged inside each project in the main sidebar.":
    "控制每个项目内对话的排列方式。",
  "Sidebar sections": "侧边栏分区",
  "Reset chats section to default": "将对话分区重置为默认值",
  "Show the standalone Chats list in the sidebar footer (chats not tied to a project).":
    "在侧边栏底部显示独立对话列表（未绑定项目的对话）。",
  "Reset studio section to default": "将工作室分区重置为默认值",
  "Show the Studio tab in the sidebar switcher.": "在侧边栏切换器中显示工作室标签。",
  "Show the Workspace tab in the sidebar switcher. The Threads tab always stays visible.":
    "在侧边栏切换器中显示工作区标签。对话标签始终可见。",
  "Environment panel": "环境面板",
  "Open by default": "默认打开",
  "Open the chat Environment panel automatically on normal threads. When off, the panel stays closed until you open it. Your last open/close also updates this preference.":
    "在普通对话中自动打开环境面板。关闭时，面板会保持收起，直到你手动打开；上次开关状态也会更新此偏好。",
  Repository: "仓库",
  "Pull request": "拉取请求",
  Recap: "摘要",
  "Pinned messages": "已固定消息",
  "Text markers": "文本标记",
  "Project instructions": "项目说明",
  Notepad: "记事本",
  "Default thread mode": "默认对话模式",
  "Project sort order": "项目排序",
  "Thread sort order": "对话排序",
  "Show the Chats section in the sidebar": "在侧边栏显示对话分区",
  "Show the Studio section in the sidebar": "在侧边栏显示工作室分区",
  "Show the Workspace section in the sidebar": "在侧边栏显示工作区分区",
  "Open the Environment panel by default on normal threads": "在普通对话中默认打开环境面板",
  "Show the Usage section in the Environment panel": "在环境面板中显示用量分区",
  "Show the Repository section in the Environment panel": "在环境面板中显示仓库分区",
  "Show the Pull request section in the Environment panel": "在环境面板中显示拉取请求分区",
  "Show the Editor section in the Environment panel": "在环境面板中显示编辑器分区",
  "Show the Recap section in the Environment panel": "在环境面板中显示摘要分区",
  "Show the Pinned messages section in the Environment panel": "在环境面板中显示已固定消息分区",
  "Show the Text markers section in the Environment panel": "在环境面板中显示文本标记分区",
  "Show the Project instructions section in the Environment panel": "在环境面板中显示项目说明分区",
  "Show the Notepad section in the Environment panel": "在环境面板中显示记事本分区",
  "Show the provider usage row in the chat Environment panel.":
    "在对话环境面板中显示提供商用量行。",
  "Show the GitHub repository link in the chat Environment panel. The git block (Changes, Worktree, branch, Commit and Push) always stays visible.":
    "在对话环境面板中显示 GitHub 仓库链接。Git 区块（更改、工作树、分支、Commit 和 Push）始终可见。",
  "Show the open pull request (CI checks and review comments) for the current branch in the chat Environment panel.":
    "在对话环境面板中显示当前分支的拉取请求（CI 检查和审阅评论）。",
  "Show the Editor section (in-app editor view and Open in editor picker) in the chat Environment panel.":
    "在对话环境面板中显示编辑器分区（应用内编辑器视图及“在编辑器中打开”选择器）。",
  "Show the auto-generated chat recap in the Environment panel.":
    "在环境面板中显示自动生成的对话摘要。",
  "Show the pinned-messages checklist in the Environment panel.":
    "在环境面板中显示已固定消息清单。",
  "Show highlighted and underlined transcript text in the Environment panel.":
    "在环境面板中显示高亮和下划线的对话文本。",
  "Show project-level instructions in the Environment panel.": "在环境面板中显示项目级说明。",
  "Show the per-thread notepad in the Environment panel.": "在环境面板中显示每个对话的记事本。",
  Share: "分享",
  Activity: "活动",
  "Activity insights": "活动洞察",
  "Most used provider": "最常用提供商",
  "Most used reasoning": "最常用推理强度",
  "Most active hour": "最活跃时段",
  "Most worked project": "最常处理项目",
  "Skills explored": "已探索技能",
  "Total skills used": "已使用技能总数",
  "Total threads": "对话总数",
  "Most used plugins": "最常用插件",
  "No skills or agents used yet.": "尚未使用技能或智能体。",
  "Model usage": "模型用量",
  "Lifetime tokens": "累计 Token",
  "Peak day": "单日峰值",
  "Total prompts": "提示词总数",
  "Current streak": "当前连续天数",
  "Longest streak": "最长连续天数",
  "Share your activity": "分享你的活动",
  "Copy stat card": "复制统计卡片",
  "Share to X": "分享到 X",
  "Share to LinkedIn": "分享到 LinkedIn",
  "Share to Reddit": "分享到 Reddit",
  "Save stat card": "保存统计卡片",
  "Edit profile": "编辑个人资料",
  "Edit avatar": "编辑头像",
  "Upload photo": "上传照片",
  "Display name": "显示名称",
  "Your name": "你的名字",
  Username: "用户名",
  username: "用户名",
  "Theme, typography, and timestamp formatting.": "主题、排版与时间戳格式。",
  "Theme and typography": "主题与排版",
  "Reset theme to default": "将主题重置为默认值",
  "Choose how Synara looks across the app.": "选择 Synara 在整个应用中的外观。",
  "Theme preference": "主题偏好",
  theme: "主题",
  "base font size": "基础字号",
  "time format": "时间格式",
  "Dark theme": "深色主题",
  "Light theme": "浅色主题",
  Reset: "重置",
  Accent: "强调色",
  Background: "背景",
  Foreground: "前景",
  "UI font": "界面字体",
  "Code font": "代码字体",
  "Translucent sidebar": "半透明侧边栏",
  Contrast: "对比度",
  "This is the active theme right now.": "这是当前启用的主题。",
  "Inactive while the app is locked to dark.": "应用锁定为深色时不可用。",
  "Dark theme code theme": "深色主题代码配色",
  "Light theme code theme": "浅色主题代码配色",
  "Dark theme accent color": "深色主题强调色",
  "Dark theme background color": "深色主题背景色",
  "Dark theme foreground color": "深色主题前景色",
  "Light theme accent color": "浅色主题强调色",
  "Light theme background color": "浅色主题背景色",
  "Light theme foreground color": "浅色主题前景色",
  "Dark theme UI font": "深色主题界面字体",
  "Light theme UI font": "浅色主题界面字体",
  "Dark theme code font": "深色主题代码字体",
  "Light theme code font": "浅色主题代码字体",
  "Dark theme translucent sidebar": "深色主题半透明侧边栏",
  "Light theme translucent sidebar": "浅色主题半透明侧边栏",
  "Dark theme contrast": "深色主题对比度",
  "Light theme contrast": "浅色主题对比度",
  "深色主题 code theme": "深色主题代码配色",
  "浅色主题 code theme": "浅色主题代码配色",
  "深色主题 accent color": "深色主题强调色",
  "浅色主题 accent color": "浅色主题强调色",
  "深色主题 background color": "深色主题背景色",
  "浅色主题 background color": "浅色主题背景色",
  "深色主题 foreground color": "深色主题前景色",
  "浅色主题 foreground color": "浅色主题前景色",
  "深色主题 UI font": "深色主题界面字体",
  "浅色主题 UI font": "浅色主题界面字体",
  "深色主题 code font": "深色主题代码字体",
  "浅色主题 code font": "浅色主题代码字体",
  "深色主题 translucent sidebar": "深色主题半透明侧边栏",
  "浅色主题 translucent sidebar": "浅色主题半透明侧边栏",
  "深色主题 contrast": "深色主题对比度",
  "浅色主题 contrast": "浅色主题对比度",
  Color: "颜色",
  Hue: "色相",
  Saturation: "饱和度",
  Brightness: "亮度",
  "Reset to default": "恢复默认值",
  "Default (JetBrains Mono)": "默认（JetBrains Mono）",
  "Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size.":
    "在不改变字号的前提下，调整侧边栏、输入框、对话边距和设置行的间距。",
  "Reset base font size to default": "将基础字号恢复为默认值",
  "Adjust the app text base in pixels. Chat and UI typography scale proportionally from this value.":
    "以像素设置应用文字基础字号；对话和界面排版会按此值等比缩放。",
  "Base font size in pixels": "基础字号（像素）",
  "Adjust terminal text independently from the app and chat font size.":
    "独立调整终端文字，不影响应用和对话字号。",
  "Terminal font size in pixels": "终端字号（像素）",
  "Type any monospace font installed on this device (e.g. Fira Code). Leave empty for the default. Fonts that aren't installed fall back to the system monospace.":
    "输入本机已安装的任意等宽字体（如 Fira Code）。留空则使用默认字体；未安装的字体会回退到系统等宽字体。",
  "Terminal font family": "终端字体系列",
  "Enable font smoothing": "启用字体平滑",
  "Use macOS-style antialiasing for lighter, crisper text rendering.":
    "使用 macOS 风格抗锯齿，使文字更轻盈清晰。",
  "Time and reading": "时间与阅读",
  "Reset time format to default": "将时间格式恢复为默认值",
  "System default follows your browser or OS clock preference.": "跟随浏览器或操作系统的时钟偏好。",
  "Timestamp format": "时间戳格式",
  "12-hour": "12 小时制",
  "24-hour": "24 小时制",
  "In-app toasts and desktop alerts.": "应用内提示条与桌面提醒。",
  "Activity alerts": "活动提醒",
  "Show an in-app toast when a chat or managed terminal agent finishes or needs input.":
    "当对话或受管理终端智能体完成或需要输入时，显示应用内提示条。",
  "Activity toast notifications": "活动提示条通知",
  "Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background. Desktop app notifications use your operating system notification center.":
    "当应用处于后台且对话或受管理终端智能体完成或需要输入时，显示系统通知。桌面应用通知使用操作系统通知中心。",
  Test: "测试",
  "Desktop activity notifications": "桌面活动通知",
  "Snap another app's window straight into a task with one key chord.":
    "用一个组合键直接把其他应用的窗口捕捉到任务中。",
  "Take an AppSnap to show your agent another app's window": "使用应用截图向智能体展示其他应用窗口",
  "Press both  ⌥ Option  keys at once while any app is frontmost. Synara captures that window as an image, brings itself forward, and attaches the snap to a task composer — the capture stays on this device until you send the message.":
    "任意应用位于前台时，同时按下两个 ⌥ Option 键。Synara 会将该窗口捕获为图片、切换到前台并附加到任务输入框；在你发送消息前，捕获内容始终保留在此设备上。",
  Capture: "捕捉",
  "Enable AppSnap": "启用应用截图",
  "Reset AppSnap to default": "将应用截图重置为默认值",
  "Run the capture listener in the background while Synara is open.":
    "Synara 打开时在后台运行截图监听器。",
  "Allow Input Monitoring and Screen Recording in macOS System Settings, then try again.":
    "请在 macOS 系统设置中允许输入监控和屏幕录制，然后重试。",
  Shortcut: "快捷键",
  "Press the left and right Option keys at the same time. The chord works while any app is focused, and can't be remapped yet.":
    "同时按下左、右 Option 键。任何应用获得焦点时都可触发，当前尚不能重新映射。",
  Destination: "目标位置",
  "Snaps join the task you interacted with in the last minute, and consecutive snaps stay together. Otherwise Synara opens a fresh task with the capture attached.":
    "截图会附加到你最近一分钟操作过的任务，连续截图会保持在同一任务；否则 Synara 会新建任务并附上截图。",
  Automatic: "自动",
  "Capture sound": "截图提示音",
  "Play a short shutter cue when a window is captured.": "捕捉窗口时播放短促快门提示音。",
  Preview: "预览",
  "Play a sound when an AppSnap is captured": "捕捉应用截图时播放提示音",
  "macOS permissions": "macOS 权限",
  "Input Monitoring": "输入监控",
  "Lets Synara notice the double-Option chord while another app owns the keyboard. Nothing you type is recorded.":
    "允许 Synara 在其他应用占用键盘时识别双 Option 组合键；不会记录你输入的任何内容。",
  Denied: "已拒绝",
  "Screen Recording": "屏幕录制",
  "Lets Synara capture an image of the frontmost window. Only the single window you snap is captured, only at the moment you press the chord.":
    "允许 Synara 捕捉前台窗口图片；只会在你按下组合键的瞬间捕捉该单一窗口。",
  "Permission status": "权限状态",
  "Grant both permissions to Synara under System Settings → Privacy & Security, then recheck here. macOS may require relaunching the app after a change.":
    "请在“系统设置 → 隐私与安全性”中授予 Synara 两项权限，然后在此重新检查。macOS 在修改后可能要求重新启动应用。",
  "Recheck permissions": "重新检查权限",
  "Every keyboard shortcut available in Synara, grouped by context.":
    "Synara 的全部键盘快捷键，按使用场景分组。",
  "Search shortcuts": "搜索快捷键",
  "Search shortcuts...": "搜索快捷键…",
  Command: "命令",
  Keybinding: "按键",
  "Show keyboard shortcuts": "显示键盘快捷键",
  "Open this sheet from anywhere without leaving your current context.":
    "在任何位置打开此面板，无需离开当前上下文。",
  "Toggle sidebar": "切换侧边栏",
  "Collapse or reveal the sidebar shell.": "收起或展开侧边栏。",
  "Open the folder picker to import a local project into the sidebar.":
    "打开文件夹选择器，将本地项目导入侧边栏。",
  "Search projects and threads": "搜索项目和对话",
  "Open the sidebar search palette from anywhere in the app.": "在应用任意位置打开侧边栏搜索面板。",
  "Import thread": "导入对话",
  "Bring an existing conversation into the current workspace.": "将已有对话带入当前工作区。",
  "Start a fresh thread in the current project, or the most recent one.":
    "在当前项目或最近使用的项目中新建对话。",
  "New thread in latest project": "在最近项目中新建对话",
  "Jump back into the most recently used project with a new thread.":
    "回到最近使用的项目并新建对话。",
  "New terminal thread": "新建终端对话",
  "Create a thread that opens directly into terminal mode.": "创建直接进入终端模式的对话。",
  "Split chat": "拆分对话",
  "Open the current conversation in a second pane.": "在第二个面板中打开当前对话。",
  "Model picker": "模型选择器",
  "Open the composer provider and model picker.": "打开输入框的提供商和模型选择器。",
  "Reasoning picker": "推理选择器",
  "Focus composer": "聚焦输入框",
  "Choose visible providers, review CLI installs, and update provider tools.":
    "选择可见提供商、检查 CLI 安装并更新提供商工具。",
  Updates: "更新",
  "Automatic CLI update checks": "自动检查 CLI 更新",
  "Check Codex, Claude, and other provider CLIs for newer versions in the background.":
    "在后台检查 Codex、Claude 和其他提供商 CLI 的新版本。",
  "Provider updates": "提供商更新",
  "Review installed provider tools that Synara can safely update.":
    "检查 Synara 可以安全更新的已安装提供商工具。",
  "No provider updates detected": "未检测到提供商更新",
  "Provider picker": "提供商选择器",
  "provider picker": "提供商选择器",
  "provider tools": "提供商工具",
  "custom models": "自定义模型",
  "Visible providers": "可见提供商",
  "Drag providers into your preferred picker order and hide the ones you don't use. The provider you're currently using on a thread always stays visible.":
    "拖动提供商调整选择器排序，并隐藏不用的提供商；当前对话正在使用的提供商始终保持可见。",
  "All providers visible": "所有提供商均可见",
  "Installed CLIs": "已安装的 CLI",
  "Reset provider tools to default": "将提供商工具重置为默认值",
  "Review provider versions and update tools. Open a row only when you need binary overrides.":
    "检查提供商版本并更新工具。仅在需要二进制路径覆盖时展开条目。",
  "Codex binary path": "Codex 二进制路径",
  "CODEX_HOME path": "CODEX_HOME 路径",
  "Optional custom Codex home and config directory.": "可选的自定义 Codex 主目录和配置目录。",
  "Show Codex in the provider picker": "在提供商选择器中显示 Codex",
  "Show Claude in the provider picker": "在提供商选择器中显示 Claude",
  "Show Cursor in the provider picker": "在提供商选择器中显示 Cursor",
  "Show Gemini in the provider picker": "在提供商选择器中显示 Gemini",
  "Show Grok in the provider picker": "在提供商选择器中显示 Grok",
  "Show Droid in the provider picker": "在提供商选择器中显示 Droid",
  "Show Kilo in the provider picker": "在提供商选择器中显示 Kilo",
  "Show OpenCode in the provider picker": "在提供商选择器中显示 OpenCode",
  "Show Pi in the provider picker": "在提供商选择器中显示 Pi",
  "Git writing defaults and custom model slugs.": "Git 写作默认设置与自定义模型标识。",
  "Generation defaults": "生成默认设置",
  "Git writing model": "Git 写作模型",
  "Used for generated commit messages, PR titles, and branch names.":
    "用于生成提交信息、拉取请求标题和分支名称。",
  "Saved model slugs": "已保存模型标识",
  "Reset custom models to default": "将自定义模型重置为默认值",
  "Add custom model slugs for supported providers.": "为支持的提供商添加自定义模型标识。",
  "Custom model provider": "自定义模型提供商",
  Add: "添加",
  "Remove grok-4.5": "移除 grok-4.5",
  "Streaming, diff handling, and destructive confirmations.":
    "流式输出、差异处理和破坏性操作确认。",
  "Runtime behavior": "运行时行为",
  "Show token-by-token output while a response is in progress.": "响应生成期间按 Token 显示输出。",
  "Stream assistant messages": "流式显示助手消息",
  "Diff line wrapping": "差异行换行",
  "Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session.":
    "设置差异面板打开时的默认换行状态；面板内换行开关只影响当前差异会话。",
  "Wrap diff lines by default": "默认换行显示差异行",
  "Safety confirmations": "安全确认",
  "Ask before deleting a thread and its chat history.": "删除对话及其聊天历史前询问。",
  "Confirm thread deletion": "确认删除对话",
  "Ask before archiving a thread.": "归档对话前询问。",
  "Confirm thread archive": "确认归档对话",
  "Ask before closing a terminal tab and clearing its history.": "关闭终端标签并清除其历史前询问。",
  "Confirm terminal tab close": "确认关闭终端标签",
  "Review and clean up the worktrees created by Synara.": "查看并清理由 Synara 创建的工作树。",
  "No app-managed worktrees found yet.": "暂未发现由应用管理的工作树。",
  "View and restore archived threads.": "查看并恢复已归档对话。",
  "No archived threads": "没有已归档对话",
  "Archived threads will appear here and can be restored to the sidebar.":
    "已归档对话将显示在这里，并可恢复到侧边栏。",
  "Every skill found across providers, with toggles to control availability.":
    "显示所有提供商发现的技能，并可用开关控制其可用性。",
  "Portable skills": "可移植技能",
  "Synara skills folder": "Synara 技能文件夹",
  "Skills placed here are available on every provider. When a provider already ships its own copy of a skill, that copy is used; otherwise Synara's copy is the fallback.":
    "放在此处的技能对所有提供商可用。提供商已有同名技能时优先使用其副本；否则使用 Synara 副本作为后备。",
  "Shared skills": "共享技能",
  "Provider copies": "提供商副本",
  "Provider copy": "提供商副本",
  "From Codex": "来自 Codex",
  "From Grok": "来自 Grok",
  "From Shared (.agents)": "来自共享目录（.agents）",
  "Remaining quota and credits for each signed-in provider.": "每个已登录提供商的剩余额度与积分。",
  "Provider usage": "提供商用量",
  "Loading provider usage…": "正在加载提供商用量…",
  "Usage is read locally from each provider CLI's stored credentials and fetched directly from the provider. OAuth providers may refresh short-lived tokens through their official token endpoint; if a provider shows “Not signed in”, re-authenticate with its CLI.":
    "用量从各提供商 CLI 本地保存的凭据读取，并直接向提供商获取。OAuth 提供商可能通过官方令牌端点刷新短期令牌；若显示“未登录”，请使用其 CLI 重新认证。",
  "Keybindings, recovery, and version info.": "按键绑定、恢复与版本信息。",
  "Developer tools": "开发者工具",
  Keybindings: "按键绑定",
  "Open the persisted `keybindings.json` file to edit advanced bindings directly.":
    "打开持久化的 `keybindings.json` 文件以直接编辑高级按键绑定。",
  "Opens in your preferred editor.": "会在首选编辑器中打开。",
  "Open file": "打开文件",
  "Recovery tools": "恢复工具",
  "Rebuild local project indexes without clearing existing chats when the local state gets out of sync. Shown automatically only when recovery actions are relevant.":
    "当本地状态不同步时，重建本地项目索引但不清除已有对话；仅在恢复操作相关时自动显示。",
  "Repair state": "修复状态",
  About: "关于",
  Version: "版本",
  "Current application version.": "当前应用版本。",
  "Release history": "发布历史",
  "A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time.":
    "按最新优先记录每次更新；与更新后弹窗相同的说明会保留在此，随时可回看。",
  "View release history": "查看发布历史",
  "Shown automatically only when recovery actions are relevant.": "仅在恢复操作相关时自动显示。",
  Environment: "环境",
  "Panel sections": "面板分区",
  "Initialize Git": "初始化 Git",
  "Local Servers": "本地服务器",
  "Open in Ghostty": "在 Ghostty 中打开",
  "Type here": "在此输入",
  "Close Git": "关闭 Git",
  "Source control": "源代码管理",
  "Refresh changes": "刷新更改",
  "Close source control": "关闭源代码管理",
  "No changes in the working tree. Select a file to view its diff.":
    "工作树没有更改。请选择文件以查看差异。",
  "Source control is unavailable for this thread.": "此对话无法使用源代码管理。",
  "Loading changes...": "正在加载更改…",
  Staged: "已暂存",
  Changes: "更改",
  "No staged changes.": "没有已暂存的更改。",
  "No unstaged changes.": "没有未暂存的更改。",
  "Select a file to view its diff.": "选择文件以查看差异。",
  "Unstage file": "取消暂存文件",
  "Unstage all": "全部取消暂存",
  "Stage file": "暂存文件",
  "Stage all": "全部暂存",
  "Working tree": "工作树",
  Unstaged: "未暂存",
  "Commit and Push unavailable; open Git actions menu": "提交并推送不可用；打开 Git 操作菜单",
  "Commit and Push unavailable. Open for more Git actions.":
    "提交并推送不可用。打开以查看更多 Git 操作。",
  "Switch project": "切换项目",
  "Hide chat panel": "隐藏对话面板",
  "Switch to chat view": "切换到对话视图",
  "Editor activity bar": "编辑器活动栏",
  "Hide diff sidebar": "隐藏差异侧边栏",
  "Changed files": "已更改文件",
  "Diff options": "差异选项",
  "File actions": "文件操作",
  "New editor rail item": "新建编辑器栏项目",
  "Chat history": "对话历史",
  "Reference in chat": "在对话中引用",
  "Ask why this changed": "询问为何发生此更改",
  "Copy path": "复制路径",
  "Resize chat panel": "调整对话面板宽度",
  "Drag to resize chat panel": "拖动以调整对话面板宽度",
  "Continue in": "继续在此处运行",
  "Local project": "本地项目",
  "New worktree": "新建工作树",
  "Rate limits remaining": "剩余额度",
  "No local usage data was found yet.": "暂未找到本地用量数据。",
  "No workspace": "没有工作区",
  "No workspace.": "没有工作区。",
  "No workspace is attached to this chat.": "此对话未关联工作区。",
  "No files in this diff.": "此差异中没有文件。",
  "This chat environment is still being prepared. Diffs will be available once the worktree is ready.":
    "此对话环境仍在准备中；工作树就绪后即可查看差异。",
  "Open in editor": "在编辑器中打开",
  "Editor options": "编辑器选项",
  "No installed editors found": "未找到已安装的编辑器",
  "Close Diff": "关闭差异",
  "Close file view": "关闭文件视图",
  "Turn diffs are unavailable because this project is not a git repository.":
    "当前项目不是 Git 仓库，无法查看对话差异。",
  "Close Explorer": "关闭文件浏览",
  "Search files": "搜索文件",
  "Search files...": "搜索文件…",
  "Select a file from the tree to view it.": "从文件树中选择文件以查看。",
  "Close Terminal": "关闭终端",
  "New terminal tab": "新建终端标签",
  "Split right": "向右拆分",
  "Split down": "向下拆分",
  "Close active terminal tab": "关闭当前终端标签",
  "Scroll to bottom": "滚动到底部",
  "Terminal input": "终端输入",
  "Close Browser": "关闭浏览器",
  "Go back": "后退",
  "Go forward": "前进",
  Reload: "重新加载",
  "Search or enter a URL": "搜索或输入 URL",
  "Copy screenshot": "复制截图",
  "Copy link": "复制链接",
  "Browser actions": "浏览器操作",
  "New tab": "新建标签页",
  "Close tab": "关闭标签页",
  "Refresh local servers": "刷新本地服务器",
  "No local servers": "没有本地服务器",
  "Try another browser URL": "尝试其他浏览器 URL",
  "Capture screenshot": "捕捉截图",
  "Open externally": "在外部打开",
  "Close browser panel": "关闭浏览器面板",
  "Close selected Side": "关闭选中的侧边对话",
  "Reset environment panel default open to default": "将环境面板默认打开状态重置为默认值",
  "New automation": "新建自动化工作流",
  "Automation title": "工作流标题",
  "About automations": "关于自动化工作流",
  "Automations run this prompt on a schedule and open the result as a thread.":
    "自动化工作流会按计划运行此提示词，并将结果作为对话打开。",
  "Use template": "使用模板",
  "Automation prompt": "工作流提示词",
  "Add prompt e.g. look for crashes in $sentry": "添加提示词，例如：检查 $sentry 中的崩溃",
  "Auto fallback may use local checkout": "自动回退可能使用本地检出",
  "If Synara cannot create a worktree, runs may fall back to editing the active project checkout.":
    "若 Synara 无法创建工作树，运行可能回退到编辑当前项目检出。",
  "Worktree cleanup": "工作树清理",
  "Generated worktrees or branches are kept after archiving until you remove them.":
    "生成的工作树或分支会在归档后保留，直到你手动移除。",
  "Auto fallback may use local checkout If Synara cannot create a worktree, runs may fall back to editing the active project checkout.":
    "自动回退可能使用本地检出：若 Synara 无法创建工作树，运行可能回退到编辑当前项目检出。",
  "Worktree cleanup Generated worktrees or branches are kept after archiving until you remove them.":
    "工作树清理：生成的工作树或分支会在归档后保留，直到你手动移除。",
  Schedule: "计划",
  Manual: "手动",
  Once: "一次",
  Hourly: "每小时",
  Daily: "每天",
  Weekdays: "工作日",
  Weekly: "每周",
  Unlimited: "不限次数",
  "Approval required": "需要批准",
  "Daily at 9:00": "每天 9:00",
  "Run mode": "运行模式",
  Permissions: "权限",
  "Triage new crashes": "分诊新的崩溃",
  "Update dependencies": "更新依赖",
  "Daily standup summary": "每日站会摘要",
  "Schedule needs review": "计划需要确认",
  "Choose when this automation should run before creating it.":
    "请先选择此自动化工作流的运行时间，再创建它。",
  "Schedule a prompt to run on its own, or wake an existing thread on a loop.":
    "让提示词按计划独立运行，或循环唤醒已有对话。",
  "New task": "新建任务",
  "New task in Grok": "在 Grok 中新建任务",
  "New task in Chats": "在对话中新建任务",
  "2 tasks": "2 个任务",
  "Choose the project for this task": "选择此任务所属项目",
  "Draft a prompt and place it in the board's Draft column. Drag it to In Progress to send it.":
    "编写提示词并放入看板的“草稿”列；拖到“进行中”即可发送。",
  "Describe the task, @tag files/folders, paste images, or use / for skills":
    "描述任务，使用 @ 引用文件/文件夹、粘贴图片，或输入 / 使用技能",
  "Task options": "任务选项",
  "Attach images": "附加图片",
  "Send as draft": "存为草稿",
  "Create task": "创建任务",
};

const LOCALIZABLE_ATTRIBUTES = [
  "aria-label",
  "aria-valuetext",
  "title",
  "placeholder",
  "data-tooltip-content",
] as const;
const SKIPPED_TAGS = new Set(["CODE", "KBD", "PRE", "SAMP", "SCRIPT", "STYLE", "TEXTAREA"]);

function translateExact(value: string): string {
  const projectPromptMatch = /^What should we do in (.+?)\s*\?$/.exec(value);
  if (projectPromptMatch) return `想在 ${projectPromptMatch[1]} 构建什么？`;
  const resetSettingMatch = /^Reset (.+) to default$/.exec(value);
  if (resetSettingMatch) {
    const settingLabel = resetSettingMatch[1] ?? "";
    return `将${UI_TEXT[settingLabel] ?? settingLabel}恢复为默认值`;
  }
  if (value === "Pin project") return "固定项目";
  const handoffFromMatch = /^Handoff from (.+)$/.exec(value);
  if (handoffFromMatch) return `来自 ${handoffFromMatch[1]} 的交接`;
  const handoffToMatch = /^Handoff to (.+)$/.exec(value);
  if (handoffToMatch) return `交接给 ${handoffToMatch[1]}`;
  const reorderProviderMatch = /^Reorder (.+)$/.exec(value);
  if (reorderProviderMatch) return `调整 ${reorderProviderMatch[1]} 的顺序`;
  const currentVersionMatch = /^Current (v.+)$/.exec(value);
  if (currentVersionMatch) return `当前版本 ${currentVersionMatch[1]}`;
  const enabledSkillsMatch = /^(\d+) of (\d+) skills enabled$/.exec(value);
  if (enabledSkillsMatch)
    return `已启用 ${enabledSkillsMatch[1]} / ${enabledSkillsMatch[2]} 个技能`;
  const providerCopiesMatch = /^Provider copies: (.+)$/.exec(value);
  if (providerCopiesMatch) return `提供商副本：${providerCopiesMatch[1]}`;
  const providerCopyMatch = /^Provider copy: (.+)$/.exec(value);
  if (providerCopyMatch) return `提供商副本：${providerCopyMatch[1]}`;
  const enableSkillMatch = /^Enable the (.+) skill$/.exec(value);
  if (enableSkillMatch) return `启用 ${enableSkillMatch[1]} 技能`;
  const unavailableMatch = /^(.+) Unavailable$/.exec(value);
  if (unavailableMatch) return `${unavailableMatch[1]} 不可用`;
  const runCountMatch = /^(\d+) runs$/.exec(value);
  if (runCountMatch) return `${runCountMatch[1]} 次运行`;
  const useColorMatch = /^Use (#[0-9a-fA-F]{6})$/.exec(value);
  if (useColorMatch) return `使用颜色 ${useColorMatch[1]}`;
  const providerBinaryPathMatch = /^(.+) binary path$/.exec(value);
  if (providerBinaryPathMatch) return `${providerBinaryPathMatch[1]} 二进制路径`;
  const serverUrlMatch = /^(.+) server URL$/.exec(value);
  if (serverUrlMatch) return `${serverUrlMatch[1]} 服务器 URL`;
  const serverPasswordMatch = /^(.+) server password$/.exec(value);
  if (serverPasswordMatch) return `${serverPasswordMatch[1]} 服务器密码`;
  const existingServerMatch =
    /^Optional existing (.+) server URL\. Leave blank to spawn a local server\.$/.exec(value);
  if (existingServerMatch)
    return `可填写现有 ${existingServerMatch[1]} 服务器 URL；留空则启动本地服务器。`;
  const externalServerPasswordMatch =
    /^Optional password for an externally managed (.+) server\.$/.exec(value);
  if (externalServerPasswordMatch)
    return `外部管理的 ${externalServerPasswordMatch[1]} 服务器可选密码。`;
  const hexValueMatch = /^(.+) hex value$/.exec(value);
  if (hexValueMatch) {
    const colorLabel = hexValueMatch[1] ?? "";
    return `${UI_TEXT[colorLabel] ?? colorLabel} 十六进制值`;
  }
  const saturationBrightnessMatch = /^Saturation (\d+%), Brightness (\d+%)$/.exec(value);
  if (saturationBrightnessMatch)
    return `饱和度 ${saturationBrightnessMatch[1]}，亮度 ${saturationBrightnessMatch[2]}`;
  const pinProjectMatch = /^Pin (.+)$/.exec(value);
  if (pinProjectMatch) return `固定 ${pinProjectMatch[1]}`;
  const terminalThreadMatch = /^Create new terminal thread in (.+)$/.exec(value);
  if (terminalThreadMatch) return `在 ${terminalThreadMatch[1]} 中新建终端对话`;
  const newThreadMatch = /^Create new thread in (.+)$/.exec(value);
  if (newThreadMatch) return `在 ${newThreadMatch[1]} 中新建对话`;
  const stagedSummaryMatch = /^Staged (.+)$/.exec(value);
  if (stagedSummaryMatch) return `已暂存 ${stagedSummaryMatch[1]}`;
  const changesSummaryMatch = /^Changes (.+)$/.exec(value);
  if (changesSummaryMatch) return `更改 ${changesSummaryMatch[1]}`;
  const localServersMatch = /^Local servers (\d+)$/.exec(value);
  if (localServersMatch) return `本地服务器 ${localServersMatch[1]}`;
  const changedFilesMatch = /^Changed files (\d+)$/.exec(value);
  if (changedFilesMatch) return `已更改文件 ${changedFilesMatch[1]}`;
  const fromBranchMatch = /^From (.+)$/.exec(value);
  if (fromBranchMatch) return `来自 ${fromBranchMatch[1]}`;
  const chatCountMatch = /^(\d+)\s+chats?$/.exec(value);
  if (chatCountMatch) return `${chatCountMatch[1]} 个对话`;
  const unmodifiedLineMatch = /^(\d+)\s+unmodified lines?$/.exec(value);
  if (unmodifiedLineMatch) return `${unmodifiedLineMatch[1]} 行未修改`;
  const closeSidechatMatch = /^Close Sidechat: (.+)$/.exec(value);
  if (closeSidechatMatch) return `关闭侧边对话：${closeSidechatMatch[1]}`;
  const sidechatMatch = /^Sidechat: (.+)$/.exec(value);
  if (sidechatMatch) return `侧边对话：${sidechatMatch[1]}`;
  const closeTerminalMatch = /^Close Terminal (\d+)$/.exec(value);
  if (closeTerminalMatch) return `关闭终端 ${closeTerminalMatch[1]}`;
  const terminalMatch = /^Terminal (\d+)$/.exec(value);
  if (terminalMatch) return `终端 ${terminalMatch[1]}`;
  const taskCountMatch = /^(\d+)\s+tasks?$/.exec(value);
  if (taskCountMatch) return `${taskCountMatch[1]} 个任务`;
  return UI_TEXT[value] ?? value;
}

function isUiNode(node: Node): boolean {
  const parent = node.parentElement;
  return Boolean(
    parent &&
    !SKIPPED_TAGS.has(parent.tagName) &&
    !parent.closest("[contenteditable='true'], [data-translation-skip='true']"),
  );
}

function replaceTextNode(node: Text): void {
  if (!node.nodeValue) return;
  const original = node.nodeValue;
  const allowDiffSeparator = /^\s*\d+\s+unmodified lines?\s*$/.test(original);
  if (!isUiNode(node) && !allowDiffSeparator) return;
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  const translated = translateExact(original.trim());
  if (translated !== original.trim()) node.nodeValue = `${leading}${translated}${trailing}`;
}

function replaceElementAttributes(element: Element): void {
  if (element.closest("[data-translation-skip='true']")) return;
  for (const attribute of LOCALIZABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const translated = translateExact(value);
    if (translated !== value) element.setAttribute(attribute, translated);
  }
}

function localizeSubtree(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) return replaceTextNode(node as Text);
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  replaceElementAttributes(element);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode())
    replaceTextNode(textNode as Text);
  for (const descendant of element.querySelectorAll(
    "[aria-label], [title], [placeholder], [data-tooltip-content]",
  ))
    replaceElementAttributes(descendant);
}

/** Covers normal DOM plus portalled menus, dialogs, and toasts without touching runtime content. */
export function installZhCnUiLocalization(): void {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.locale = "zh-CN";
  localizeSubtree(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") replaceTextNode(record.target as Text);
      else if (record.type === "attributes" && record.target instanceof Element)
        replaceElementAttributes(record.target);
      else for (const node of record.addedNodes) localizeSubtree(node);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...LOCALIZABLE_ATTRIBUTES],
  });
  // React owns attributes and may commit them immediately after a portal mount. A small
  // bounded-cost sweep ensures placeholders/tooltips in late menus get the same treatment.
  window.setInterval(() => localizeSubtree(document.documentElement), 500);
}
