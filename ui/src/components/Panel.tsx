/**
 * The shared card shell used by every monitor panel: title, an empty-state
 * line while there's nothing to show, and optionally the scroll-box wrapper
 * once content can grow.
 */

import type { ReactNode } from "react";

export function Panel({
  title,
  empty,
  isEmpty,
  scrollable = false,
  children,
}: {
  title: string;
  /** Shown while isEmpty. */
  empty: string;
  isEmpty: boolean;
  /** Wrap content in the shared scroll-box (tables/feeds that grow). */
  scrollable?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {isEmpty ? (
        <p className="empty">{empty}</p>
      ) : scrollable ? (
        <div className="scroll-box">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}
