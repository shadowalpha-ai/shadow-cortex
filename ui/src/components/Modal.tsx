/**
 * The shared modal shell: backdrop that closes on click, a panel that stops
 * propagation, a title, body content, and an actions row. Callers own the
 * action buttons (labels/disabled states differ per dialog).
 */

import type { ReactNode } from "react";

export function Modal({
  title,
  onClose,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
