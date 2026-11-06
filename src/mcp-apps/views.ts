export const appViews = ["day", "activity", "workout"] as const;

export type AppView = (typeof appViews)[number];

export function isAppView(value: string | undefined): value is AppView {
  return appViews.some((view) => view === value);
}
