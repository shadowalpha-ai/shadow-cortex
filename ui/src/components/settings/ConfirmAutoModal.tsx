/** Explicit consent before saving a profile that turns on autonomous execution. */

import { Modal } from "../Modal";

export function ConfirmAutoModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="Turn on automatic execution?"
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="reject" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="confirm" onClick={onConfirm}>
            I understand — save with auto execution
          </button>
        </>
      }
    >
        <p>
          With <code>execution: auto</code> the engine places orders on its own — without
          asking you first — for any proposal that passes your in-force caps. It still
          cannot exceed a cap you set, and exits always run.
        </p>
        <p>This takes effect on the next engine restart, not immediately.</p>
    </Modal>
  );
}
