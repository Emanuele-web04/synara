import type { ItemInstance, TreeInstance } from "@headless-tree/core";
import {
  createContext,
  Fragment,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useContext,
} from "react";

import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

type ToggleIconType = "chevron" | "none";

interface TreeContextValue<T> {
  indent: number;
  currentItem?: ItemInstance<T>;
  tree?: TreeInstance<T>;
  toggleIconType: ToggleIconType;
}

const TreeContext = createContext<TreeContextValue<unknown>>({
  indent: 20,
  toggleIconType: "chevron",
});

function useTreeContext<T>(): TreeContextValue<T> {
  return useContext(TreeContext) as TreeContextValue<T>;
}

export function Tree<T>(props: {
  indent?: number;
  tree: TreeInstance<T>;
  toggleIconType?: ToggleIconType;
  className?: string;
  children: ReactNode;
}) {
  const indent = props.indent ?? 20;
  const containerProps = props.tree.getContainerProps();
  return (
    <TreeContext.Provider
      value={{
        indent,
        tree: props.tree as TreeInstance<unknown>,
        toggleIconType: props.toggleIconType ?? "chevron",
      }}
    >
      <div
        {...containerProps}
        style={
          {
            ...containerProps.style,
            "--tree-indent": `${indent}px`,
          } as CSSProperties
        }
        className={cn("flex flex-col", props.className)}
      >
        {props.children}
      </div>
    </TreeContext.Provider>
  );
}

export function TreeItem<T>(
  props: {
    item: ItemInstance<T>;
    className?: string;
    children: ReactNode;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">,
) {
  const { item, className, children, onClick, ...buttonProps } = props;
  const parentContext = useTreeContext<T>();
  const itemProps = item.getProps();
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      itemProps.onClick?.(event);
    }
  };
  const isSelected = typeof item.isSelected === "function" && item.isSelected();
  return (
    <TreeContext.Provider
      value={{
        ...parentContext,
        currentItem: item,
      }}
    >
      <button
        {...itemProps}
        {...buttonProps}
        onClick={handleClick}
        style={
          {
            ...itemProps.style,
            ...buttonProps.style,
            "--tree-padding": `${item.getItemMeta().level * parentContext.indent}px`,
          } as CSSProperties
        }
        className={cn(
          "z-10 ps-(--tree-padding) outline-none select-none focus:z-20 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className,
        )}
        data-focus={item.isFocused() || undefined}
        data-folder={item.isFolder() || undefined}
        data-selected={isSelected || undefined}
        aria-expanded={item.isFolder() ? item.isExpanded() : undefined}
      >
        {children}
      </button>
    </TreeContext.Provider>
  );
}

export function TreeItemLabel<T>(props: {
  item?: ItemInstance<T>;
  className?: string;
  children?: ReactNode;
}) {
  const { currentItem, toggleIconType } = useTreeContext<T>();
  const item = props.item ?? currentItem;
  if (!item) return null;

  return (
    <span
      data-slot="tree-item-label"
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
        "in-focus-visible:ring-2 in-focus-visible:ring-ring",
        "in-data-[selected=true]:bg-muted/55 in-data-[selected=true]:text-foreground",
        "hover:bg-muted/35",
        props.className,
      )}
    >
      <Fragment>
        {item.isFolder() && toggleIconType === "chevron" ? (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
              !item.isExpanded() && "-rotate-90",
            )}
            aria-hidden="true"
          />
        ) : null}
        {props.children ?? item.getItemName()}
      </Fragment>
    </span>
  );
}

export function TreeDragLine(props: HTMLAttributes<HTMLDivElement>) {
  const { tree } = useTreeContext<unknown>();
  if (!tree || typeof tree.getDragLineStyle !== "function") return null;

  return (
    <div
      {...props}
      style={tree.getDragLineStyle()}
      className={cn(
        "absolute z-30 -mt-px h-0.5 w-[unset] bg-primary before:absolute before:-top-[3px] before:left-0 before:size-2 before:rounded-full before:border-2 before:border-primary before:bg-background",
        props.className,
      )}
    />
  );
}
