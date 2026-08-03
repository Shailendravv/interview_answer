import type { ReactNode } from "react";

export interface ProjectCardData {
  id: string;
  title: string;
  description: string;
  tags: string[];
  role: string;
  duration: string;
  techStack: string[];
  architecture: string[];
  features: string[];
  challenges: string[];
  accomplishments: string[];
  notes: string;
}

export interface ProjectListPayload {
  introduction: {
    name: string;
    title: string;
    summary: string;
    skills: string[];
  };
  projects: ProjectCardData[];
}

interface ProjectsViewProps {
  payload: ProjectListPayload;
  activeProjectId: string | null;
  onUseProject: (id: string) => void;
  onEditProjects: () => void;
}

function Chip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-[11px] text-gray-200">
      {children}
    </span>
  );
}

function Section({ title, items }: { title: string; items: string[] }): JSX.Element | null {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300 mt-3 mb-1">
        {title}
      </h4>
      <ul className="list-disc list-inside space-y-1 text-xs text-gray-200">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectsView({
  payload,
  activeProjectId,
  onUseProject,
  onEditProjects,
}: ProjectsViewProps): JSX.Element {
  const { introduction, projects } = payload;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-1">
      {/* Introduction */}
      <div className="rounded-2xl bg-white/5 backdrop-blur-md border border-white/15 p-4 mb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-emerald-400">
              {introduction.name || "About Me"}
            </h2>
            <p className="text-xs text-gray-300">{introduction.title}</p>
          </div>
          <button
            onClick={onEditProjects}
            className="px-3 py-1 text-xs bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-lg transition-colors border border-white/15"
          >
            Edit Projects
          </button>
        </div>
        {introduction.summary && (
          <p className="text-xs text-gray-200 mt-2 leading-relaxed">
            {introduction.summary}
          </p>
        )}
        {introduction.skills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {introduction.skills.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
        )}
      </div>

      {/* Project cards */}
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <div
            key={p.id}
            className={`rounded-2xl bg-white/5 backdrop-blur-md border p-4 mb-3 ${
              isActive ? "border-emerald-500/50" : "border-white/15"
            }`}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h3 className="text-sm font-bold text-gray-100">{p.title}</h3>
                <p className="text-xs text-gray-400">{p.description}</p>
              </div>
              <button
                onClick={() => onUseProject(p.id)}
                className={`px-3 py-1 text-xs rounded-lg backdrop-blur-md transition-colors border ${
                  isActive
                    ? "bg-emerald-600/40 text-emerald-200 border-emerald-500/50"
                    : "bg-emerald-600/20 hover:bg-emerald-500/40 text-gray-100 border-white/15"
                }`}
              >
                {isActive ? "Active in assistant" : "Use in assistant"}
              </button>
            </div>

            <div className="flex flex-wrap gap-1 mt-2">
              {p.tags.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-2">
              {p.role && <span>Role: {p.role}</span>}
              {p.duration && <span>Duration: {p.duration}</span>}
            </div>

            {p.techStack.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {p.techStack.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
            )}

            <Section title="Architecture" items={p.architecture} />
            <Section title="Features" items={p.features} />
            <Section title="Challenges" items={p.challenges} />
            <Section title="Accomplishments" items={p.accomplishments} />
          </div>
        );
      })}

      {projects.length === 0 && (
        <p className="text-xs text-gray-500 text-center py-8">
          No projects yet. Edit projects.json to add them.
        </p>
      )}
    </div>
  );
}
