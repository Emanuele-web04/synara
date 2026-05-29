import { type CSSProperties, type FC, type SVGProps } from "react";
import { PiGitCommit, PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { LuMessageSquareDashed, LuSplit } from "react-icons/lu";
import { cn } from "./utils";
import { CentralIcon } from "./central-icons";
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
  IconArrowsUpDown,
  IconBell,
  IconBolt,
  IconBrain,
  IconBug,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconCloudUpload,
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
  IconGitCompare,
  IconGitFork,
  IconGitPullRequest,
  IconEdit,
  IconInfoCircle,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconLock,
  IconLockOpen,
  IconMaximize,
  IconMinimize,
  IconDeviceLaptop,
  IconMessageCircle,
  IconMoon,
  IconPalette,
  IconPaperclip,
  IconPinnedFilled,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconRocket,
  IconRobot,
  IconRotate2,
  IconSelector,
  IconSettings,
  IconStar,
  IconStarFilled,
  IconSun,
  IconTerminal,
  IconTerminal2,
  IconTextWrap,
  IconTool,
  IconTrash,
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
function centralIconWrapper(name: string): LucideIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
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
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const HandoffIcon: LucideIcon = centralIconWrapper("branch-simple");
export const SkillCubeIcon: LucideIcon = centralIconWrapper("box-2");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const BellIcon = adaptIcon(IconBell);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpDownIcon = adaptIcon(IconArrowsUpDown);
export const BotIcon = adaptIcon(IconRobot);
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
export const CloudUploadIcon = adaptIcon(IconCloudUpload);
export const Columns2Icon = adaptIcon(IconColumns2);
export const CopyIcon = centralIconWrapper("square-behind-square-6");
export const DiffIcon = adaptIcon(IconGitCompare);
export const DownloadIcon = adaptIcon(IconDownload);
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
export const GitCommitIcon: LucideIcon = (props) => (
  <PiGitCommit className={props.className} style={props.style} />
);
export const GitForkIcon = adaptIcon(IconGitFork);
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
export const GitPullRequestIcon = adaptIcon(IconGitPullRequest);
export const GlobeIcon = adaptIcon(IconWorld);
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PlugIcon: LucideIcon = centralIconWrapper("plugin-1");
export const HammerIcon = adaptIcon(IconTool);
export const InfoIcon = adaptIcon(IconInfoCircle);
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
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const PanelLeftCloseIcon = adaptIcon(IconLayoutSidebarLeftCollapse);
export const PanelLeftIcon = adaptIcon(IconLayoutSidebarLeftExpand);
export const PanelRightCloseIcon = adaptIcon(IconLayoutSidebarRightCollapse);
export const PinIcon: LucideIcon = centralIconWrapper("pin");
export const PinnedFilledIcon = adaptIcon(IconPinnedFilled);
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
export const SquarePenIcon = adaptIcon(IconEdit);
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
// react-icons/lu glyphs occupy more of the 24×24 viewBox than Tabler/Central icons at
// the same Tailwind size — use `chromeLu` in sidebarGlyphs beside `chrome` controls.
export const DisposableThreadIcon: LucideIcon = (props) => (
  <LuMessageSquareDashed
    className={cn("size-3 shrink-0", props.className)}
    style={props.style}
  />
);
export const TerminalIcon = adaptIcon(IconTerminal);
export const TerminalSquare = adaptIcon(IconTerminal2);
export const TerminalSquareIcon = adaptIcon(IconTerminal2);
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
export const WrenchIcon = adaptIcon(IconTool);
export const WorktreeIcon: LucideIcon = (props) => (
  <LuSplit
    className={props.className}
    style={{
      ...props.style,
      transform: `${props.style?.transform ?? ""} rotate(90deg)`.trim(),
    }}
  />
);
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
