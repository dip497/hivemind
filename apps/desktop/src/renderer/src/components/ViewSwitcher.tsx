export type ViewKind = "board" | "list" | "canvas";

const VIEWS: { key: ViewKind; label: string; icon: React.ReactNode }[] = [
  {
    key: "board",
    label: "Board",
    icon: (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="2" width="3.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="5.5" y="2" width="3.5" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="10" y="2" width="3" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    key: "list",
    label: "List",
    icon: (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
        <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "canvas",
    label: "Canvas",
    icon: (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="5" cy="5.5" r="1.2" fill="currentColor" />
        <path d="M2 11l3-3 2 2 3-4 3 4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
];

export function ViewSwitcher({
  value,
  onChange,
}: {
  value: ViewKind;
  onChange: (v: ViewKind) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md">
      {VIEWS.map((v) => {
        const active = v.key === value;
        return (
          <button
            key={v.key}
            onClick={() => onChange(v.key)}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11.5px] font-medium transition-colors ${
              active
                ? "bg-[var(--color-bg4)] text-[var(--color-fg)]"
                : "text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
            }`}
          >
            {v.icon}
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
