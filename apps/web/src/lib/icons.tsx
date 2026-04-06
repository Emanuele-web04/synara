import { type FC, type SVGProps } from "react";
import { PiGitCommit } from "react-icons/pi";
import { TbPlug } from "react-icons/tb";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowLeft,
  IconArrowRight,
  IconArrowsSplit2,
  IconArrowsUpDown,
  IconBolt,
  IconBug,
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
  IconPlayerPlay,
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

export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowUpDownIcon = adaptIcon(IconArrowsUpDown);
export const BotIcon = adaptIcon(IconRobot);
export const BugIcon = adaptIcon(IconBug);
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
export const FileIcon = adaptIcon(IconFile);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const FolderClosedIcon = adaptIcon(IconFolder);
export const FolderIcon = adaptIcon(IconFolder);
export const FolderOpenIcon = adaptIcon(IconFolderOpen);
export const GitCommitIcon: LucideIcon = (props) => (
  <PiGitCommit className={props.className} style={props.style} />
);
export const GitForkIcon = adaptIcon(IconGitFork);
export const GitPullRequestIcon = adaptIcon(IconGitPullRequest);
export const GlobeIcon = adaptIcon(IconWorld);
export const PlugIcon: LucideIcon = (props) => (
  <TbPlug className={props.className} style={props.style} />
);
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
export const PanelLeftCloseIcon = adaptIcon(IconLayoutSidebarLeftCollapse);
export const PanelLeftIcon = adaptIcon(IconLayoutSidebarLeftExpand);
export const PanelRightCloseIcon = adaptIcon(IconLayoutSidebarRightCollapse);
export const PlayIcon = adaptIcon(IconPlayerPlay);
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RocketIcon = adaptIcon(IconRocket);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon = adaptIcon(IconSearch);
export const SettingsIcon = adaptIcon(IconSettings);
export const SquarePenIcon = adaptIcon(IconEdit);
export const SquareSplitHorizontal = adaptIcon(IconArrowsSplit2);
export const TerminalIcon = adaptIcon(IconTerminal);
export const TerminalSquare = adaptIcon(IconTerminal2);
export const TerminalSquareIcon = adaptIcon(IconTerminal2);
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
export const WrenchIcon = adaptIcon(IconTool);
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
