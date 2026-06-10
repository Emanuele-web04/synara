// Purpose: Public surface for the shadcn sidebar primitive. Re-exports the components
//   split across the cohesive ui/sidebar.* sibling modules so import paths stay stable.
// Layer: ui primitive (shadcn sidebar) barrel.
// Exports: the complete sidebar component + hook + type surface (see below).
export { SidebarInstanceProvider, SidebarProvider, useSidebar } from "~/components/ui/sidebar.context";
export type { SidebarResizableOptions } from "~/components/ui/sidebar.context";
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarSeparator,
} from "~/components/ui/sidebar.layout";
export { SidebarHeaderTrigger, SidebarTrigger } from "~/components/ui/sidebar.trigger";
export { SidebarRail } from "~/components/ui/sidebar.rail";
export {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "~/components/ui/sidebar.group";
export {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "~/components/ui/sidebar.menu";
