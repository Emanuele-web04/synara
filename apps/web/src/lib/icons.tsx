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
  IconExternalLink,
  IconEye,
  IconFile,
  IconFlag,
  IconFlask2,
  IconFolder,
  IconFolderOpen,
  IconHistory,
  IconInfoCircle,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconMaximize,
  IconMinimize,
  IconMinus,
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

// CSS mask avoids stroke-on-stroke alpha summation that gave hand-drawn SVGs a stamped-twice look on shared vertices (the PinIcon bug)
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
export const BackgroundTrayIcon: LucideIcon = centralIconWrapper("arrow-down-wall");
export const ContextCompactionIcon: LucideIcon = centralIconWrapper("arrows-hide");
export const PanelExpandIcon: LucideIcon = centralIconWrapper("expand-45");
export const PanelCollapseIcon: LucideIcon = centralIconWrapper("minimize-45");
export const BackToParentIcon: LucideIcon = centralIconWrapper("arrow-share-left");
export const WorkflowIcon: LucideIcon = centralIconWrapper("agents");
export const SteerIcon: LucideIcon = centralIconWrapper("arrow-corner-down-right");
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const HANDOFF_ICON_NAME = "arrow-left-right";
export const HandoffIcon: LucideIcon = centralIconWrapper(HANDOFF_ICON_NAME);
export const SkillCubeIcon: LucideIcon = centralIconWrapper("building-blocks");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
export const FolderAddIcon: LucideIcon = centralIconWrapper("folder-add-left");
export const FolderOpenFrontIcon: LucideIcon = centralIconWrapper("folder-open-front");
export const ImportThreadIcon: LucideIcon = centralIconWrapper("import");
export const UsageGaugeIcon: LucideIcon = centralIconWrapper("gauge");
export const BugReportIcon: LucideIcon = centralIconWrapper("bug");
export const AddPlusIcon: LucideIcon = centralIconWrapper("plus-medium");
export const DragHandleIcon: LucideIcon = centralIconWrapper("dot-grid-2x3");
export const CustomizeIcon: LucideIcon = centralIconWrapper("settings-slider-three");
export const EraserIcon: LucideIcon = centralIconWrapper("eraser");
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);
export const SortIcon: LucideIcon = centralIconWrapper("arrow-top-bottom");
// single source for the robot/agent glyph so every robot affordance renders one identical icon; AGENT_ROBOT_ICON_NAME for imperative DOM
export const AGENT_ROBOT_ICON_NAME = "robot";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BookIcon: LucideIcon = centralIconWrapper("book-simple");
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
// Central set so they sit beside the other timeline glyphs
export const CircleQuestionIcon: LucideIcon = centralIconWrapper("circle-questionmark");
export const ArrowUpCircleIcon: LucideIcon = centralIconWrapper("arrow-up-circle");
export const CloudSyncIcon = centralIconWrapper("cloud-sync");
export const Columns2Icon = adaptIcon(IconColumns2);
export const ChangesIcon = centralIconWrapper("changes");
export const COPY_ICON_NAME = "square-behind-square-6";
export const CopyIcon = centralIconWrapper(COPY_ICON_NAME);
export const LightbulbIcon = adaptIcon(IconBulb);
export const LinkIcon = centralIconWrapper("chain-link-3");
// Pull request menu glyphs: a text page for "View PR", the Central GitHub mark for the inline "Open in GitHub" button, and a plus bubble for "Add to chat".
export const PageTextIcon: LucideIcon = centralIconWrapper("page-text");
export const GitHubMarkIcon: LucideIcon = centralIconWrapper("github");
export const ChatBubblePlusIcon: LucideIcon = centralIconWrapper("bubble-plus");
export const DiffIcon = centralIconWrapper("difference-modified");
export const DownloadIcon = adaptIcon(IconDownload);
// the clock doubles as the automation glyph everywhere (meta chip, nav, slash command, card) so it's sourced from Central not Tabler
export const BELL_ICON_NAME = "notes";
export const BellIcon: LucideIcon = centralIconWrapper(BELL_ICON_NAME);
export const ClockIcon = centralIconWrapper("clock");
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
// Central set so preview controls share one visual language with the rest of the chrome
export const CodeIcon: LucideIcon = centralIconWrapper("code");
export const EYE_OPEN_ICON_NAME = "eye-open";
export const EyeOpenIcon: LucideIcon = centralIconWrapper(EYE_OPEN_ICON_NAME);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
export const FlagIcon = adaptIcon(IconFlag);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const FolderIcon = adaptIcon(IconFolder);
export const FolderOpenIcon = adaptIcon(IconFolderOpen);
// single file-tree/explorer glyph (right-dock explorer, Files activity, diff tree toggle); Central reversed outline to match the chrome
export const FoldersIcon: LucideIcon = centralIconWrapper("folders");
export const GiftIcon: LucideIcon = centralIconWrapper("gift-2");
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitBranchIcon: LucideIcon = centralIconWrapper("branch");
// fork reuses the branch glyph — the Central "fork" asset reads as a second unrelated icon next to it
export const GitForkIcon: LucideIcon = GitBranchIcon;
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");
export const GitMergedSimpleIcon: LucideIcon = centralIconWrapper("merged-simple");
export const PushIcon: LucideIcon = centralIconWrapper("cloud-simple-upload");
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
export const GitPullRequestIcon = centralIconWrapper("pull-request");
// Pull-request state glyphs from the same three-node Central family as "pull-request", so draft/closed/merged read as variations of one icon rather than four styles.
export const GitPullRequestDraftIcon: LucideIcon = centralIconWrapper("draft");
export const GitPullRequestClosedIcon: LucideIcon = centralIconWrapper("request-closed");
export const GitMergeConflictIcon: LucideIcon = centralIconWrapper("merge-conflict");
// Three descending-width lines — the app's one "filter controls" glyph (pull request list filters, and anywhere else that opens a filter popover).
export const FilterIcon: LucideIcon = centralIconWrapper("filter-2");
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = centralIconWrapper("user-group");
// One globe for the whole app (browser rows, web search, favicon fallback, local servers): the Central glyph, so it matches the other work-row icons.
export const GlobeIcon: LucideIcon = centralIconWrapper("globe");
export const WebSearchIcon: LucideIcon = GlobeIcon;
// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = centralIconWrapper("phone");
// Hardware-button glyphs for the simulator's control rail.
export const DeviceHomeIcon: LucideIcon = centralIconWrapper("home");
export const DeviceShutterIcon: LucideIcon = centralIconWrapper("camera-1");
// the two Tabler glyphs have no Central equivalent that reads as unambiguously as a rotating handset and a power symbol
export const DeviceRecordIcon: LucideIcon = centralIconWrapper("record");
export const DeviceRecordStopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const DeviceRotateIcon = adaptIcon(IconDeviceMobileRotated);
export const DevicePowerIcon = adaptIcon(IconPower);
export const DeviceDetachIcon = adaptIcon(IconPlugOff);
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = centralIconWrapper("puzzle");
// Central set to match the work-row icons it sits beside, instead of the old Tabler wrench
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon = adaptIcon(IconHistory);
export const InfoIcon = adaptIcon(IconInfoCircle);
export const KanbanIcon = centralIconWrapper("columns-3-wide");
export const KeyboardIcon: LucideIcon = centralIconWrapper("keyboard");
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
// canonical side-chat glyph — every sidechat surface must use this one so the feature reads consistently
export const SidechatIcon: LucideIcon = centralIconWrapper("chat-bubble-7");
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const PanelLeftIcon = centralIconWrapper("sidebar-simple-left-wide");
export const PanelRightCloseIcon = centralIconWrapper("sidebar-simple-right-wide");
export const WindowIcon: LucideIcon = centralIconWrapper("window");
export const LayoutSidebarIcon: LucideIcon = centralIconWrapper("layout-sidebar");
export const PENCIL_ICON_NAME = "pencil";
export const PencilIcon: LucideIcon = centralIconWrapper(PENCIL_ICON_NAME);
export const PIN_ICON_NAME = "pin";
export const PinIcon: LucideIcon = centralIconWrapper(PIN_ICON_NAME);
// solid fill pin wherever a pin reflects pinned status, not a neutral action
export const PinFilledIcon: LucideIcon = centralIconWrapper("pin", "fill");
export const PauseIcon: LucideIcon = centralIconWrapper("pause", "fill");
export const PlayIcon: LucideIcon = centralIconWrapper("play", "fill");
// Outline transport glyphs (Central "reversed" set) for surfaces that read as a row of neutral actions rather than playback state — e.g. the composer goal strip.
export const PauseOutlineIcon: LucideIcon = centralIconWrapper("pause");
export const PlayOutlineIcon: LucideIcon = centralIconWrapper("play");
export const TrashCanIcon: LucideIcon = centralIconWrapper("trash-can");
// Persistent thread goal ("Pursuing goal" strip, /goal surfaces).
export const GoalIcon: LucideIcon = centralIconWrapper("target-arrow");
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
// Single source for the settings gear. Every settings affordance renders this one Central glyph so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon = adaptIcon(IconStar);
export const StarFilledIcon = adaptIcon(IconStarFilled);
export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const StopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const StopFilledIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
const TemporaryThreadGlyph = centralIconWrapper("bubble-annotation-5");
// Dotted "annotation" chat bubble — the temporary thread marker shown on the composer toggle and beside temporary threads in the sidebar.
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TERMINAL_ICON_NAME = "console";
export const TerminalIcon = centralIconWrapper(TERMINAL_ICON_NAME);
export const TerminalSquare = centralIconWrapper("console");
export const TerminalSquareIcon = centralIconWrapper("console");
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
// single source for every reset/restore/revert affordance — the Central reversed counter-clockwise arrow, never a Tabler/Lucide rotate glyph
export const ResetIcon: LucideIcon = centralIconWrapper("arrow-rotate-counter-clockwise");
export const Redo2Icon = adaptIcon(IconArrowForwardUp);
export const WorktreeIcon = centralIconWrapper("arrow-split-right");
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
// single fast-mode glyph — this one solid Central bolt instead of mixing Tabler/Ionicons bolts
export const FastModeIcon: LucideIcon = centralIconWrapper("zap", "fill");
// Outline twin of FastModeIcon (Central reversed set) for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = centralIconWrapper("zap");
