import { type CSSProperties, type FC, type SVGProps } from "react";
import { PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { cn } from "./utils";
import { CentralIcon, type CentralIconVariant } from "./central-icons";
import {
  IconAlertCircle,
  IconAlertOctagon,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpRight,
  IconBolt,
  IconBrain,
  IconBulb,
  IconBug,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconColumns2,
  IconDots,
  IconDownload,
  IconEye,
  IconFile,
  IconFlag,
  IconFlask2,
  IconHistory,
  IconInfoCircle,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconMaximize,
  IconMinimize,
  IconMinus,
  IconDeviceDesktop,
  IconDeviceLaptop,
  IconDeviceMobileRotated,
  IconPlugOff,
  IconPower,
  IconMessageCircle,
  IconMoon,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconRotate2,
  IconSelector,
  IconStar,
  IconStarFilled,
  IconSun,
  IconTextWrap,
  IconTrash,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";

// Keep the existing icon API stable while the app moves from Lucide to Tabler.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

function adaptIcon(Component: TablerIcon): LucideIcon {
  return function AdaptedIcon(props) {
    return <Component {...(props as any)} />;
  };
}

// Wraps a Central icon asset behind the LucideIcon API. Rendering via CSS mask
// avoids stroke-on-stroke alpha summation that gave hand-drawn SVGs a
// "stamped twice" look on shared vertices (the previous PinIcon bug).
function centralIconWrapper(name: string, variant?: CentralIconVariant): LucideIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
        variant={variant}
        className={typeof className === "string" ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
}

export const AppsIcon: LucideIcon = (props) => (
  <RiApps2Line className={props.className} style={props.style} />
);
// Composer stacked-panel glyphs (subagent strip / workflow run card).
export const BackgroundTrayIcon: LucideIcon = centralIconWrapper("arrow-down-wall");
export const ContextCompactionIcon: LucideIcon = centralIconWrapper("arrows-hide");
export const BackToParentIcon: LucideIcon = centralIconWrapper("arrow-share-left");
export const WorkflowIcon: LucideIcon = centralIconWrapper("agents");
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const SkillCubeIcon: LucideIcon = centralIconWrapper("building-blocks");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
// Command palette (⌘K) action glyphs: one Central outline set so the rows read as a family.
export const ImportThreadIcon: LucideIcon = centralIconWrapper("import");
export const UsageGaugeIcon: LucideIcon = centralIconWrapper("gauge");
export const BugReportIcon: LucideIcon = centralIconWrapper("bug");
export const UserIcon: LucideIcon = centralIconWrapper("user");
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = centralIconWrapper("plus-medium");
/** 2x3 dot grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon: LucideIcon = centralIconWrapper("dot-grid-2x3");
export const EraserIcon: LucideIcon = centralIconWrapper("eraser");
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);
export const SortIcon: LucideIcon = centralIconWrapper("arrow-top-bottom");
// Single source for the robot/agent glyph. Sourced from the Central icon set so
// every robot affordance (reasoning rows, agent-task rows, agent mention chips,
// subagent menus, agent-activity headers) renders one identical icon. Use
// BotIcon in React; AGENT_ROBOT_ICON_NAME for imperative DOM via
// createCentralIconElement.
export const AGENT_ROBOT_ICON_NAME = "robot-3";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BookOpenIcon: LucideIcon = centralIconWrapper("newspaper-2");
export const BugIcon = adaptIcon(IconBug);
export const CameraIcon = adaptIcon(IconCamera);
export const CheckIcon = adaptIcon(IconCheck);
export const ChevronDownIcon = adaptIcon(IconChevronDown);
export const ChevronLeftIcon = adaptIcon(IconChevronLeft);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ChevronUpIcon = adaptIcon(IconChevronUp);
export const ChevronsUpDownIcon = adaptIcon(IconSelector);
export const CircleAlertIcon = adaptIcon(IconAlertCircle);
export const OctagonAlertIcon = adaptIcon(IconAlertOctagon);
export const CircleCheckIcon = adaptIcon(IconCircleCheck);
// User-input rows: a question-mark circle while the agent waits for an answer,
// and an up-arrow circle once the answer is submitted. Sourced from the Central
// set so they sit visually beside the other timeline glyphs (robot, search, …).
export const CircleQuestionIcon: LucideIcon = centralIconWrapper("circle-questionmark");
export const ArrowUpCircleIcon: LucideIcon = centralIconWrapper("arrow-up-circle");
export const CloudSyncIcon = centralIconWrapper("cloud-sync");
export const Columns2Icon = adaptIcon(IconColumns2);
export const ChangesIcon = centralIconWrapper("changes");
/** The one "Keybindings" glyph: the Help menu row, the feature tour, and (by basename) the
 *  Settings nav entry, so the three always match. */
export const KEYBINDINGS_ICON_NAME = "shortcut";
export const KeyboardIcon: LucideIcon = centralIconWrapper(KEYBINDINGS_ICON_NAME);
export const COPY_ICON_NAME = "square-behind-square-6";
export const CopyIcon = centralIconWrapper(COPY_ICON_NAME);
export const LightbulbIcon = adaptIcon(IconBulb);
export const LinkIcon = centralIconWrapper("chain-link-3");
// Pull request menu glyphs: a text page for "View PR", the Central GitHub mark for the
// inline "Open in GitHub" button, and a plus bubble for "Add to chat".
export const PageTextIcon: LucideIcon = centralIconWrapper("page-text");
export const GitHubMarkIcon: LucideIcon = centralIconWrapper("github");
export const ChatBubblePlusIcon: LucideIcon = centralIconWrapper("bubble-plus");
export const DiffIcon = centralIconWrapper("difference-modified");
export const DownloadIcon = adaptIcon(IconDownload);
export const BELL_ICON_NAME = "notes";
export const BellIcon: LucideIcon = centralIconWrapper(BELL_ICON_NAME);
export const EllipsisIcon = adaptIcon(IconDots);
export const EyeIcon = adaptIcon(IconEye);
// Markdown Source/Preview toggle glyphs, sourced from the Central set so the
// file-preview header controls share one visual language with the rest of the
// chrome (raw source = code brackets, rendered preview = open eye).
export const CodeIcon: LucideIcon = centralIconWrapper("code");
export const EYE_OPEN_ICON_NAME = "eye-open";
export const EyeOpenIcon: LucideIcon = centralIconWrapper(EYE_OPEN_ICON_NAME);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
export const FlagIcon = adaptIcon(IconFlag);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");
export const PushIcon: LucideIcon = centralIconWrapper("cloud-simple-upload");
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
// Issue state glyphs, GitHub's shapes from the same Central outline set: a ring with a dot
// (open), a checked ring (closed as completed), and a struck ring (closed as not planned).
export const IssueOpenedIcon: LucideIcon = centralIconWrapper("record");
export const IssueClosedIcon: LucideIcon = centralIconWrapper("circle-check");
export const IssueNotPlannedIcon: LucideIcon = centralIconWrapper("circle-ban-sign");
// Three descending-width lines — the app's one "filter controls" glyph (pull
// request list filters, and anywhere else that opens a filter popover).
export const FilterIcon: LucideIcon = centralIconWrapper("filter-2");
// GitHub labels (the code review label filter).
export const TagIcon: LucideIcon = centralIconWrapper("tag");
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = centralIconWrapper("user-group");
// One globe for the whole app (browser rows, web search, favicon fallback,
// local servers): the Central glyph, so it matches the other work-row icons.
export const GlobeIcon: LucideIcon = centralIconWrapper("globe");
export const WebSearchIcon: LucideIcon = GlobeIcon;
// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = centralIconWrapper("phone");
// Hardware-button glyphs for the simulator's control rail.
export const DeviceHomeIcon: LucideIcon = centralIconWrapper("home");
export const DeviceShutterIcon: LucideIcon = centralIconWrapper("camera-1");
// Simulator toolbar: start/stop a screen recording, turn the view, power the
// device off, and let go of it. The two Tabler glyphs have no Central
// equivalent that reads as unambiguously as a rotating handset and a power symbol.
export const DeviceRecordIcon: LucideIcon = centralIconWrapper("record");
export const DeviceRecordStopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const DeviceRotateIcon = adaptIcon(IconDeviceMobileRotated);
export const DevicePowerIcon = adaptIcon(IconPower);
export const DeviceDetachIcon = adaptIcon(IconPlugOff);
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = centralIconWrapper("puzzle");
// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
// Sourced from the Central set so it matches the other work-row icons (pencil,
// terminal, skill cube) it sits beside, instead of the Tabler wrench it used to be.
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon = adaptIcon(IconHistory);
/** Hand a to-do to an agent. */
export const DelegateIcon: LucideIcon = centralIconWrapper("sparkles-two");
export const CalendarIcon: LucideIcon = centralIconWrapper("calendar-1");
export const InfoIcon = adaptIcon(IconInfoCircle);
export const KanbanIcon = centralIconWrapper("columns-3-wide");
/** Take-control affordance for the computer dock pane. */
export const CursorClickIcon: LucideIcon = centralIconWrapper("cursor-click");
export const ListChecksIcon = adaptIcon(IconListCheck);
export const ListTodoIcon = adaptIcon(IconListDetails);
export const Loader2Icon = adaptIcon(IconLoader2);
export const LoaderCircleIcon = adaptIcon(IconLoader2);
export const LoaderIcon = adaptIcon(IconLoader2);
export const Maximize2 = adaptIcon(IconMaximize);
export const Minimize2 = adaptIcon(IconMinimize);
export const MessageCircleIcon = adaptIcon(IconMessageCircle);
export const MinusIcon = adaptIcon(IconMinus);
export const ChatBubbleIcon: LucideIcon = centralIconWrapper("bubble-text");
// Canonical side-chat glyph — every sidechat surface (right dock pane, environment
// panel rows, tabs) must use this one so the feature reads consistently.
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const PanelLeftIcon = centralIconWrapper("sidebar-simple-left-wide");
export const PanelRightCloseIcon = centralIconWrapper("sidebar-simple-right-wide");
export const WindowIcon: LucideIcon = centralIconWrapper("window");
export const LayoutSidebarIcon: LucideIcon = centralIconWrapper("layout-sidebar");
export const PENCIL_ICON_NAME = "pencil";
export const PencilIcon: LucideIcon = centralIconWrapper(PENCIL_ICON_NAME);
export const PIN_ICON_NAME = "pin";
export const PinIcon: LucideIcon = centralIconWrapper(PIN_ICON_NAME);
// Solid pin from the fill set — used wherever a pin reflects "pinned" status
// (project + thread rows and their hover cards) rather than a neutral action.
export const PinFilledIcon: LucideIcon = centralIconWrapper("pin", "fill");
export const PauseIcon: LucideIcon = centralIconWrapper("pause", "fill");
export const PlayIcon: LucideIcon = centralIconWrapper("play", "fill");
// Outline transport glyphs (Central "reversed" set) for surfaces that read as a
// row of neutral actions rather than playback state — e.g. the composer goal strip.
export const PauseOutlineIcon: LucideIcon = centralIconWrapper("pause");
export const PlayOutlineIcon: LucideIcon = centralIconWrapper("play");
/** Outline trash can from the Central set (Trash2 is the legacy Tabler glyph). */
export const TrashCanIcon: LucideIcon = centralIconWrapper("trash-can");
// Persistent thread goal ("Pursuing goal" strip, /goal surfaces).
export const GoalIcon: LucideIcon = centralIconWrapper("target-arrow");
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
// Single source for the settings gear. Every settings affordance renders this
// one Central glyph so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon = adaptIcon(IconStar);
export const StarFilledIcon = adaptIcon(IconStarFilled);
export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const MonitorIcon = adaptIcon(IconDeviceDesktop);
export const StopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const StopFilledIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
const TemporaryThreadGlyph = centralIconWrapper("bubble-annotation-5");
// Dotted "annotation" chat bubble — the temporary thread marker shown on the
// composer toggle and beside temporary threads in the sidebar.
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
// Single source for every "reset / restore default / revert" affordance (settings
// row resets, Restore defaults, effort-slider reset, space reset, file revert):
// the Central reversed counter-clockwise arrow, never a Tabler/Lucide rotate glyph.
export const ResetIcon: LucideIcon = centralIconWrapper("arrow-rotate-counter-clockwise");
export const Redo2Icon = adaptIcon(IconArrowForwardUp);
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
// Single source for the fast-mode glyph. Every fast-mode affordance (composer
// trait badges, the effort-header toggle, the /fast command) renders this one solid
// lightning bolt from the Central fill set instead of mixing Tabler/Ionicons bolts.
export const FastModeIcon: LucideIcon = centralIconWrapper("zap", "fill");
// Outline twin of FastModeIcon (Central reversed set) for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = centralIconWrapper("zap");

// Sidebar and panel toggles, expand/collapse, top-bar add, handoff, Hubs, the rail's update
// button, the one closed / one open folder every project and path row shares, add-folder, and the
// stacked-folders glyph used as the single representation of a file tree / explorer surface
// (right-dock explorer, editor Files activity, diff file-tree toggle), Home, Inbox, Code review,
// Tasks, Worktrees (the split glyph turned to point right), Editor view, Computer use (a mirrored
// pointer), the one terminal glyph, open-outside-the-app, and the schedule clock that doubles as the automation glyph everywhere it appears (meta chip,
// Automations nav, slash command, created card, environment section) (Hugeicons, inlined).
export {
  AppleReminderIcon as TasksIcon,
  ArrowDataTransferHorizontalIcon as HandoffIcon,
  CheckmarkSquare02Icon as CheckboxCheckedIcon,
  Navigation03Icon as ComputerUseIcon,
  ClockHour7Icon as ClockIcon,
  CollapseIcon as PanelCollapseIcon,
  DashboardCircleIcon as HubIcon,
  DashboardCircleSolidIcon as HubActiveIcon,
  Download01Icon as UpdateDownloadIcon,
  ExpandIcon as PanelExpandIcon,
  Folder02Icon as FolderOpenIcon,
  FolderAddIcon,
  FolderClosedIcon as FolderIcon,
  BookOpen01Icon as BookIcon,
  GiftIcon,
  MessageEdit01Icon as FeedbackIcon,
  SlidersHorizontalIcon as CustomizeIcon,
  FolderLibraryIcon as FoldersIcon,
  GitMergeConflictIcon,
  GitPullRequestArrowIcon as GitPullRequestIcon,
  GitPullRequestClosedIcon,
  GitPullRequestCreateArrowIcon as CreatePullRequestIcon,
  GitPullRequestDraftIcon,
  // Forking a thread reuses the branch glyph, so fork and branch share one visual.
  WorkflowCircle05Icon as GitBranchIcon,
  WorkflowCircle05Icon as GitForkIcon,
  SidechatIcon,
  SourceCodeSquareIcon as EditorViewIcon,
  GitCompareArrowsIcon as CodeReviewIcon,
  Home07Icon as HomeIcon,
  InboxIcon,
  Camera01Icon,
  CornerDownRightIcon as SteerIcon,
  Key01Icon,
  MoreHorizontalIcon,
  LinkSquare02Icon as ExternalLinkIcon,
  LayoutAlignLeftIcon,
  LayoutAlignRightIcon,
  LayoutLeftIcon,
  LayoutRightIcon,
  PanelTopOpenIcon,
  PlusSignIcon,
  SquareIcon as CheckboxUncheckedIcon,
  SplitIcon as WorktreeIcon,
  SquareTerminalIcon as TerminalIcon,
  // Merged pull requests (the PR-state glyph); merge *actions* keep GitMergeIcon.
  WorkflowCircle06Icon as GitMergedSimpleIcon,
} from "./hugeicons";
