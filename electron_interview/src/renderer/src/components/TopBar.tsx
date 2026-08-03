import type { ReactNode } from "react";

interface IconButtonProps {
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: ReactNode;
}

function IconButton({ onClick, active, danger, children }: IconButtonProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`titlebar-button ${
        active ? "bg-emerald-500/30 text-emerald-200" : ""
      } ${danger ? "close" : ""}`}
    >
      {children}
    </button>
  );
}

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

interface TopBarProps {
  view: "chat" | "projects";
  onToggleProjects: () => void;
  notesOpen: boolean;
  onToggleNotes: () => void;
  isAlwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
}

export function TopBar(props: TopBarProps): JSX.Element {
  return (
    <div className="topbar flex items-center justify-end pl-1.5 pr-0.5 h-8 shrink-0 mb-1">
      <div className="no-drag flex items-center gap-0.5">
        <IconButton
          onClick={props.onToggleNotes}
          active={props.notesOpen && props.view === "chat"}
        >
          <Svg>
            <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
            <path d="M14 2v4h4" />
          </Svg>
        </IconButton>
        <IconButton
          onClick={props.onToggleProjects}
          active={props.view === "projects"}
        >
          <Svg>
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </Svg>
        </IconButton>
        <IconButton
          onClick={props.onToggleAlwaysOnTop}
          active={props.isAlwaysOnTop}
        >
          <Svg>
            <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.5" />
          </Svg>
        </IconButton>
        <IconButton
          onClick={() => window.api.send("window:toggle-compact")}
        >
          <Svg>
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </Svg>
        </IconButton>
        <IconButton
          onClick={() => window.api.send("window:minimize")}
        >
          <Svg>
            <line x1="5" y1="12" x2="19" y2="12" />
          </Svg>
        </IconButton>
        <IconButton
          onClick={() => window.api.send("window:close")}
          danger
        >
          ✕
        </IconButton>
      </div>
    </div>
  );
}
