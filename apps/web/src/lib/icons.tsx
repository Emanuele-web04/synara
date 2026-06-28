import { type CSSProperties, type FC, type SVGProps } from "react";
import { PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { LuMessageSquareDashed } from "react-icons/lu";
import { cn } from "./utils";
import { CentralIcon, type CentralIconVariant } from "./central-icons";
import {
  IconAdjustments,
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpRight,
  IconArrowsUpDown,
  IconBell,
  IconBolt,
  IconBrain,
  IconBug,
  IconCamera,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconColumns2,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconFile,
  IconFlag,
  IconFlame,
  IconFlask2,
  IconHash,
  IconFolder,
  IconFolderOpen,
  IconHistory,
  IconInfoCircle,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconLock,
  IconLockOpen,
  IconMaximize,
  IconMinimize,
  IconMinus,
  IconDeviceLaptop,
  IconMessageCircle,
  IconMoon,
  IconPalette,
  IconPaperclip,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlayerStopFilled,
  IconPlus,
  IconRefresh,
  IconRocket,
  IconRotate2,
  IconSelector,
  IconSettings,
  IconShare3,
  IconSparkles,
  IconStar,
  IconStarFilled,
  IconSun,
  IconTextWrap,
  IconTool,
  IconTrash,
  IconTrophy,
  IconWorld,
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
export const QueueArrow: LucideIcon = centralIconWrapper("reading-list");
export const SteerIcon: LucideIcon = centralIconWrapper("arrow-corner-down-right");
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const HandoffIcon: LucideIcon = centralIconWrapper("arrow-left-right");
export const SkillCubeIcon: LucideIcon = centralIconWrapper("building-blocks");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
export const EraserIcon: LucideIcon = centralIconWrapper("eraser");
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const BellIcon = adaptIcon(IconBell);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);
export const ArrowUpDownIcon = adaptIcon(IconArrowsUpDown);
// Single source for the robot/agent glyph. Sourced from the Central icon set so
// every robot affordance (reasoning rows, agent-task rows, agent mention chips,
// subagent menus, agent-activity headers) renders one identical icon. Use
// BotIcon in React; AGENT_ROBOT_ICON_NAME for imperative DOM via
// createCentralIconElement.
export const AGENT_ROBOT_ICON_NAME = "robot";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BugIcon = adaptIcon(IconBug);
export const CameraIcon = adaptIcon(IconCamera);
export const CheckIcon = adaptIcon(IconCheck);
export const ChevronDownIcon = adaptIcon(IconChevronDown);
export const ChevronLeftIcon = adaptIcon(IconChevronLeft);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ChevronUpIcon = adaptIcon(IconChevronUp);
export const ChevronsUpDownIcon = adaptIcon(IconSelector);
export const CircleAlertIcon = adaptIcon(IconAlertCircle);
export const CircleCheckIcon = adaptIcon(IconCircleCheck);
export const CloudUploadIcon = centralIconWrapper("cloud-upload");
export const CloudSyncIcon = centralIconWrapper("cloud-sync");
export const Columns2Icon = adaptIcon(IconColumns2);
export const ChangesIcon = centralIconWrapper("changes");
export const CopyIcon = centralIconWrapper("square-behind-square-6");
export const LinkIcon = centralIconWrapper("chain-link-3");
export const DiffIcon = centralIconWrapper("difference-modified");
export const DownloadIcon = adaptIcon(IconDownload);
export const FlameIcon = adaptIcon(IconFlame);
export const TrophyIcon = adaptIcon(IconTrophy);
// The clock doubles as the automation glyph everywhere it appears (meta chip,
// Automations nav, slash command, created card, environment section), so it is
// sourced from the Central icon set rather than the Tabler stroke icon.
export const ClockIcon = centralIconWrapper("clock");
export const ChartBarIcon = adaptIcon(IconChartBar);
export const ShareIcon = adaptIcon(IconShare3);
export const SparklesIcon = adaptIcon(IconSparkles);
export const HashIcon = adaptIcon(IconHash);
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
export const PaletteIcon = adaptIcon(IconPalette);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const AdjustmentsIcon = adaptIcon(IconAdjustments);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
export const FlagIcon = adaptIcon(IconFlag);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const FolderClosedIcon = adaptIcon(IconFolder);
export const FolderIcon = adaptIcon(IconFolder);
export const FolderOpenIcon = adaptIcon(IconFolderOpen);
// Stacked "folders" glyph used as the single representation of a file tree /
// explorer surface (right-dock explorer, editor Files activity, diff file-tree
// toggle). Central "reversed" outline asset so it matches the rest of the chrome.
export const FoldersIcon: LucideIcon = centralIconWrapper("folders");
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitBranchIcon: LucideIcon = centralIconWrapper("branch");
export const GitForkIcon = centralIconWrapper("fork");
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");
export const GitMergedSimpleIcon: LucideIcon = centralIconWrapper("merged-simple");
export const PushIcon: LucideIcon = centralIconWrapper("cloud-simple-upload");
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
export const GitPullRequestIcon = centralIconWrapper("pull-request");
export const GlobeIcon = adaptIcon(IconWorld);
export const WebSearchIcon: LucideIcon = centralIconWrapper("globe");
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = centralIconWrapper("puzzle");
export const HammerIcon = adaptIcon(IconTool);
export const HistoryIcon = adaptIcon(IconHistory);
export const InfoIcon = adaptIcon(IconInfoCircle);
export const KanbanIcon = centralIconWrapper("columns-3-wide");
export const ListChecksIcon = adaptIcon(IconListCheck);
export const ListTodoIcon = adaptIcon(IconListDetails);
export const Loader2Icon = adaptIcon(IconLoader2);
export const LoaderCircleIcon = adaptIcon(IconLoader2);
export const LoaderIcon = adaptIcon(IconLoader2);
export const LockIcon = adaptIcon(IconLock);
export const LockOpenIcon = adaptIcon(IconLockOpen);
export const Maximize2 = adaptIcon(IconMaximize);
export const Minimize2 = adaptIcon(IconMinimize);
export const MessageCircleIcon = adaptIcon(IconMessageCircle);
export const MinusIcon = adaptIcon(IconMinus);
export const ChatBubbleIcon: LucideIcon = centralIconWrapper("bubble-text");
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const SidebarHiddenLeftWideIcon = centralIconWrapper("sidebar-hidden-left-wide");
export const SidebarHiddenRightWideIcon = centralIconWrapper("sidebar-hidden-right-wide");
export const PanelLeftCloseIcon = SidebarHiddenLeftWideIcon;
export const PanelLeftIcon = centralIconWrapper("sidebar-simple-left-wide");
export const PanelRightCloseIcon = SidebarHiddenRightWideIcon;
export const WindowIcon: LucideIcon = centralIconWrapper("window");
export const LayoutSidebarIcon: LucideIcon = centralIconWrapper("layout-sidebar");
export const PencilIcon: LucideIcon = centralIconWrapper("pencil");
export const PinIcon: LucideIcon = centralIconWrapper("pin");
// Solid pin from the fill set — used wherever a pin reflects "pinned" status
// (project + thread rows and their hover cards) rather than a neutral action.
export const PinFilledIcon: LucideIcon = centralIconWrapper("pin", "fill");
export const PlayIcon = adaptIcon(IconPlayerPlay);
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RocketIcon = adaptIcon(IconRocket);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
export const SettingsIcon = adaptIcon(IconSettings);
export const StarIcon = adaptIcon(IconStar);
export const StarFilledIcon = adaptIcon(IconStarFilled);
export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const StopIcon = adaptIcon(IconPlayerStop);
export const StopFilledIcon = adaptIcon(IconPlayerStopFilled);
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
// react-icons/lu glyphs occupy more of the 24×24 viewBox than Tabler/Central icons at
// the same Tailwind size — use `chromeLu` in sidebarGlyphs beside `chrome` controls.
export const DisposableThreadIcon: LucideIcon = (props) => (
  <LuMessageSquareDashed className={cn("size-3 shrink-0", props.className)} style={props.style} />
);
export const TerminalIcon = centralIconWrapper("console");
export const TerminalSquare = centralIconWrapper("console");
export const TerminalSquareIcon = centralIconWrapper("console");
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
export const WrenchIcon = adaptIcon(IconTool);
export const WorktreeIcon = centralIconWrapper("arrow-split-right");
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
