// FILE: taskListStyles.ts
// Purpose: Layout class tokens the task list's rows share so section headers and the quick-add
//          line sit on the same grid as the rows they introduce.
// Layer: Tasks UI style tokens
// Exports: TASK_LIST_INSET_CLASS

/**
 * Left edge of a task row's status circle: the row's px-5, its 1.25rem priority button, and one
 * gap-2.5. Section headers and the quick-add line start here, over the status circles.
 */
export const TASK_LIST_INSET_CLASS = "pl-[3.125rem]";
