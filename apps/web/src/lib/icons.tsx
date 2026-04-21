import { type FC, type SVGProps } from "react";
import { PiGitCommit, PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { LuSplit } from "react-icons/lu";
import { TbArrowsRightLeft } from "react-icons/tb";
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
  IconCopy,
  IconDots,
  IconExternalLink,
  IconEye,
  IconFile,
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
  IconMessageCircle,
  IconMicrophone,
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
  IconSearch,
  IconSelector,
  IconSettings,
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

export const AppsIcon: LucideIcon = (props) => (
  <RiApps2Line className={props.className} style={props.style} />
);
export const QueueArrow: LucideIcon = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M3.75 5.75V15.25C3.75 16.3546 4.64543 17.25 5.75 17.25H19.25" />
    <path d="M18 19V15.5L20.25 17.25L18 19Z" />
    <path d="M8.25 7.25H16.75" />
    <path d="M8.25 12.25H13.25" />
  </svg>
);
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
export const CopyIcon = adaptIcon(IconCopy);
export const DiffIcon = adaptIcon(IconGitCompare);
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
export const PaletteIcon = adaptIcon(IconPalette);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const AdjustmentsIcon = adaptIcon(IconAdjustments);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
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
export const PlugIcon: LucideIcon = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M3.75 7C3.75 8.79493 5.20507 10.25 7 10.25C8.79493 10.25 10.25 8.79493 10.25 7C10.25 5.20507 8.79493 3.75 7 3.75C5.20507 3.75 3.75 5.20507 3.75 7Z" />
    <path d="M3.75 17C3.75 18.7949 5.20507 20.25 7 20.25C8.79493 20.25 10.25 18.7949 10.25 17C10.25 15.2051 8.79493 13.75 7 13.75C5.20507 13.75 3.75 15.2051 3.75 17Z" />
    <path d="M13.75 7C13.75 8.79493 15.2051 10.25 17 10.25C18.7949 10.25 20.25 8.79493 20.25 7C20.25 5.20507 18.7949 3.75 17 3.75C15.2051 3.75 13.75 5.20507 13.75 7Z" />
    <path d="M13.75 17C13.75 18.7949 15.2051 20.25 17 20.25C18.7949 20.25 20.25 18.7949 20.25 17C20.25 15.2051 18.7949 13.75 17 13.75C15.2051 13.75 13.75 15.2051 13.75 17Z" />
    <path d="M9.5 14.5L14.5 9.5" />
  </svg>
);
export const HammerIcon = adaptIcon(IconTool);
export const HandoffIcon: LucideIcon = (props) => (
  <TbArrowsRightLeft className={props.className} style={props.style} />
);
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
export const MicIcon = adaptIcon(IconMicrophone);
export const PanelLeftCloseIcon = adaptIcon(IconLayoutSidebarLeftCollapse);
export const PanelLeftIcon = adaptIcon(IconLayoutSidebarLeftExpand);
export const PanelRightCloseIcon = adaptIcon(IconLayoutSidebarRightCollapse);
export const PinIcon: LucideIcon = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M8.375 15.625L12.2092 19.4592C13.3676 20.6175 15.351 19.9682 15.6001 18.3491L16.3396 13.5425C16.44 12.8901 16.8558 12.3292 17.4509 12.0435L20.2054 10.7214C21.4483 10.1248 21.729 8.47902 20.7542 7.50413L16.4959 3.24583C15.521 2.27093 13.8752 2.55164 13.2786 3.79458L11.9564 6.54908C11.6708 7.14417 11.1099 7.55999 10.4575 7.66036L5.65092 8.39984C4.03176 8.64894 3.38243 10.6324 4.54081 11.7908L8.375 15.625Z" />
    <path d="M8.38235 15.6176L8.375 15.625" />
    <path d="M8.375 15.625L3.75 20.25" />
  </svg>
);
export const PinnedFilledIcon = adaptIcon(IconPinnedFilled);
export const PlayIcon = adaptIcon(IconPlayerPlay);
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RocketIcon = adaptIcon(IconRocket);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon = adaptIcon(IconSearch);
export const SettingsIcon = adaptIcon(IconSettings);
export const StopIcon = adaptIcon(IconPlayerStop);
export const SquarePenIcon = adaptIcon(IconEdit);
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
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
