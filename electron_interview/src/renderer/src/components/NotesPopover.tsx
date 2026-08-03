interface NotesPopoverProps {
  open: boolean;
  title: string;
  content: string;
  onClose: () => void;
}

export function NotesPopover({
  open,
  title,
  content,
  onClose,
}: NotesPopoverProps): JSX.Element {
  if (!open) return <></>;

  return (
    <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md rounded-lg overflow-hidden flex flex-col border border-white/10">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-emerald-300 uppercase tracking-wide">
          {title || "Project"} — Notes
        </span>
        <button onClick={onClose} className="titlebar-button">
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {content ? (
          <pre className="whitespace-pre-wrap font-mono text-xs text-gray-100 leading-relaxed">
            {content}
          </pre>
        ) : (
          <p className="text-xs text-gray-400 text-center py-8">
            Select a project in My Projects to view its notes.
          </p>
        )}
      </div>
    </div>
  );
}
