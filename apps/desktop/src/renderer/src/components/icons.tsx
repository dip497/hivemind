/**
 * Every icon the app draws, named for what it shows. One set and one stroke weight, chosen here
 * and nowhere else: a file imports its icons from this module, never from an icon package.
 */
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AlarmClockIcon, AlarmClockOffIcon, AlertCircleIcon, AppWindowIcon, ArrowDown02Icon, ArrowLeft02Icon,
  ArrowRight02Icon, ArrowUp02Icon, ArrowUpRight01Icon, BellIcon, BlocksIcon, BotIcon, CheckIcon,
  ChevronDownIcon, ChevronRightIcon, CloudServerIcon, ContainerIcon, ChevronUpIcon, CircleCheckIcon, Copy01Icon, Download01Icon, EarthIcon,
  EllipsisIcon, EllipsisVerticalIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, FileCodeCornerIcon,
  FileQuestionMarkIcon, Files01Icon, Film01Icon, Folder01Icon, FolderGitIcon, FolderMinusIcon, FolderOpenIcon,
  FolderPlusIcon, GitBranchIcon, GitCommitHorizontalIcon, GitCompareIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, GlobeIcon, GripVerticalIcon,
  HistoryIcon, Home01Icon, Image01Icon, InboxIcon, InfoIcon, Key01Icon, KeyboardIcon, LaptopIcon,
  LayoutGridIcon, LayoutListIcon, ListTodoIcon, LoaderCircleIcon, LogInIcon, LogOutIcon, Mail01Icon,
  MailOpenIcon, Maximize01Icon, MessageSquareIcon, MessagesSquareIcon, MonitorIcon, MonitorSmartphoneIcon, Moon02Icon,
  MoveUpRightIcon, NetworkIcon, PaletteIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PanelsTopLeftIcon, PencilIcon, PinIcon,
  PinOffIcon, PlayIcon, PlusIcon, PowerIcon, PuzzleIcon, RefreshCwIcon, RotateCwIcon,
  Search01Icon, ServerIcon, ServerOffIcon, Settings01Icon, Settings02Icon, DashboardSquareAddIcon, SlidersHorizontalIcon,
  SmartphoneIcon, SparklesIcon, SquareDashedIcon, SquarePenIcon, SquareTerminalIcon, Tag01Icon, TerminalIcon, TrashIcon,
  TriangleAlertIcon, Unlink01Icon, UnplugIcon, Upload01Icon, UserPlusIcon, UserRoundIcon, UsersIcon,
  Wrench01Icon, XIcon,
} from "@hugeicons/core-free-icons";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  size?: number | string;
  strokeWidth?: number;
}
export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/** The line weight beside regular text. */
const STROKE = 1.5;

function icon(name: string, glyph: IconSvgElement): Icon {
  const C = forwardRef<SVGSVGElement, IconProps>(({ size = 24, strokeWidth = STROKE, ...rest }, ref) => (
    // Decorative unless it is given a name of its own.
    <HugeiconsIcon ref={ref} icon={glyph} size={size} strokeWidth={strokeWidth} data-icon={name}
      aria-hidden={rest["aria-label"] ? undefined : true} {...rest} />
  ));
  C.displayName = name;
  return C;
}

export const AlarmClock = icon("alarm-clock", AlarmClockIcon);
export const AlarmClockOff = icon("alarm-clock-off", AlarmClockOffIcon);
export const AppWindow = icon("app-window", AppWindowIcon);
export const ArrowDown = icon("arrow-down", ArrowDown02Icon);
export const ArrowLeft = icon("arrow-left", ArrowLeft02Icon);
export const ArrowRight = icon("arrow-right", ArrowRight02Icon);
export const ArrowUp = icon("arrow-up", ArrowUp02Icon);
export const ArrowUpRight = icon("arrow-up-right", ArrowUpRight01Icon);
export const Bell = icon("bell", BellIcon);
export const Blocks = icon("blocks", BlocksIcon);
export const Bot = icon("bot", BotIcon);
export const Check = icon("check", CheckIcon);
export const ChevronDown = icon("chevron-down", ChevronDownIcon);
export const ChevronRight = icon("chevron-right", ChevronRightIcon);
export const ChevronUp = icon("chevron-up", ChevronUpIcon);
export const CircleAlert = icon("circle-alert", AlertCircleIcon);
export const CircleCheck = icon("circle-check", CircleCheckIcon);
export const Copy = icon("copy", Copy01Icon);
export const Download = icon("download", Download01Icon);
export const Earth = icon("earth", EarthIcon);
export const Ellipsis = icon("ellipsis", EllipsisIcon);
export const EllipsisVertical = icon("ellipsis-vertical", EllipsisVerticalIcon);
export const ExternalLink = icon("external-link", ExternalLinkIcon);
export const Eye = icon("eye", EyeIcon);
export const EyeOff = icon("eye-off", EyeOffIcon);
export const FileCode = icon("file-code", FileCodeCornerIcon);
export const FileQuestion = icon("file-question", FileQuestionMarkIcon);
export const Files = icon("files", Files01Icon);
export const Film = icon("film", Film01Icon);
export const Folder = icon("folder", Folder01Icon);
export const FolderGit = icon("folder-git", FolderGitIcon);
export const FolderMinus = icon("folder-minus", FolderMinusIcon);
export const FolderOpen = icon("folder-open", FolderOpenIcon);
export const FolderPlus = icon("folder-plus", FolderPlusIcon);
export const GitBranch = icon("git-branch", GitBranchIcon);
export const GitCommit = icon("git-commit", GitCommitHorizontalIcon);
export const GitCompare = icon("git-compare", GitCompareIcon);
export const GitMerge = icon("git-merge", GitMergeIcon);
export const GitPullRequest = icon("git-pull-request", GitPullRequestIcon);
export const GitPullRequestClosed = icon("git-pull-request-closed", GitPullRequestClosedIcon);
export const GitPullRequestDraft = icon("git-pull-request-draft", GitPullRequestDraftIcon);
export const Globe = icon("globe", GlobeIcon);
export const GripVertical = icon("grip-vertical", GripVerticalIcon);
export const History = icon("history", HistoryIcon);
export const House = icon("house", Home01Icon);
export const Image = icon("image", Image01Icon);
export const Inbox = icon("inbox", InboxIcon);
export const Info = icon("info", InfoIcon);
export const Key = icon("key", Key01Icon);
export const Keyboard = icon("keyboard", KeyboardIcon);
export const Laptop = icon("laptop", LaptopIcon);
export const CloudServer = icon("cloud-server", CloudServerIcon);
export const Container = icon("container", ContainerIcon);
export const LayoutGrid = icon("layout-grid", LayoutGridIcon);
export const LayoutList = icon("layout-list", LayoutListIcon);
export const ListTodo = icon("list-todo", ListTodoIcon);
export const Spinner = icon("spinner", LoaderCircleIcon);
export const LogIn = icon("log-in", LogInIcon);
export const LogOut = icon("log-out", LogOutIcon);
export const Mail = icon("mail", Mail01Icon);
export const MailOpen = icon("mail-open", MailOpenIcon);
export const Maximize = icon("maximize", Maximize01Icon);
export const MessageSquare = icon("message-square", MessageSquareIcon);
export const MessagesSquare = icon("messages-square", MessagesSquareIcon);
export const Monitor = icon("monitor", MonitorIcon);
export const MonitorSmartphone = icon("monitor-smartphone", MonitorSmartphoneIcon);
export const Moon = icon("moon", Moon02Icon);
export const MoveUpRight = icon("move-up-right", MoveUpRightIcon);
export const Network = icon("network", NetworkIcon);
export const Palette = icon("palette", PaletteIcon);
export const PanelLeftClose = icon("panel-left-close", PanelLeftCloseIcon);
export const PanelLeftOpen = icon("panel-left-open", PanelLeftOpenIcon);
export const PanelsTopLeft = icon("panels-top-left", PanelsTopLeftIcon);
export const Pencil = icon("pencil", PencilIcon);
export const Pin = icon("pin", PinIcon);
export const PinOff = icon("pin-off", PinOffIcon);
export const Play = icon("play", PlayIcon);
export const Plus = icon("plus", PlusIcon);
export const Power = icon("power", PowerIcon);
export const Puzzle = icon("puzzle", PuzzleIcon);
export const RefreshCw = icon("refresh", RefreshCwIcon);
export const RotateCw = icon("rotate-cw", RotateCwIcon);
export const Search = icon("search", Search01Icon);
export const Server = icon("server", ServerIcon);
export const ServerOff = icon("server-off", ServerOffIcon);
export const Settings = icon("settings", Settings01Icon);
export const Settings2 = icon("settings-2", Settings02Icon);
export const AddWidget = icon("add-widget", DashboardSquareAddIcon);
export const SlidersHorizontal = icon("sliders-horizontal", SlidersHorizontalIcon);
export const Smartphone = icon("smartphone", SmartphoneIcon);
export const Sparkles = icon("sparkles", SparklesIcon);
export const SquareDashed = icon("square-dashed", SquareDashedIcon);
export const SquarePen = icon("square-pen", SquarePenIcon);
export const SquareTerminal = icon("square-terminal", SquareTerminalIcon);
export const Tag = icon("tag", Tag01Icon);
export const Terminal = icon("terminal", TerminalIcon);
export const Trash = icon("trash", TrashIcon);
export const TriangleAlert = icon("triangle-alert", TriangleAlertIcon);
export const Unlink = icon("unlink", Unlink01Icon);
export const Unplug = icon("unplug", UnplugIcon);
export const Upload = icon("upload", Upload01Icon);
export const UserPlus = icon("user-plus", UserPlusIcon);
export const UserRound = icon("user-round", UserRoundIcon);
export const Users = icon("users", UsersIcon);
export const Wrench = icon("wrench", Wrench01Icon);
export const X = icon("x", XIcon);
