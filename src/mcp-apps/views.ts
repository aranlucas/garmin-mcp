/** Views shared by the Worker's ui:// resources and the browser bundle. */
export const appViews = ["day", "activity", "workout"] as const;

export type AppView = (typeof appViews)[number];

export function isAppView(value: string | undefined): value is AppView {
  return appViews.some((view) => view === value);
}
