// FILE: hugeicons.tsx
// Purpose: The Hugeicons the app uses (stroke · rounded), inlined as SVG so the icon
//          package is not a dependency. Paths copied verbatim from
//          @hugeicons/core-free-icons 4.3.5 (MIT, https://hugeicons.com). To add one, print
//          its entry with `node apps/web/scripts/hugeicon-snippet.mjs <icon-name>`.
// Layer: Icon registry (re-exported from ~/lib/icons)

import type { SVGProps } from "react";

import type { LucideIcon } from "./icons";

interface HugeiconPath {
  d: string;
  // Hugeicons leaves the cap off lines that meet the frame, so they stop flush with it.
  round?: boolean;
  // Some paths round only the cap or only the join (the folders); `round` sets both.
  roundCap?: boolean;
  roundJoin?: boolean;
}

// Hugeicons draws a 1.5 stroke on a 24 grid, under 1px once shrunk to the 12–14px of
// meta rows and menus; callers rendering one that small pass a heavier `strokeWidth`.
// `mirror` flips the drawing left to right, then `rotate` turns it clockwise by that many degrees;
// both pivot on the center of the grid.
function createHugeicon(
  displayName: string,
  paths: readonly HugeiconPath[],
  options: { strokeWidth?: number; solid?: boolean; rotate?: number; mirror?: boolean } = {},
): LucideIcon {
  const drawnPaths = paths.map((path) => (
    <path
      key={path.d}
      d={path.d}
      {...(path.round || path.roundCap ? { strokeLinecap: "round" } : {})}
      {...(path.round || path.roundJoin ? { strokeLinejoin: "round" } : {})}
    />
  ));
  const transform =
    [
      options.rotate ? `rotate(${options.rotate} 12 12)` : null,
      options.mirror ? "translate(24 0) scale(-1 1)" : null,
    ]
      .filter(Boolean)
      .join(" ") || null;
  function Hugeicon(props: SVGProps<SVGSVGElement>) {
    const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill={options.solid ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={options.strokeWidth ?? 1.5}
        role={labelled ? "img" : undefined}
        aria-hidden={labelled ? undefined : true}
        data-slot="hugeicon"
        {...props}
      >
        {transform ? <g transform={transform}>{drawnPaths}</g> : drawnPaths}
      </svg>
    );
  }
  Hugeicon.displayName = displayName;
  return Hugeicon;
}

const ROUNDED_SQUARE =
  "M11 3H13C16.7712 3 18.6569 3 19.8284 4.17157C21 5.34315 21 7.22876 21 11V13C21 16.7712 21 18.6569 19.8284 19.8284C18.6569 21 16.7712 21 13 21H11C7.22876 21 5.34315 21 4.17157 19.8284C3 18.6569 3 16.7712 3 13V11C3 7.22876 3 5.34315 4.17157 4.17157C5.34315 3 7.22876 3 11 3Z";

/** Sidebar on the right, collapsed to a slim handle (`layout-align-right`). */
export const LayoutAlignRightIcon = createHugeicon("LayoutAlignRightIcon", [
  { d: ROUNDED_SQUARE, round: true },
  { d: "M16 8L16 16", round: true },
]);

/** Sidebar on the left, open (`layout-left`). */
export const LayoutLeftIcon = createHugeicon("LayoutLeftIcon", [
  {
    d: "M20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28248 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088Z",
    round: true,
  },
  { d: "M9 21.5L9 2.5" },
]);

/** Sidebar on the left, collapsed to a slim handle (`layout-align-left`). */
export const LayoutAlignLeftIcon = createHugeicon("LayoutAlignLeftIcon", [
  { d: ROUNDED_SQUARE, round: true },
  { d: "M8.00488 16.0049L8.00488 8.00488", round: true },
]);

/** Sidebar on the right, open (`layout-right`). */
export const LayoutRightIcon = createHugeicon("LayoutRightIcon", [
  {
    d: "M3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124Z",
    round: true,
  },
  { d: "M15 2.5L15 21.5" },
]);

/** Top panel with an open chevron (`panel-top-open`): the Environment panel toggle. */
export const PanelTopOpenIcon = createHugeicon("PanelTopOpenIcon", [
  {
    d: "M2.49219 12C2.49219 7.52166 2.49219 5.28249 3.88343 3.89124C5.27467 2.5 7.51384 2.5 11.9922 2.5C16.4705 2.5 18.7097 2.5 20.1009 3.89124C21.4922 5.28249 21.4922 7.52166 21.4922 12C21.4922 16.4783 21.4922 18.7175 20.1009 20.1088C18.7097 21.5 16.4705 21.5 11.9922 21.5C7.51384 21.5 5.27467 21.5 3.88343 20.1088C2.49219 18.7175 2.49219 16.4783 2.49219 12Z",
  },
  { d: "M20.9922 9L2.99219 9", round: true },
  { d: "M8.99219 13L11.9922 16L14.9922 13", round: true },
]);

/** Plus (`plus-sign`): add actions in the top bar, matching the toggles beside them. */
export const PlusSignIcon = createHugeicon("PlusSignIcon", [
  { d: "M12 4V20M20 12H4", round: true },
]);

/** Expand (`expand`): grow a panel or card to its larger size. */
export const ExpandIcon = createHugeicon("ExpandIcon", [
  {
    d: "M19 12L19 8.99996C19 7.11435 18.9999 6.17155 18.4142 5.58577C17.8284 4.99999 16.8856 4.99999 15 5L12 5.00001",
    round: true,
  },
  {
    d: "M5 12L5.00003 15C5.00004 16.8856 5.00005 17.8284 5.58584 18.4142C6.17163 19 7.11443 19 9.00004 19L12 19",
    round: true,
  },
]);

/** Collapse (`collapse`): return an expanded panel or card to its compact size. */
export const CollapseIcon = createHugeicon("CollapseIcon", [
  {
    d: "M13 4L13 7.00002C13 8.88563 13.0001 9.82843 13.5858 10.4142C14.1716 11 15.1144 11 17 11L20 11",
    round: true,
  },
  {
    d: "M11.0001 20L11 17C11 15.1144 11 14.1715 10.4142 13.5858C9.82843 13 8.88563 13 7.00002 13L4.00006 13",
    round: true,
  },
]);

/**
 * Merged pull request (`workflow-circle-06`): the PR-state glyph for "merged". Always a
 * small status glyph beside the heavier Central PR glyphs, so it defaults to their weight.
 */
export const WorkflowCircle06Icon = createHugeicon(
  "WorkflowCircle06Icon",
  [
    {
      d: "M9 5C9 6.65685 7.65685 8 6 8C4.34315 8 3 6.65685 3 5C3 3.34315 4.34315 2 6 2C7.65685 2 9 3.34315 9 5Z",
    },
    {
      d: "M21 14C21 15.6569 19.6569 17 18 17C16.3431 17 15 15.6569 15 14C15 12.3431 16.3431 11 18 11C19.6569 11 21 12.3431 21 14Z",
    },
    {
      d: "M9 19C9 20.6569 7.65685 22 6 22C4.34315 22 3 20.6569 3 19C3 17.3431 4.34315 16 6 16C7.65685 16 9 17.3431 9 19Z",
    },
    { d: "M6 8V16", round: true },
    { d: "M15 14H12C8.68629 14 6 11.3137 6 8", round: true },
  ],
  { strokeWidth: 1.75 },
);

/** Download (`download-01`): the rail's update button. */
export const Download01Icon = createHugeicon("Download01Icon", [
  {
    d: "M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002",
    round: true,
  },
  {
    d: "M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016",
    round: true,
  },
]);

/** Hand off (`arrow-data-transfer-horizontal`): move a thread to another provider or worktree. */
export const ArrowDataTransferHorizontalIcon = createHugeicon("ArrowDataTransferHorizontalIcon", [
  {
    d: "M19 9H6.65856C5.65277 9 5.14987 9 5.02472 8.69134C4.89957 8.38268 5.25517 8.01942 5.96637 7.29289L8.21091 5",
    round: true,
  },
  {
    d: "M5 15H17.3414C18.3472 15 18.8501 15 18.9753 15.3087C19.1004 15.6173 18.7448 15.9806 18.0336 16.7071L15.7891 19",
    round: true,
  },
]);

const CHECKBOX_SQUARE =
  "M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z";

/** Unchecked box of an inline toggle such as the composer's Worktree option (`square`). */
export const SquareIcon = createHugeicon("SquareIcon", [{ d: CHECKBOX_SQUARE }]);

/** Checked twin of SquareIcon (`checkmark-square-02`). */
export const CheckmarkSquare02Icon = createHugeicon("CheckmarkSquare02Icon", [
  { d: CHECKBOX_SQUARE },
  { d: "M8 12.5L10.5 15L16 9", round: true },
]);

const DASHBOARD_CIRCLE_PATHS: readonly HugeiconPath[] = [
  {
    d: "M21 6.75C21 4.67893 19.3211 3 17.25 3C15.1789 3 13.5 4.67893 13.5 6.75C13.5 8.82107 15.1789 10.5 17.25 10.5C19.3211 10.5 21 8.82107 21 6.75Z",
  },
  {
    d: "M10.5 6.75C10.5 4.67893 8.82107 3 6.75 3C4.67893 3 3 4.67893 3 6.75C3 8.82107 4.67893 10.5 6.75 10.5C8.82107 10.5 10.5 8.82107 10.5 6.75Z",
  },
  {
    d: "M21 17.25C21 15.1789 19.3211 13.5 17.25 13.5C15.1789 13.5 13.5 15.1789 13.5 17.25C13.5 19.3211 15.1789 21 17.25 21C19.3211 21 21 19.3211 21 17.25Z",
  },
  {
    d: "M10.5 17.25C10.5 15.1789 8.82107 13.5 6.75 13.5C4.67893 13.5 3 15.1789 3 17.25C3 19.3211 4.67893 21 6.75 21C8.82107 21 10.5 19.3211 10.5 17.25Z",
  },
];

/** Hub (`dashboard-circle`, four circles together): related work gathered in one place. */
export const DashboardCircleIcon = createHugeicon("DashboardCircleIcon", DASHBOARD_CIRCLE_PATHS);

/**
 * The hub circles painted solid: the rail's active state. The free Hugeicons set is
 * stroke-only, so this fills the outline glyph's own paths.
 */
export const DashboardCircleSolidIcon = createHugeicon(
  "DashboardCircleSolidIcon",
  DASHBOARD_CIRCLE_PATHS,
  { solid: true },
);

/** The one closed folder: projects, paths, and file-tree rows (`folder-closed`). */
export const FolderClosedIcon = createHugeicon("FolderClosedIcon", [
  {
    d: "M2 13C2.06427 12.3499 2.20951 11.9124 2.53777 11.5858C3.12654 11 4.07416 11 5.9694 11H18.0306C19.9258 11 20.8735 11 21.4622 11.5858C21.7905 11.9124 21.9357 12.3499 22 13",
    round: true,
  },
  {
    d: "M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7",
    roundCap: true,
  },
]);

/** The one open folder: an expanded project or directory, and "open in folder" actions (`folder-02`). */
export const Folder02Icon = createHugeicon("Folder02Icon", [
  {
    d: "M2 19V7.54902C2 6.10516 2 5.38322 2.24332 4.81647C2.5467 4.10985 3.10985 3.5467 3.81647 3.24332C4.38322 3 5.09805 3 6.54902 3H7.04311C7.64819 3 8.22075 3.27394 8.60041 3.74509L10.4175 6M10.4175 6H16C17.4001 6 18.1002 6 18.635 6.27248C19.1054 6.51217 19.4878 6.89462 19.7275 7.36502C20 7.8998 20 8.59987 20 10V11M10.4175 6H7",
    round: true,
  },
  {
    d: "M3.15802 15.5144L3.45643 14.7717C4.19029 12.9449 4.55723 12.0316 5.3224 11.5158C6.08757 11 7.07557 11 9.05157 11H17.1119C19.8004 11 21.1446 11 21.7422 11.8787C22.3397 12.7575 21.8405 14.0002 20.842 16.4856L20.5436 17.2283C19.8097 19.0551 19.4428 19.9684 18.6776 20.4842C17.9124 21 16.9244 21 14.9484 21H6.88812C4.19961 21 2.85535 21 2.25782 20.1213C1.66029 19.2425 2.15953 17.9998 3.15802 15.5144Z",
    roundJoin: true,
  },
]);

/** Stacked folders: the explorer / file tree and the Spaces rail item (`folder-library`). */
export const FolderLibraryIcon = createHugeicon("FolderLibraryIcon", [
  {
    d: "M16.2627 10.5H7.73725C5.15571 10.5 3.86494 10.5 3.27143 11.3526C2.67793 12.2052 3.11904 13.4258 4.00126 15.867L5.08545 18.867C5.54545 20.1398 5.77545 20.7763 6.2889 21.1381C6.80235 21.5 7.47538 21.5 8.82143 21.5H15.1786C16.5246 21.5 17.1976 21.5 17.7111 21.1381C18.2245 20.7763 18.4545 20.1398 18.9146 18.867L19.9987 15.867C20.881 13.4258 21.3221 12.2052 20.7286 11.3526C20.1351 10.5 18.8443 10.5 16.2627 10.5Z",
  },
  {
    d: "M19 8C19 7.53406 19 7.30109 18.9239 7.11732C18.8224 6.87229 18.6277 6.67761 18.3827 6.57612C18.1989 6.5 17.9659 6.5 17.5 6.5H6.5C6.03406 6.5 5.80109 6.5 5.61732 6.57612C5.37229 6.67761 5.17761 6.87229 5.07612 7.11732C5 7.30109 5 7.53406 5 8",
    round: true,
  },
  {
    d: "M16.5 4C16.5 3.53406 16.5 3.30109 16.4239 3.11732C16.3224 2.87229 16.1277 2.67761 15.8827 2.57612C15.6989 2.5 15.4659 2.5 15 2.5H9C8.53406 2.5 8.30109 2.5 8.11732 2.57612C7.87229 2.67761 7.67761 2.87229 7.57612 3.11732C7.5 3.30109 7.5 3.53406 7.5 4",
    round: true,
  },
]);

/** Add a folder or project: ⌘K "Add project" and the folder pickers (`folder-add`). */
export const FolderAddIcon = createHugeicon("FolderAddIcon", [
  {
    d: "M13 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C21.9796 9.05942 21.9992 10.0588 22 12",
    roundCap: true,
  },
  { d: "M18 13V21M22 17H14", round: true },
]);

/** Inbox: the sidebar nav entry and the rail's Inbox item (`inbox`). */
export const InboxIcon = createHugeicon("InboxIcon", [
  {
    d: "M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z",
    round: true,
  },
  {
    d: "M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5",
    roundJoin: true,
  },
]);

/** Home: the rail's Home item (`home-07`). */
export const Home07Icon = createHugeicon("Home07Icon", [
  {
    d: "M12.8924 2.80982L21.4876 9.59547C21.8112 9.85095 22 10.2405 22 10.6528C22 11.3969 21.3969 12 20.6528 12H20V15.5C20 18.3284 20 19.7426 19.1213 20.6213C18.2426 21.5 16.8284 21.5 14 21.5H10C7.17157 21.5 5.75736 21.5 4.87868 20.6213C4 19.7426 4 18.3284 4 15.5V12H3.34716C2.60315 12 2 11.3969 2 10.6528C2 10.2405 2.1888 9.85095 2.5124 9.59547L11.1076 2.80982C11.3617 2.60915 11.6761 2.5 12 2.5C12.3239 2.5 12.6383 2.60915 12.8924 2.80982Z",
    round: true,
  },
  {
    d: "M14.5 21.5V17C14.5 16.0654 14.5 15.5981 14.299 15.25C14.1674 15.022 13.978 14.8326 13.75 14.701C13.4019 14.5 12.9346 14.5 12 14.5C11.0654 14.5 10.5981 14.5 10.25 14.701C10.022 14.8326 9.83261 15.022 9.70096 15.25C9.5 15.5981 9.5 16.0654 9.5 17V21.5",
    round: true,
  },
]);

/** Code review: the sidebar entry, the project row's shortcut, and the rail item (`git-compare-arrows`). */
export const GitCompareArrowsIcon = createHugeicon("GitCompareArrowsIcon", [
  {
    d: "M5 9.00098C6.65685 9.00098 8 7.65783 8 6.00098C8 4.34412 6.65685 3.00098 5 3.00098C3.34315 3.00098 2 4.34412 2 6.00098C2 7.65783 3.34315 9.00098 5 9.00098Z",
    round: true,
  },
  {
    d: "M12 6.00146H14C15.8692 6.00146 16.8038 6.00146 17.5 6.40339C17.9561 6.66669 18.3348 7.04541 18.5981 7.50146C19 8.19762 19 9.13223 19 11.0015",
    round: true,
  },
  {
    d: "M19 21.001C20.6569 21.001 22 19.6578 22 18.001C22 16.3441 20.6569 15.001 19 15.001C17.3431 15.001 16 16.3441 16 18.001C16 19.6578 17.3431 21.001 19 21.001Z",
    round: true,
  },
  {
    d: "M12 18.002H10C8.13077 18.002 7.19615 18.002 6.5 17.6C6.04394 17.3367 5.66523 16.958 5.40192 16.502C5 15.8058 5 14.8712 5 13.002",
    round: true,
  },
  {
    d: "M9.00002 15.001C9.00002 15.001 12 17.2104 12 18.001C12 18.7916 9 21.001 9 21.001",
    round: true,
  },
  {
    d: "M15 9.00195C15 9.00195 12 6.79249 12 6.00193C12 5.21137 15 3.00195 15 3.00195",
    round: true,
  },
]);

/** Schedule: Automations everywhere they appear, plus snooze and scheduled sends (`clock-hour-7`). */
export const ClockHour7Icon = createHugeicon("ClockHour7Icon", [
  { d: "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z", round: true },
  { d: "M12 6V12L10 15.5", round: true },
]);

/** Tasks: the sidebar nav entry and the rail's Tasks item (`apple-reminder`). */
export const AppleReminderIcon = createHugeicon("AppleReminderIcon", [
  {
    d: "M3 12C3 7.75736 3 5.63604 4.31802 4.31802C5.63604 3 7.75736 3 12 3C16.2426 3 18.364 3 19.682 4.31802C21 5.63604 21 7.75736 21 12C21 16.2426 21 18.364 19.682 19.682C18.364 21 16.2426 21 12 21C7.75736 21 5.63604 21 4.31802 19.682C3 18.364 3 16.2426 3 12Z",
    round: true,
  },
  {
    d: "M7.37545 7.99976H7.25045M7.37482 11.9999H7.24982M7.37498 15.9999H7.24998M7.50045 7.99976C7.50045 8.13783 7.38852 8.24976 7.25045 8.24976C7.11238 8.24976 7.00045 8.13783 7.00045 7.99976C7.00045 7.86169 7.11238 7.74976 7.25045 7.74976C7.38852 7.74976 7.50045 7.86169 7.50045 7.99976ZM7.49982 11.9999C7.49982 12.138 7.38789 12.2499 7.24982 12.2499C7.11175 12.2499 6.99982 12.138 6.99982 11.9999C6.99982 11.8618 7.11175 11.7499 7.24982 11.7499C7.38789 11.7499 7.49982 11.8618 7.49982 11.9999ZM7.49998 15.9999C7.49998 16.138 7.38805 16.2499 7.24998 16.2499C7.11191 16.2499 6.99998 16.138 6.99998 15.9999C6.99998 15.8618 7.11191 15.7499 7.24998 15.7499C7.38805 15.7499 7.49998 15.8618 7.49998 15.9999Z",
    round: true,
  },
  { d: "M11 8H17M11 12H17M11 16H17", round: true },
]);

/** Worktree: where a thread runs in its own checkout, turned 90° right to read as a split to the right (`split`). */
export const SplitIcon = createHugeicon(
  "SplitIcon",
  [
    {
      d: "M21 8.5V6.6C21 4.90294 21 4.05442 20.4728 3.52721C19.9456 3 19.0971 3 17.4 3H15.5M20 4L14.5 9.5",
      round: true,
    },
    {
      d: "M3 8.5V6.6C3 4.90294 3 4.05442 3.52721 3.52721C4.05442 3 4.90294 3 6.6 3H8.5M4 4L9.65686 9.65686C10.813 10.813 11.391 11.391 11.6955 12.1261C12 12.8612 12 13.6787 12 15.3137V21",
      round: true,
    },
  ],
  { rotate: 90 },
);

/** Editor view: the in-app editor workspace row in the Environment panel (`source-code-square`). */
export const SourceCodeSquareIcon = createHugeicon("SourceCodeSquareIcon", [
  {
    d: "M16 10L17.2265 11.0572C17.7422 11.5016 18 11.7239 18 12C18 12.2761 17.7422 12.4984 17.2265 12.9428L16 14",
    round: true,
  },
  {
    d: "M8 10L6.77346 11.0572C6.25782 11.5016 6 11.7239 6 12C6 12.2761 6.25782 12.4984 6.77346 12.9428L8 14",
    round: true,
  },
  { d: "M13 9L11 15", round: true },
  {
    d: "M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z",
  },
]);

/** Computer use: the pointer an agent drives, mirrored so it leans left like a cursor (`navigation-03`). */
export const Navigation03Icon = createHugeicon(
  "Navigation03Icon",
  [
    {
      d: "M11.922 4.79004C16.6963 3.16245 19.0834 2.34866 20.3674 3.63261C21.6513 4.91656 20.8375 7.30371 19.21 12.078L18.1016 15.3292C16.8517 18.9958 16.2267 20.8291 15.1964 20.9808C14.9195 21.0216 14.6328 20.9971 14.3587 20.9091C13.3395 20.5819 12.8007 18.6489 11.7231 14.783C11.4841 13.9255 11.3646 13.4967 11.0924 13.1692C11.0134 13.0742 10.9258 12.9866 10.8308 12.9076C10.5033 12.6354 10.0745 12.5159 9.21705 12.2769C5.35111 11.1993 3.41814 10.6605 3.0909 9.64127C3.00292 9.36724 2.97837 9.08053 3.01916 8.80355C3.17088 7.77332 5.00419 7.14834 8.6708 5.89838L11.922 4.79004Z",
    },
  ],
  { mirror: true },
);

/** Terminal: panes, tabs, thread rows, command output, and the "Open in terminal" action (`square-terminal`). */
export const SquareTerminalIcon = createHugeicon("SquareTerminalIcon", [
  {
    d: "M7.49219 7.5L8.71873 8.55719C9.23437 9.00163 9.49219 9.22386 9.49219 9.5C9.49219 9.77614 9.23437 9.99836 8.71873 10.4428L7.49219 11.5",
    round: true,
  },
  { d: "M11.4922 12.5H15.4922", round: true },
  {
    d: "M11.9922 21C15.7419 21 17.6168 21 18.9311 20.0451C19.3556 19.7367 19.7289 19.3634 20.0373 18.9389C20.9922 17.6246 20.9922 15.7497 20.9922 12C20.9922 8.25027 20.9922 6.3754 20.0373 5.06107C19.7289 4.6366 19.3556 4.26331 18.9311 3.95491C17.6168 3 15.7419 3 11.9922 3C8.24246 3 6.36759 3 5.05326 3.95491C4.62879 4.26331 4.2555 4.6366 3.9471 5.06107C2.99219 6.3754 2.99219 8.25027 2.99219 12C2.99219 15.7497 2.99219 17.6246 3.9471 18.9389C4.2555 19.3634 4.62879 19.7367 5.05326 20.0451C6.36759 21 8.24246 21 11.9922 21Z",
    round: true,
  },
]);

/** Open outside the app: external links, Finder reveal, GitHub, and "Open PR in browser" (`link-square-02`). */
export const LinkSquare02Icon = createHugeicon("LinkSquare02Icon", [
  {
    d: "M11.0991 3.00012C7.45013 3.00669 5.53932 3.09629 4.31817 4.31764C3.00034 5.63568 3.00034 7.75704 3.00034 11.9997C3.00034 16.2424 3.00034 18.3638 4.31817 19.6818C5.63599 20.9999 7.75701 20.9999 11.9991 20.9999C16.241 20.9999 18.3621 20.9999 19.6799 19.6818C20.901 18.4605 20.9906 16.5493 20.9972 12.8998",
    round: true,
  },
  {
    d: "M20.556 3.49612L11.0487 13.0586M20.556 3.49612C20.062 3.00151 16.7343 3.04761 16.0308 3.05762M20.556 3.49612C21.05 3.99074 21.0039 7.32273 20.9939 8.02714",
    round: true,
  },
]);

/** Side chats: the dock pane, its launcher, and the ⌘K "new chat" action (a chat bubble with a plus). */
export const SidechatIcon = createHugeicon("SidechatIcon", [
  {
    d: "M12 20.75C17.1086 20.75 21.25 16.8325 21.25 12C21.25 7.16751 17.1086 3.25 12 3.25C6.89137 3.25 2.75 7.16751 2.75 12C2.75 13.67 3.2446 15.2308 4.10279 16.5583C4.42077 17.0502 4.58903 17.6394 4.44147 18.2062C4.26303 18.8917 4.03461 19.5654 3.77778 20.2353C4.78011 20.1734 5.73649 20.0366 6.66503 19.8213C7.17064 19.7041 7.70044 19.7652 8.17727 19.9702C9.34243 20.471 10.6368 20.75 12 20.75Z",
    roundJoin: true,
  },
  { d: "M12 8.75V15.25M8.75 12H15.25", roundCap: true },
]);

/** Full changelog and the gift picker option (`gift`). */
export const GiftIcon = createHugeicon("GiftIcon", [
  {
    d: "M4 11V15C4 18.2998 4 19.9497 5.02513 20.9749C6.05025 22 7.70017 22 11 22H13C16.2998 22 17.9497 22 18.9749 20.9749C20 19.9497 20 18.2998 20 15V11",
    round: true,
  },
  {
    d: "M3 9C3 8.25231 3 7.87846 3.20096 7.6C3.33261 7.41758 3.52197 7.26609 3.75 7.16077C4.09808 7 4.56538 7 5.5 7H18.5C19.4346 7 19.9019 7 20.25 7.16077C20.478 7.26609 20.6674 7.41758 20.799 7.6C21 7.87846 21 8.25231 21 9C21 9.74769 21 10.1215 20.799 10.4C20.6674 10.5824 20.478 10.7339 20.25 10.8392C19.9019 11 19.4346 11 18.5 11H5.5C4.56538 11 4.09808 11 3.75 10.8392C3.52197 10.7339 3.33261 10.5824 3.20096 10.4C3 10.1215 3 9.74769 3 9Z",
    roundJoin: true,
  },
  {
    d: "M6 3.78571C6 2.79949 6.79949 2 7.78571 2H8.14286C10.2731 2 12 3.7269 12 5.85714V7H9.21429C7.43908 7 6 5.56091 6 3.78571Z",
    roundJoin: true,
  },
  {
    d: "M18 3.78571C18 2.79949 17.2005 2 16.2143 2H15.8571C13.7269 2 12 3.7269 12 5.85714V7H14.7857C16.5609 7 18 5.56091 18 3.78571Z",
    roundJoin: true,
  },
  { d: "M12 11L12 22", round: true },
]);

/** Send feedback: the Help menu row (`message-edit-01`). */
export const MessageEdit01Icon = createHugeicon("MessageEdit01Icon", [
  {
    d: "M21.9165 10.5001C21.9351 10.6557 21.9495 10.8127 21.9598 10.9708C22.0134 11.801 22.0134 12.6608 21.9598 13.491C21.6856 17.7333 18.3536 21.1126 14.1706 21.3906C12.7435 21.4855 11.2536 21.4853 9.8294 21.3906C9.33896 21.358 8.8044 21.241 8.34401 21.0514C7.83177 20.8404 7.5756 20.7349 7.44544 20.7509C7.31527 20.7669 7.1264 20.9062 6.74868 21.1847C6.08268 21.6758 5.24367 22.0286 3.99943 21.9983C3.37026 21.983 3.05568 21.9753 2.91484 21.7352C2.77401 21.4951 2.94941 21.1627 3.30021 20.4979C3.78674 19.5759 4.09501 18.5204 3.62791 17.6747C2.82343 16.4667 2.1401 15.0361 2.04024 13.491C1.98659 12.6608 1.98659 11.801 2.04024 10.9708C2.31441 6.7285 5.64639 3.34925 9.8294 3.07119C11.0318 2.99126 12.2812 2.97868 13.5 3.0338",
    round: true,
  },
  { d: "M8.5 15.0001H15.5M8.5 10.0001H11", round: true },
  {
    d: "M20.8684 2.43946L21.5607 3.13183C22.1465 3.71761 22.1465 4.66736 21.5607 5.25315L17.9333 8.94881C17.648 9.23416 17.283 9.42652 16.8863 9.50061L14.6381 9.98865C14.2832 10.0657 13.9671 9.75054 14.0431 9.39537L14.5217 7.16005C14.5958 6.76336 14.7881 6.39836 15.0735 6.11301L18.747 2.43946C19.3328 1.85368 20.2826 1.85368 20.8684 2.43946Z",
    round: true,
  },
]);

/** Docs: the Help menu row and the book picker option (`book-open-01`). */
export const BookOpen01Icon = createHugeicon("BookOpen01Icon", [
  {
    d: "M7.99978 3.5H6.60021C4.43183 3.5 3.34764 3.5 2.67399 4.17362C2.00034 4.84724 2.00029 5.93144 2.00021 8.09982L2 13.3998C1.99992 15.5684 1.99987 16.6526 2.67353 17.3263C3.34719 18 4.43146 18 6.6 18H8.95042C10.4329 18 11.7092 19.0464 11.9999 20.5V5.5C11.0556 4.24097 9.99989 3.5 7.99978 3.5Z",
    round: true,
  },
  {
    d: "M16.0001 3.5H17.3997C19.5681 3.5 20.6523 3.5 21.3259 4.17362C21.9996 4.84724 21.9996 5.93144 21.9997 8.09982L21.9999 13.3998C22 15.5684 22 16.6526 21.3264 17.3263C20.6527 18 19.5684 18 17.3999 18H15.0495C13.567 18 12.2907 19.0464 12 20.5V5.5C12.9443 4.24097 14 3.5 16.0001 3.5Z",
    round: true,
  },
]);

/** Customize this surface: Customize sidebar (`sliders-horizontal`). */
export const SlidersHorizontalIcon = createHugeicon("SlidersHorizontalIcon", [
  { d: "M3.99963 5.00055L9.99963 5.00031", roundCap: true },
  { d: "M12.9996 5.00031L19.9996 5.00031", roundCap: true },
  { d: "M15.9996 9.00031L15.9996 15.0003", roundCap: true },
  { d: "M9.99963 2.00031L9.99963 8.00031", roundCap: true },
  { d: "M11.9996 16.0003L11.9996 22.0003", roundCap: true },
  { d: "M15.9996 12.0001L19.9996 12.0003", roundCap: true },
  { d: "M3.99963 12.0005L12.9996 12.0003", roundCap: true },
  { d: "M11.9996 19.0003L19.9996 19.0003", roundCap: true },
  { d: "M3.99963 19.0005L8.99963 19.0003", roundCap: true },
]);

/** Merge conflicts: the PR conflict state, the PR context card, and the Environment panel row (`git-merge-conflict`). */
export const GitMergeConflictIcon = createHugeicon("GitMergeConflictIcon", [
  {
    d: "M12 6H13C14.8692 6 15.8038 6 16.5 6.40192C16.9561 6.66523 17.3348 7.04394 17.5981 7.5C18 8.19615 18 9.13077 18 11",
    round: true,
  },
  { d: "M6 12V21", round: true },
  { d: "M9 3L3 9", round: true },
  { d: "M9 9L3 3", round: true },
  {
    d: "M18 21C19.6569 21 21 19.6569 21 18C21 16.3431 19.6569 15 18 15C16.3431 15 15 16.3431 15 18C15 19.6569 16.3431 21 18 21Z",
    round: true,
  },
]);

/** Pull request: the classic open-PR glyph, the PR state set, and the "View PR" action (`git-pull-request-arrow`). */
export const GitPullRequestArrowIcon = createHugeicon("GitPullRequestArrowIcon", [
  {
    d: "M5 9C6.65685 9 8 7.65685 8 6C8 4.34315 6.65685 3 5 3C3.34315 3 2 4.34315 2 6C2 7.65685 3.34315 9 5 9Z",
    round: true,
  },
  { d: "M5 13V21", round: true },
  {
    d: "M19 21C20.6569 21 22 19.6569 22 18C22 16.3431 20.6569 15 19 15C17.3431 15 16 16.3431 16 18C16 19.6569 17.3431 21 19 21Z",
    round: true,
  },
  {
    d: "M12 6H14C15.8692 6 16.8038 6 17.5 6.40192C17.9561 6.66523 18.3348 7.04394 18.5981 7.5C19 8.19615 19 9.13077 19 11M15 3C15 3 12 5.20944 12 6C12 6.79056 15 9 15 9",
    round: true,
  },
]);

/** Create a pull request: the Create PR buttons and menu rows (`git-pull-request-create-arrow`). */
export const GitPullRequestCreateArrowIcon = createHugeicon("GitPullRequestCreateArrowIcon", [
  {
    d: "M5 9C6.65685 9 8 7.65685 8 6C8 4.34315 6.65685 3 5 3C3.34315 3 2 4.34315 2 6C2 7.65685 3.34315 9 5 9Z",
    round: true,
  },
  { d: "M5 13V21", round: true },
  {
    d: "M12 6H14C15.8692 6 16.8038 6 17.5 6.40192C17.9561 6.66523 18.3348 7.04394 18.5981 7.5C19 8.19615 19 9.13077 19 11M15 3C15 3 12 5.20944 12 6C12 6.79056 15 9 15 9",
    round: true,
  },
  { d: "M19 15V21M22 18H16", round: true },
]);

/** Branch: the branch pickers, thread rows, and every branch/fork marker (`workflow-circle-05`). */
export const WorkflowCircle05Icon = createHugeicon("WorkflowCircle05Icon", [
  {
    d: "M9 5C9 6.65685 7.65685 8 6 8C4.34315 8 3 6.65685 3 5C3 3.34315 4.34315 2 6 2C7.65685 2 9 3.34315 9 5Z",
  },
  {
    d: "M21 5C21 6.65685 19.6569 8 18 8C16.3431 8 15 6.65685 15 5C15 3.34315 16.3431 2 18 2C19.6569 2 21 3.34315 21 5Z",
  },
  {
    d: "M9 19C9 20.6569 7.65685 22 6 22C4.34315 22 3 20.6569 3 19C3 17.3431 4.34315 16 6 16C7.65685 16 9 17.3431 9 19Z",
  },
  { d: "M6 8V16", round: true },
  {
    d: "M6 12H14C15.4001 12 16.1002 12 16.635 11.7275C17.1054 11.4878 17.4878 11.1054 17.7275 10.635C18 10.1002 18 9.40013 18 8",
    round: true,
  },
]);

/** Draft pull request, from the same family as the open glyph (`git-pull-request-draft`). */
export const GitPullRequestDraftIcon = createHugeicon("GitPullRequestDraftIcon", [
  { d: "M6 8L6 16", round: true },
  { d: "M4 18A2 2 0 1 0 8 18A2 2 0 1 0 4 18Z" },
  { d: "M4 6A2 2 0 1 0 8 6A2 2 0 1 0 4 6Z" },
  { d: "M16 18A2 2 0 1 0 20 18A2 2 0 1 0 16 18Z" },
  {
    d: "M18.125 11H18M18.25 11C18.25 11.1381 18.1381 11.25 18 11.25C17.8619 11.25 17.75 11.1381 17.75 11C17.75 10.8619 17.8619 10.75 18 10.75C18.1381 10.75 18.25 10.8619 18.25 11Z",
    roundCap: true,
  },
  {
    d: "M18.125 6H18M18.25 6C18.25 6.13807 18.1381 6.25 18 6.25C17.8619 6.25 17.75 6.13807 17.75 6C17.75 5.86193 17.8619 5.75 18 5.75C18.1381 5.75 18.25 5.86193 18.25 6Z",
    roundCap: true,
  },
]);

/** Closed pull request, from the same family as the open glyph (`git-pull-request-closed`). */
export const GitPullRequestClosedIcon = createHugeicon("GitPullRequestClosedIcon", [
  { d: "M6 8L6 16", round: true },
  { d: "M18 11L18 16", round: true },
  { d: "M4 18A2 2 0 1 0 8 18A2 2 0 1 0 4 18Z" },
  { d: "M4 6A2 2 0 1 0 8 6A2 2 0 1 0 4 6Z" },
  { d: "M16 18A2 2 0 1 0 20 18A2 2 0 1 0 16 18Z" },
  { d: "M20 4L18 6M18 6L16 8M18 6L20 8M18 6L16 4", round: true },
]);

/** TODO: Saved logins: the browser vault key (`key-01`). */
export const Key01Icon = createHugeicon("Key01Icon", [
  {
    d: "M15.5 14.5C18.8137 14.5 21.5 11.8137 21.5 8.5C21.5 5.18629 18.8137 2.5 15.5 2.5C12.1863 2.5 9.5 5.18629 9.5 8.5C9.5 9.38041 9.68962 10.2165 10.0303 10.9697L2.5 18.5V21.5H5.5V19.5H7.5V17.5H9.5L13.0303 13.9697C13.7835 14.3104 14.6196 14.5 15.5 14.5Z",
    round: true,
  },
  { d: "M17.5 6.5L16.5 7.5", round: true },
]);

/** TODO: Camera: copy a browser screenshot (`camera-01`). */
export const Camera01Icon = createHugeicon("Camera01Icon", [
  {
    d: "M12.6974 3.5H11.303C10.5884 3.5 10.2311 3.5 9.91067 3.612C9.71499 3.68039 9.53113 3.77879 9.36568 3.90367C9.09474 4.10816 8.89655 4.40544 8.50018 5L8.50017 5.00001C8.29717 5.30453 7.99794 5.75337 7.87867 5.87871C7.58314 6.18927 7.19563 6.39666 6.77329 6.47029C6.60284 6.5 6.41985 6.5 6.05387 6.5C5.07379 6.5 4.58376 6.5 4.18307 6.61342C3.18074 6.89716 2.39734 7.68055 2.1136 8.68289C2.00018 9.08357 2.00018 9.57361 2.00018 10.5537V14.5C2.00018 17.3284 2.00018 18.7426 2.87886 19.6213C3.75754 20.5 5.17176 20.5 8.00018 20.5H16.0002C18.8286 20.5 20.2428 20.5 21.1215 19.6213C22.0002 18.7426 22.0002 17.3284 22.0002 14.5V10.5537C22.0002 9.57361 22.0002 9.08357 21.8868 8.68289C21.603 7.68055 20.8196 6.89716 19.8173 6.61342C19.4166 6.5 18.9266 6.5 17.9465 6.5C17.5805 6.5 17.3975 6.5 17.2271 6.47029C16.8047 6.39666 16.4172 6.18927 16.1217 5.87871C16.0024 5.75336 15.7032 5.30451 15.5002 5C15.1038 4.40544 14.9056 4.10816 14.6347 3.90367C14.4692 3.77879 14.2854 3.68039 14.0897 3.612C13.7693 3.5 13.412 3.5 12.6974 3.5Z",
    round: true,
  },
  {
    d: "M16.0002 13C16.0002 15.2091 14.2093 17 12.0002 17C9.79104 17 8.00018 15.2091 8.00018 13C8.00018 10.7909 9.79104 9 12.0002 9C14.2093 9 16.0002 10.7909 16.0002 13Z",
    round: true,
  },
  {
    d: "M19.1252 9.5H19.0002M19.2502 9.5C19.2502 9.63807 19.1383 9.75 19.0002 9.75C18.8621 9.75 18.7502 9.63807 18.7502 9.5C18.7502 9.36193 18.8621 9.25 19.0002 9.25C19.1383 9.25 19.2502 9.36193 19.2502 9.5Z",
    roundCap: true,
  },
]);

/** TODO: Three dots: the browser actions menu (`more-horizontal`). */
export const MoreHorizontalIcon = createHugeicon("MoreHorizontalIcon", [
  {
    d: "M6.00449 12.5V12M18.0045 12.5V12M12.0045 12.5V12M7.00449 12.5C7.00449 11.9477 6.55677 11.5 6.00449 11.5C5.4522 11.5 5.00449 11.9477 5.00449 12.5C5.00449 13.0523 5.4522 13.5 6.00449 13.5C6.55677 13.5 7.00449 13.0523 7.00449 12.5ZM19.0045 12.5C19.0045 11.9477 18.5568 11.5 18.0045 11.5C17.4522 11.5 17.0045 11.9477 17.0045 12.5C17.0045 13.0523 17.4522 13.5 18.0045 13.5C18.5568 13.5 19.0045 13.0523 19.0045 12.5ZM13.0045 12.5C13.0045 11.9477 12.5568 11.5 12.0045 11.5C11.4522 11.5 11.0045 11.9477 11.0045 12.5C11.0045 13.0523 11.4522 13.5 12.0045 13.5C12.5568 13.5 13.0045 13.0523 13.0045 12.5Z",
    round: true,
  },
]);

/** Steer: send a queued follow-up into the running turn (`corner-down-right`). */
export const CornerDownRightIcon = createHugeicon("CornerDownRightIcon", [
  { d: "M19 15H12C8.22876 15 6.34315 15 5.17157 13.8284C4 12.6569 4 10.7712 4 7V4", round: true },
  { d: "M15 20C15 20 20 16.3176 20 15C20 13.6824 15 10 15 10", round: true },
]);

/** Transcript thinking indicator (`ai-brain-01`). */
export const AiBrain01Icon = createHugeicon("AiBrain01Icon", [
  {
    d: "M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707",
    round: true,
  },
  {
    d: "M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292",
    round: true,
  },
]);

/** Live transcript work duration. */
export const HammerIcon = createHugeicon("HammerIcon", [
  {
    d: "M12 8.5L3.12132 17.3787C2.72349 17.7765 2.5 18.3161 2.5 18.8787C2.5 20.0503 3.44975 21 4.62132 21C5.18393 21 5.72349 20.7765 6.12132 20.3787L15 11.5",
    round: true,
  },
  {
    d: "M16.1207 5.03693L20.3682 9.3197C21.014 9.97093 21.3369 10.2966 21.4435 10.6774C21.5188 10.9467 21.5188 11.2317 21.4435 11.501C21.3369 11.8819 21.014 12.2075 20.3682 12.8587C19.7223 13.51 19.3994 13.8356 19.0216 13.943C18.7546 14.019 18.4719 14.019 18.2048 13.943C17.8271 13.8356 17.5042 13.51 16.8583 12.8587L10.0245 5.96802C8.99015 4.92507 8.47297 4.40359 8.50109 3.94831C8.51495 3.7239 8.60259 3.51054 8.75017 3.34197C9.04956 3 9.78095 3 11.2437 3C12.4209 3 13.0095 3 13.5574 3.16035C13.8406 3.24325 14.1139 3.3574 14.3723 3.50071C14.8721 3.77792 15.2883 4.19759 16.1207 5.03693Z",
  },
]);

/** Transcript loading indicator. */
export const Loading03Icon = createHugeicon("Loading03Icon", [
  { d: "M12 3V6", roundCap: true },
  { d: "M12 18V21", roundCap: true },
  { d: "M21 12L18 12", roundCap: true },
  { d: "M6 12L3 12", roundCap: true },
  { d: "M18.3635 5.63672L16.2422 7.75804", roundCap: true },
  { d: "M7.75804 16.2422L5.63672 18.3635", roundCap: true },
  { d: "M18.3635 18.3635L16.2422 16.2422", roundCap: true },
  { d: "M7.75804 7.75804L5.63672 5.63672", roundCap: true },
]);

/** Message delivery verification indicator. */
export const MessageSearch01Icon = createHugeicon("MessageSearch01Icon", [
  {
    d: "M12 3.00366C11.4383 3.01203 10.3789 3.03449 9.8294 3.07102C5.64639 3.34908 2.31441 6.72832 2.04024 10.9707C1.98659 11.8009 1.98659 12.6606 2.04024 13.4908C2.1401 15.0359 2.82343 16.4665 3.62791 17.6746C4.09501 18.5203 3.78674 19.5758 3.30021 20.4978C2.94941 21.1625 2.77401 21.4949 2.91484 21.735C3.05568 21.9752 3.37026 21.9828 3.99943 21.9981C5.24367 22.0284 6.08268 21.6757 6.74868 21.1846C7.1264 20.906 7.31527 20.7668 7.44544 20.7508C7.5756 20.7347 7.83177 20.8403 8.34401 21.0512C8.8044 21.2408 9.33896 21.3579 9.8294 21.3905C11.2536 21.4851 12.7435 21.4853 14.1706 21.3905C18.3536 21.1124 21.6856 17.7332 21.9598 13.4908C21.9915 13.0001 22.0044 12.4991 21.9987 11.9999",
    round: true,
  },
  { d: "M8.5 15H15.5M8.5 10H12", round: true },
  {
    d: "M20.2649 7.27042L22 9M21.1714 5.08571C21.1714 3.38152 19.7899 2 18.0857 2C16.3815 2 15 3.38152 15 5.08571C15 6.78991 16.3815 8.17143 18.0857 8.17143C19.7899 8.17143 21.1714 6.78991 21.1714 5.08571Z",
    round: true,
  },
]);
