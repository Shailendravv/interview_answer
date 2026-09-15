import { useState } from "react";
import type {
  InterviewScript,
  InterviewScriptCard,
} from "../../../shared/interviewScript";

interface ProjectScriptPanelProps {
  open: boolean;
  title: string;
  script: InterviewScript | null;
  /** Raw prompt block sent to the LLM — kept behind a disclosure for debugging. */
  notes: string;
  onClose: () => void;
}

// Open by default: the two you actually speak from first.
const INITIALLY_EXPANDED = ["how", "what"];

function Chip({ children }: { children: string }): JSX.Element {
  return (
    <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-[11px] text-gray-200">
      {children}
    </span>
  );
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <span
      className={`inline-block text-[9px] text-gray-500 transition-transform ${
        open ? "rotate-90" : ""
      }`}
    >
      ▶
    </span>
  );
}

interface CardProps {
  card: InterviewScriptCard;
  expanded: boolean;
  showAll: boolean;
  onToggle: () => void;
  onShowAll: () => void;
}

function Card({
  card,
  expanded,
  showAll,
  onToggle,
  onShowAll,
}: CardProps): JSX.Element {
  const visible = showAll ? card.lines : card.lines.slice(0, card.previewCount);
  const hidden = card.lines.length - visible.length;
  const ListTag = card.numbered ? "ol" : "ul";

  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left"
      >
        <Chevron open={expanded} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
          {card.label}
        </span>
        {card.timing && (
          <span className="ml-auto text-[10px] text-gray-500">
            {card.timing}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <ListTag
            className={`space-y-1.5 text-xs text-gray-200 leading-relaxed ${
              card.numbered
                ? "list-decimal list-outside pl-4"
                : "list-disc list-outside pl-4"
            }`}
          >
            {visible.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ListTag>
          {hidden > 0 && !showAll && (
            <button
              onClick={onShowAll}
              className="mt-2 text-[11px] text-emerald-400 hover:text-emerald-300"
            >
              Show all {card.lines.length} ▾
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectScriptPanel({
  open,
  title,
  script,
  notes,
  onClose,
}: ProjectScriptPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState<string[]>(INITIALLY_EXPANDED);
  const [showAll, setShowAll] = useState<string[]>([]);
  const [rawOpen, setRawOpen] = useState(false);

  if (!open) return <></>;

  const toggle = (id: string): void =>
    setExpanded((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );

  return (
    <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md rounded-lg overflow-hidden flex flex-col border border-white/10">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 shrink-0">
        <span className="text-xs font-semibold text-emerald-300 uppercase tracking-wide">
          {title || "Project"} — How to explain
        </span>
        <button onClick={onClose} className="titlebar-button">
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {script ? (
          <>
            {/* Opening: always visible, no chevron — it is what you say first. */}
            <div className="px-3 py-3 border-b border-white/10">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                  Opening
                </span>
                <span className="ml-auto text-[10px] text-gray-500">~30s</span>
              </div>
              <p className="text-xs text-gray-100 leading-relaxed">
                {script.pitch}
              </p>
              {(script.role || script.duration) && (
                <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-2">
                  {script.role && <span>Role: {script.role}</span>}
                  {script.duration && <span>Duration: {script.duration}</span>}
                </div>
              )}
              {script.techStack.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {script.techStack.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
              )}
            </div>

            {script.cards.map((card) => (
              <Card
                key={card.id}
                card={card}
                expanded={expanded.includes(card.id)}
                showAll={showAll.includes(card.id)}
                onToggle={() => toggle(card.id)}
                onShowAll={() => setShowAll((ids) => [...ids, card.id])}
              />
            ))}

            {notes && (
              <div className="border-t border-white/10">
                <button
                  onClick={() => setRawOpen((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left"
                >
                  <Chevron open={rawOpen} />
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">
                    Raw context sent to the LLM
                  </span>
                </button>
                {rawOpen && (
                  <pre className="whitespace-pre-wrap font-mono text-[11px] text-gray-400 leading-relaxed px-3 pb-3">
                    {notes}
                  </pre>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-400 text-center py-8 px-3">
            Select a project in My Projects to see how to explain it.
          </p>
        )}
      </div>
    </div>
  );
}
